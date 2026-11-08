import { type AgniToolResult, clampLimit, errorToolResult } from './toolResult.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import {
	maxWorkspaceSearchFileBytes,
	WorkspaceTextSearch,
} from '../workspace/workspaceSearch.js';

export const maxSearchResults = 200;
export const maxSearchFileBytes = maxWorkspaceSearchFileBytes;

export interface SearchCodeInput {
	caseSensitive?: boolean;
	include?: string;
	maxResults?: number;
	query: string;
	root?: string;
}

export class SearchCodeTool {
	constructor(private readonly boundary = new WorkspaceBoundary()) {}

	async run(input: SearchCodeInput): Promise<AgniToolResult> {
		try {
			if (!input.query) {
				throw new Error('A non-empty search query is required.');
			}

			const limit = clampLimit(input.maxResults, 50, maxSearchResults);
			const root = this.boundary.resolveRoot(input.root);
			const search = await new WorkspaceTextSearch(this.boundary).search({
				caseSensitive: input.caseSensitive,
				include: input.include,
				maxMatches: limit + 1,
				root: root.id,
				terms: [input.query],
			});
			const truncated = search.matches.length > limit || search.truncated;
			const selected = search.matches.slice(0, limit);
			const rendered = selected.map((match) =>
				`${match.path}:${match.line}:${match.column}: ${match.preview}`,
			);

			return {
				content: [{
					type: 'text',
					text: rendered.length === 0
						? `No matches found for "${input.query}".`
						: `${rendered.join('\n')}${truncated ? '\n… results truncated' : ''}`,
				}],
				structuredContent: {
					matches: selected,
					query: input.query,
					root: root.id,
					skippedFiles: search.skippedFiles,
					truncated,
				},
			};
		} catch (error: unknown) {
			return errorToolResult(error);
		}
	}
}
