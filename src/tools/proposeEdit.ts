import {
	maxMultiFileBytes,
	MultiFileProposalStore,
} from '../multiFileEdit/multiFileProposal.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { type AgniToolResult, errorToolResult } from './toolResult.js';
import { captureMultiFileSnapshot } from './proposeWrite.js';

export interface ProposedTextEdit {
	new_str: string;
	old_str: string;
}

export interface ProposeEditInput {
	edits: ProposedTextEdit[];
	path: string;
	root?: string;
}

export function applyProposedTextEdits(
	content: string,
	edits: readonly ProposedTextEdit[],
): string {
	if (edits.length === 0) {
		throw new Error('At least one exact text edit is required.');
	}

	let result = content;
	for (const [index, edit] of edits.entries()) {
		if (typeof edit.old_str !== 'string' || edit.old_str.length === 0) {
			throw new Error(`Edit ${index + 1} old_str must be a non-empty string.`);
		}
		if (typeof edit.new_str !== 'string') {
			throw new Error(`Edit ${index + 1} new_str must be a string.`);
		}

		const firstMatch = result.indexOf(edit.old_str);
		if (firstMatch < 0) {
			throw new Error(
				`Edit ${index + 1} old_str did not match the current file exactly. Read the relevant range and retry with exact text.`,
			);
		}
		if (result.indexOf(edit.old_str, firstMatch + 1) >= 0) {
			throw new Error(
				`Edit ${index + 1} old_str matched more than once. Read a larger range and retry with uniquely identifying text.`,
			);
		}

		result = result.slice(0, firstMatch) + edit.new_str
			+ result.slice(firstMatch + edit.old_str.length);
		if (Buffer.byteLength(result, 'utf8') > maxMultiFileBytes) {
			throw new Error(`Edited file exceeds the ${maxMultiFileBytes}-byte per-file limit.`);
		}
	}
	return result;
}

export class ProposeEditTool {
	constructor(
		private readonly proposals: MultiFileProposalStore,
		private readonly boundary = new WorkspaceBoundary(),
	) {}

	async run(input: ProposeEditInput): Promise<AgniToolResult> {
		try {
			if (!Array.isArray(input.edits)) {
				throw new Error('edits must be an array of exact text replacements.');
			}
			const resolved = this.boundary.resolve(input.root, input.path);
			if (!resolved.relativePath) {
				throw new Error('A workspace-relative file path is required.');
			}
			this.proposals.assertActivePathAllowed(resolved.root.id, resolved.relativePath);
			const snapshot = await captureMultiFileSnapshot(
				this.boundary,
				resolved.root.id,
				resolved.relativePath,
			);
			if (!snapshot.exists) {
				throw new Error('propose_edit requires an existing file. Use propose_write to create a new file.');
			}

			const proposedContent = applyProposedTextEdits(snapshot.content, input.edits);
			const change = this.proposals.propose(snapshot, proposedContent);
			return {
				content: [{
					type: 'text',
					text: `Recorded edited proposal for ${snapshot.root}/${snapshot.path}. No workspace file was modified.`,
				}],
				structuredContent: {
					created: false,
					path: snapshot.path,
					proposedByteLength: Buffer.byteLength(change.proposedContent, 'utf8'),
					root: snapshot.root,
				},
			};
		} catch (error: unknown) {
			return errorToolResult(error);
		}
	}
}
