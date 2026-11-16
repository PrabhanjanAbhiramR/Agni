import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeGitRisks } from '../git/gitRiskAnalyzer.js';
import { writeGitStatus } from '../git/gitStatusPresenter.js';
import {
	gitChangeSummary,
	readGitStatus,
	readGitStatuses,
	type GitWorkspaceStatus,
} from '../git/gitStatusReader.js';

function git(repository: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd: repository,
		encoding: 'utf8',
		windowsHide: true,
	});
}

function createRepository(): string {
	const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'agni-git-'));
	git(repository, 'init', '--quiet');
	git(repository, 'config', 'user.email', 'agni-tests@example.invalid');
	git(repository, 'config', 'user.name', 'Agni Tests');
	fs.writeFileSync(path.join(repository, 'tracked.txt'), 'initial\n', 'utf8');
	fs.writeFileSync(path.join(repository, 'delete-me.txt'), 'remove me\n', 'utf8');
	git(repository, 'add', 'tracked.txt', 'delete-me.txt');
	git(repository, 'commit', '--quiet', '-m', 'fixture');
	return repository;
}

function removeTemporaryDirectory(directory: string): void {
	try {
		fs.rmSync(directory, { force: true, recursive: true });
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) {
			throw error;
		}
		// VS Code or antivirus scanning can briefly retain a handle to a temporary
		// .git directory. The fixture is under the OS temp root and can be reclaimed
		// by normal temp cleanup; never fail functional assertions for that host lock.
	}
}

function outputChannel(lines: string[]): vscode.OutputChannel {
	return {
		appendLine: (value: string) => { lines.push(value); },
		show: () => undefined,
	} as unknown as vscode.OutputChannel;
}

