import * as vscode from 'vscode';
import { WorkspaceBoundary } from './workspaceBoundary.js';
import { readWorkspaceText } from './workspaceText.js';

export const workspaceSearchExcludeGlob = '**/{.git,.hg,.svn,.vscode-test,node_modules,bower_components,vendor,dist,build,out,coverage,.next,.nuxt,.svelte-kit,.turbo,target,bin,obj,__pycache__,.venv,venv,.mypy_cache,.pytest_cache}/**';
export const maxWorkspaceSearchFiles = 1_000;
export const maxWorkspaceSearchFileBytes = 1024 * 1024;

const excludedFileNames = new Set([
	'composer.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'poetry.lock',
	'yarn.lock',
]);
const excludedDirectoryNames = new Set([
	'.git', '.hg', '.mypy_cache', '.next', '.nuxt', '.pytest_cache', '.svelte-kit', '.svn', '.turbo',
	'.venv', '.vscode-test', '__pycache__', 'bin', 'bower_components', 'build', 'coverage', 'dist',
	'node_modules', 'obj', 'out', 'target', 'vendor', 'venv',
]);
const excludedExtensions = new Set([
	'.7z', '.a', '.avi', '.bin', '.bmp', '.class', '.dll', '.dylib', '.eot', '.exe', '.gif', '.gz',
	'.ico', '.jar', '.jpeg', '.jpg', '.lock', '.map', '.mov', '.mp3', '.mp4', '.o', '.obj', '.otf',
	'.pdf', '.png', '.pyc', '.pyo', '.so', '.tar', '.tif', '.tiff', '.ttf', '.wav', '.webm', '.webp',
	'.woff', '.woff2', '.zip',
]);
const generatedContentPattern = /(?:@generated|automatically generated|generated file|do not edit)/iu;

export interface WorkspaceSearchMatch {
	column: number;
	line: number;
	path: string;
	preview: string;
	root: string;
	term: string;
}

export interface WorkspaceSearchFile {
	matches: WorkspaceSearchMatch[];
	path: string;
	root: string;
	text: string;
}

export interface WorkspaceSearchResult {
	candidateLimitReached: boolean;
	files: WorkspaceSearchFile[];
	matches: WorkspaceSearchMatch[];
	skippedFiles: number;
	truncated: boolean;
}

export interface WorkspaceSearchOptions {
	caseSensitive?: boolean;
	include?: string;
	maxMatches: number;
	root?: string;
	skipGeneratedContent?: boolean;
	terms: readonly string[];
}

function extensionOf(path: string): string {
	const fileName = path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase();
	if (fileName.endsWith('.min.js')) {
		return '.min.js';
	}
	const dot = fileName.lastIndexOf('.');
	return dot >= 0 ? fileName.slice(dot) : '';
}

export function isWorkspaceSearchPathIncluded(path: string): boolean {
	const normalized = path.replace(/\\/g, '/').toLocaleLowerCase();
	const segments = normalized.split('/');
	if (segments.slice(0, -1).some((segment) => excludedDirectoryNames.has(segment))) {
		return false;
	}
	const fileName = normalized.slice(normalized.lastIndexOf('/') + 1);
	if (excludedFileNames.has(fileName) || fileName.endsWith('.min.js') || fileName.endsWith('.min.css')) {
		return false;
	}
	return !excludedExtensions.has(extensionOf(normalized));
}

export function looksGenerated(text: string): boolean {
	return generatedContentPattern.test(text.split(/\r?\n/u).slice(0, 8).join('\n'));
}

export class WorkspaceTextSearch {
	constructor(private readonly boundary = new WorkspaceBoundary()) {}

	async search(options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult> {
		if (options.terms.length === 0 || options.terms.some((term) => term.length === 0)) {
			throw new Error('Workspace search terms must be non-empty.');
		}
		if (!Number.isInteger(options.maxMatches) || options.maxMatches < 1) {
			throw new Error('Workspace search maxMatches must be a positive integer.');
		}

		const roots = options.root
			? [this.boundary.resolveRoot(options.root)]
			: this.boundary.listRoots();
		if (roots.length === 0) {
			this.boundary.resolveRoot();
		}

		const matches: WorkspaceSearchMatch[] = [];
		const files: WorkspaceSearchFile[] = [];
		let candidateLimitReached = false;
		let skippedFiles = 0;
		let truncated = false;
		const normalizedTerms = options.terms.map((term) => options.caseSensitive ? term : term.toLocaleLowerCase());

		for (const root of roots) {
			const includeGlob = this.boundary.normalizeGlob(options.include ?? '**/*');
			const include = new vscode.RelativePattern(root.uri, includeGlob);
			const exclude = new vscode.RelativePattern(root.uri, workspaceSearchExcludeGlob);
			const discovered = await this.boundary.adapter.findFiles(
				include,
				exclude,
				maxWorkspaceSearchFiles + 1,
			);
			candidateLimitReached ||= discovered.length > maxWorkspaceSearchFiles;
			const paths = discovered
				.slice(0, maxWorkspaceSearchFiles)
				.map((uri) => ({ path: this.boundary.relativePath(root, uri), uri }))
				.filter((entry) => isWorkspaceSearchPathIncluded(entry.path))
				.sort((left, right) => left.path.localeCompare(right.path));

			for (const entry of paths) {
				const resolved = this.boundary.resolve(root.id, entry.path);
				let text: string;
				try {
					text = (await readWorkspaceText(this.boundary, resolved, maxWorkspaceSearchFileBytes)).text;
					if (options.skipGeneratedContent && looksGenerated(text)) {
						skippedFiles += 1;
						continue;
					}
				} catch {
					skippedFiles += 1;
					continue;
				}

				const fileMatches: WorkspaceSearchMatch[] = [];
				for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
					const haystack = options.caseSensitive ? line : line.toLocaleLowerCase();
					for (const [termIndex, needle] of normalizedTerms.entries()) {
						let fromIndex = 0;
						while (fromIndex <= haystack.length) {
							const columnIndex = haystack.indexOf(needle, fromIndex);
							if (columnIndex < 0) {
								break;
							}

							const match: WorkspaceSearchMatch = {
								column: columnIndex + 1,
								line: lineIndex + 1,
								path: entry.path,
								preview: line.slice(0, 500),
								root: root.id,
								term: options.terms[termIndex],
							};
							fileMatches.push(match);
							matches.push(match);
							if (matches.length >= options.maxMatches) {
								truncated = true;
								break;
							}
							fromIndex = columnIndex + Math.max(needle.length, 1);
						}
						if (truncated) {
							break;
						}
					}
					if (truncated) {
						break;
					}
				}

				if (fileMatches.length > 0) {
					files.push({ matches: fileMatches, path: entry.path, root: root.id, text });
				}
				if (truncated) {
					break;
				}
			}
			if (truncated) {
				break;
			}
		}

		return {
			candidateLimitReached,
			files,
			matches,
			skippedFiles,
			truncated: truncated || candidateLimitReached,
		};
	}
}
