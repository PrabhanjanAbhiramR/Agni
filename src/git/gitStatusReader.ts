import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const gitTimeoutMs = 10_000;
const statusArgs = ['status', '--porcelain=v2', '-z', '--untracked-files=all'] as const;
const branchArgs = ['branch', '--show-current'] as const;
const stagedDiffArgs = ['diff', '--cached', '--numstat', '-z'] as const;
const unstagedDiffArgs = ['diff', '--numstat', '-z'] as const;

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'unknown';
export type GitChangeStage = 'staged' | 'unstaged' | 'both';

export interface GitDiffStat {
	additions?: number;
	binary: boolean;
	deletions?: number;
}

export interface GitFileChange {
	path: string;
	stage: GitChangeStage;
	stagedDiff?: GitDiffStat;
	stagedStatus?: GitFileStatus;
	status: GitFileStatus;
	unstagedDiff?: GitDiffStat;
	unstagedStatus?: GitFileStatus;
}

export interface GitWorkspaceStatus {
	branch?: string;
	changes: GitFileChange[];
	error?: string;
	excludedChangeCount?: number;
	hasGit: boolean;
	workspaceName?: string;
}

export interface GitWorkspaceTarget {
	name: string;
	path: string;
}

interface GitResult {
	exitCode: number;
	stdout: string;
}

const excludedReportDirectoryNames = new Set([
	'.pytest_cache',
	'.venv',
	'__pycache__',
	'build',
	'dist',
	'env',
	'node_modules',
	'venv',
]);

/**
 * Returns whether a Git path is inside a generated, dependency, or virtual-
 * environment directory that Agni intentionally omits from its presentation.
 * This is a reporting-only filter and never changes Git or workspace files.
 */
export function isGitReportPathExcluded(filePath: string): boolean {
	const normalized = filePath.replaceAll('\\', '/');
	const segments = normalized.split('/').filter((segment) => segment.length > 0);
	const directorySegments = normalized.endsWith('/') ? segments : segments.slice(0, -1);
	return directorySegments.some((segment) => excludedReportDirectoryNames.has(segment.toLowerCase()));
}

function statusFromCode(code: string): GitFileStatus | undefined {
	switch (code) {
		case 'A': return 'added';
		case 'M': return 'modified';
		case 'D': return 'deleted';
		case 'R': return 'renamed';
		case 'C': return 'copied';
		case '?': return 'untracked';
		case '.': return undefined;
		default: return code ? 'unknown' : undefined;
	}
}

function changedEntry(path: string, xy: string): GitFileChange {
	const stagedStatus = statusFromCode(xy.charAt(0));
	const unstagedStatus = statusFromCode(xy.charAt(1));
	const stage: GitChangeStage = stagedStatus && unstagedStatus
		? 'both'
		: stagedStatus ? 'staged' : 'unstaged';
	return {
		path,
		stage,
		stagedStatus,
		status: unstagedStatus ?? stagedStatus ?? 'unknown',
		unstagedStatus,
	};
}

export function parsePorcelainV2(output: string): GitFileChange[] {
	const records = output.split('\0');
	const changes: GitFileChange[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) {
			continue;
		}
		if (record.startsWith('? ')) {
			changes.push({
				path: record.slice(2),
				stage: 'unstaged',
				status: 'untracked',
				unstagedStatus: 'untracked',
			});
			continue;
		}
		if (record.startsWith('1 ')) {
			const parts = record.split(' ');
			const path = parts.slice(8).join(' ');
			if (path) {
				changes.push(changedEntry(path, parts[1] ?? '..'));
			}
			continue;
		}
		if (record.startsWith('2 ')) {
			const parts = record.split(' ');
			const path = parts.slice(9).join(' ');
			if (path) {
				changes.push(changedEntry(path, parts[1] ?? '..'));
			}
			index += 1; // Porcelain v2 emits the original rename/copy path as the next NUL record.
			continue;
		}
		if (record.startsWith('u ')) {
			const parts = record.split(' ');
			const path = parts.slice(10).join(' ');
			if (path) {
				changes.push({
					path,
					stage: 'both',
					stagedStatus: 'modified',
					status: 'modified',
					unstagedStatus: 'modified',
				});
			}
		}
	}
	return changes;
}

