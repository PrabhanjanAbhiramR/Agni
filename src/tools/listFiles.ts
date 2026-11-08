import * as vscode from 'vscode';
import { type AgniToolResult, clampLimit, errorToolResult } from './toolResult.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

export const maxListedFiles = 500;

export interface ListFilesInput {
	glob?: string;
	maxResults?: number;
	path?: string;
	root?: string;
}

export class ListFilesTool {
	constructor(private readonly boundary = new WorkspaceBoundary()) {}

	async run(input: ListFilesInput): Promise<AgniToolResult> {
		try {
			const limit = clampLimit(input.maxResults, 200, maxListedFiles);
			const base = this.boundary.resolve(input.root, input.path ?? '');
			if (base.relativePath) {
				await this.boundary.assertNoSymbolicLinks(base);
				const stat = await this.boundary.adapter.stat(base.uri);
				if ((stat.type & vscode.FileType.Directory) === 0) {
					throw new Error('The list_files path must be a directory.');
				}
			}

			const glob = this.boundary.normalizeGlob(input.glob ?? '**/*');
			const pattern = [base.relativePath, glob].filter(Boolean).join('/');
			const include = new vscode.RelativePattern(base.root.uri, pattern);
			const exclude = new vscode.RelativePattern(base.root.uri, '**/{.git,node_modules}/**');
			const uris = await this.boundary.adapter.findFiles(include, exclude, limit + 1);
			const files = uris
				.map((uri) => this.boundary.relativePath(base.root, uri))
				.sort((left, right) => left.localeCompare(right));
			const truncated = files.length > limit;
			const selected = files.slice(0, limit);

			return {
				content: [{
					type: 'text',
					text: selected.length === 0
						? `No files found in ${base.root.id}.`
						: `${selected.join('\n')}${truncated ? '\n… results truncated' : ''}`,
				}],
				structuredContent: {
					files: selected,
					root: base.root.id,
					truncated,
				},
			};
		} catch (error: unknown) {
			return errorToolResult(error);
		}
	}
}