suite('Agni Git-aware Assistant', () => {
	test('reports a clean repository without depending on a branch name', async () => {
		const repository = createRepository();
		try {
			const status = await readGitStatus(repository);
			assert.strictEqual(status.hasGit, true);
			assert.deepStrictEqual(status.changes, []);
			assert.ok(status.branch === undefined || status.branch.length > 0);
		} finally {
			removeTemporaryDirectory(repository);
		}
	});

	test('distinguishes staged, unstaged, deleted, and untracked files with summaries', async () => {
		const repository = createRepository();
		try {
			fs.writeFileSync(path.join(repository, 'tracked.txt'), 'staged line\n', 'utf8');
			git(repository, 'add', 'tracked.txt');
			fs.appendFileSync(path.join(repository, 'tracked.txt'), 'unstaged line\n', 'utf8');
			fs.rmSync(path.join(repository, 'delete-me.txt'));
			fs.writeFileSync(path.join(repository, 'untracked.txt'), 'new\n', 'utf8');

			const status = await readGitStatus(repository);
			const tracked = status.changes.find((change) => change.path === 'tracked.txt');
			const deleted = status.changes.find((change) => change.path === 'delete-me.txt');
			const untracked = status.changes.find((change) => change.path === 'untracked.txt');
			assert.strictEqual(tracked?.stage, 'both');
			assert.match(gitChangeSummary(tracked!, 'staged'), /^\+\d+\/-\d+ lines$/u);
			assert.match(gitChangeSummary(tracked!, 'unstaged'), /^\+\d+\/-\d+ lines$/u);
			assert.strictEqual(deleted?.unstagedStatus, 'deleted');
			assert.match(gitChangeSummary(deleted!, 'unstaged'), /^\+0\/-\d+ lines$/u);
			assert.strictEqual(untracked?.unstagedStatus, 'untracked');
			assert.strictEqual(gitChangeSummary(untracked!, 'unstaged'), 'untracked file');
		} finally {
			removeTemporaryDirectory(repository);
		}
	});

	test('omits virtual environments and generated dependency directories from Git reports', async () => {
		const repository = createRepository();
		try {
			const ignoredFiles = [
				'.venv/Lib/site-packages/pygments/token.py',
				'venv/Scripts/activate.py',
				'env/lib/module.py',
				'node_modules/example/index.js',
				'__pycache__/module.pyc',
				'.pytest_cache/state.json',
				'dist/bundle.js',
				'build/generated.js',
			];
			for (const filePath of ignoredFiles) {
				const absolutePath = path.join(repository, ...filePath.split('/'));
				fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
				fs.writeFileSync(absolutePath, 'generated\n', 'utf8');
			}
			fs.mkdirSync(path.join(repository, 'src'), { recursive: true });
			fs.writeFileSync(path.join(repository, 'src', 'visible.py'), 'print("visible")\n', 'utf8');

			const status = await readGitStatus(repository);

			assert.deepStrictEqual(status.changes.map((change) => change.path), ['src/visible.py']);
			assert.strictEqual(status.excludedChangeCount, ignoredFiles.length);
			assert.deepStrictEqual(analyzeGitRisks(status.changes), []);
		} finally {
			removeTemporaryDirectory(repository);
		}
	});

	test('reports a directory without Git without throwing', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agni-no-git-'));
		try {
			const status = await readGitStatus(directory);
			assert.strictEqual(status.hasGit, false);
			assert.match(status.error ?? '', /not a Git repository/iu);
		} finally {
			removeTemporaryDirectory(directory);
		}
	});

	test('inspects every workspace target instead of selecting only the first', async () => {
		const inspected: string[] = [];
		const statuses = await readGitStatuses([
			{ name: 'frontend', path: 'C:\\work\\frontend' },
			{ name: 'backend', path: 'C:\\work\\backend' },
		], async (workspacePath): Promise<GitWorkspaceStatus> => {
			inspected.push(workspacePath);
			return { branch: 'branch', changes: [], hasGit: true };
		});
		assert.deepStrictEqual(inspected, ['C:\\work\\frontend', 'C:\\work\\backend']);
		assert.deepStrictEqual(statuses.map((status) => status.workspaceName), ['frontend', 'backend']);
	});

	test('labels deterministic indicators as unverified filename or change-type findings', () => {
		const findings = analyzeGitRisks([
			{ path: '.env', stage: 'unstaged', status: 'modified', unstagedStatus: 'modified' },
			{ path: 'src/old.ts', stage: 'unstaged', status: 'deleted', unstagedStatus: 'deleted' },
		]);
		assert.deepStrictEqual(findings.map((finding) => finding.source), ['filename-pattern', 'change-type']);
		assert.ok(findings.every((finding) => finding.verifiedSecurityIssue === false));
	});

	test('does not classify source files named token as credentials', () => {
		const findings = analyzeGitRisks([
			{ path: 'pygments/token.py', stage: 'unstaged', status: 'untracked', unstagedStatus: 'untracked' },
			{ path: 'src/token.ts', stage: 'unstaged', status: 'modified', unstagedStatus: 'modified' },
			{ path: 'lib/token.js', stage: 'staged', stagedStatus: 'added', status: 'added' },
		]);
		assert.deepStrictEqual(findings, []);
	});

	test('retains precise heuristic indicators for credential files and private keys', () => {
		const paths = [
			'.env',
			'config/credentials.json',
			'config/secrets.yaml',
			'keys/id_ed25519',
			'keys/service.pem',
		];
		const findings = analyzeGitRisks(paths.map((filePath) => ({
			path: filePath,
			stage: 'unstaged' as const,
			status: 'untracked' as const,
			unstagedStatus: 'untracked' as const,
		})));
		assert.deepStrictEqual(findings.map((finding) => finding.path), paths);
		assert.ok(findings.every((finding) => finding.level === 'critical'));
		assert.ok(findings.every((finding) => finding.verifiedSecurityIssue === false));
	});

	test('filters generated paths from direct presentation and risk analysis', () => {
		const lines: string[] = [];
		const generated = {
			path: '.venv/Lib/site-packages/pygments/token.py',
			stage: 'unstaged' as const,
			status: 'untracked' as const,
			unstagedStatus: 'untracked' as const,
		};
		writeGitStatus({
			branch: 'any-branch',
			changes: [generated],
			hasGit: true,
		}, outputChannel(lines));
		const rendered = lines.join('\n');
		assert.doesNotMatch(rendered, /pygments|token\.py|CRITICAL/gu);
		assert.match(rendered, /1 generated\/dependency path\(s\) omitted/gu);
		assert.deepStrictEqual(analyzeGitRisks([generated]), []);
	});

	test('presents staged and unstaged summaries and the risk disclaimer', () => {
		const lines: string[] = [];
		writeGitStatus({
			branch: 'any-branch',
			changes: [{
				path: '.env',
				stage: 'both',
				stagedDiff: { additions: 1, binary: false, deletions: 0 },
				stagedStatus: 'modified',
				status: 'modified',
				unstagedDiff: { additions: 2, binary: false, deletions: 1 },
				unstagedStatus: 'modified',
			}],
			hasGit: true,
			workspaceName: 'project',
		}, outputChannel(lines));
		const rendered = lines.join('\n');
		assert.match(rendered, /Staged changes/iu);
		assert.match(rendered, /Unstaged \/ untracked changes/iu);
		assert.match(rendered, /\+1\/-0 lines/iu);
		assert.match(rendered, /\+2\/-1 lines/iu);
		assert.match(rendered, /not verified security issues/iu);
	});
});