export function parseNumstat(output: string): Map<string, GitDiffStat> {
	const records = output.split('\0');
	const stats = new Map<string, GitDiffStat>();
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record) {
			continue;
		}
		const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/u.exec(record);
		if (!match) {
			continue;
		}
		let filePath = match[3] ?? '';
		if (!filePath && records[index + 2]) {
			filePath = records[index + 2] ?? '';
			index += 2;
		}
		if (!filePath) {
			continue;
		}
		const binary = match[1] === '-' || match[2] === '-';
		stats.set(filePath, {
			additions: binary ? undefined : Number(match[1]),
			binary,
			deletions: binary ? undefined : Number(match[2]),
		});
	}
	return stats;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
	try {
		const result = await execFileAsync('git', [...args], {
			cwd,
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024,
			timeout: gitTimeoutMs,
			windowsHide: true,
		});
		return { exitCode: 0, stdout: String(result.stdout) };
	} catch (error: unknown) {
		const failure = error as NodeJS.ErrnoException & { stdout?: string | Buffer };
		if (failure.code === 'ENOENT') {
			throw Object.assign(new Error('Git executable not found.'), { gitMissing: true });
		}
		return {
			exitCode: typeof failure.code === 'number' ? failure.code : 1,
			stdout: failure.stdout ? String(failure.stdout) : '',
		};
	}
}

export async function readGitStatus(workspacePath: string): Promise<GitWorkspaceStatus> {
	let status: GitResult;
	try {
		status = await runGit(workspacePath, statusArgs);
	} catch (error: unknown) {
		return {
			changes: [],
			error: (error as { gitMissing?: boolean }).gitMissing
				? 'Git is not installed or not found in PATH.'
				: `Git status failed: ${error instanceof Error ? error.message : String(error)}`,
			hasGit: false,
		};
	}
	if (status.exitCode !== 0) {
		return {
			changes: [],
			error: status.exitCode === 128
				? 'The workspace folder is not a Git repository.'
				: `git status exited with code ${status.exitCode}.`,
			hasGit: false,
		};
	}
	const allChanges = parsePorcelainV2(status.stdout);
	const changes = allChanges.filter((change) => !isGitReportPathExcluded(change.path));
	const [branch, stagedDiff, unstagedDiff] = await Promise.all([
		runGit(workspacePath, branchArgs),
		runGit(workspacePath, stagedDiffArgs),
		runGit(workspacePath, unstagedDiffArgs),
	]);
	const stagedStats = stagedDiff.exitCode === 0 ? parseNumstat(stagedDiff.stdout) : new Map<string, GitDiffStat>();
	const unstagedStats = unstagedDiff.exitCode === 0 ? parseNumstat(unstagedDiff.stdout) : new Map<string, GitDiffStat>();
	for (const change of changes) {
		change.stagedDiff = stagedStats.get(change.path);
		change.unstagedDiff = unstagedStats.get(change.path);
	}
	return {
		branch: branch.exitCode === 0 ? branch.stdout.trim() || undefined : undefined,
		changes,
		excludedChangeCount: allChanges.length - changes.length,
		hasGit: true,
	};
}

export async function readGitStatuses(
	workspaces: readonly GitWorkspaceTarget[],
	reader: (workspacePath: string) => Promise<GitWorkspaceStatus> = readGitStatus,
): Promise<GitWorkspaceStatus[]> {
	return Promise.all(workspaces.map(async (workspace) => ({
		...await reader(workspace.path),
		workspaceName: workspace.name,
	})));
}

export function gitChangeSummary(change: GitFileChange, stage: 'staged' | 'unstaged'): string {
	const status = stage === 'staged' ? change.stagedStatus : change.unstagedStatus;
	const diff = stage === 'staged' ? change.stagedDiff : change.unstagedDiff;
	if (status === 'untracked') {
		return 'untracked file';
	}
	if (diff?.binary) {
		return 'binary content changed';
	}
	if (diff && diff.additions !== undefined && diff.deletions !== undefined) {
		return `+${diff.additions}/-${diff.deletions} lines`;
	}
	return status ? `${status} file` : 'changed file';
}
