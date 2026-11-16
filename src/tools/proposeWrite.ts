import * as vscode from 'vscode';
import {
	contentHash,
	maxMultiFileBytes,
	MultiFileProposalStore,
	type MultiFileSnapshot,
} from '../multiFileEdit/multiFileProposal.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { readWorkspaceText } from '../workspace/workspaceText.js';
import { type AgniToolResult, errorToolResult } from './toolResult.js';
import { normalizeGeneratedSourceContent } from './generatedSourceContent.js';

export interface ProposeWriteInput {
	content: string;
	path: string;
	root?: string;
}

function isMissingPath(error: unknown): boolean {
	if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return /(?:file\s*not\s*found|enoent|missing (?:test )?(?:file|path))/iu.test(message);
}

export async function captureMultiFileSnapshot(
	boundary: WorkspaceBoundary,
	root: string | undefined,
	path: string,
): Promise<MultiFileSnapshot> {
	const resolved = boundary.resolve(root, path);
	if (!resolved.relativePath) {
		throw new Error('A workspace-relative file path is required.');
	}

	try {
		const file = await readWorkspaceText(boundary, resolved, maxMultiFileBytes);
		return {
			content: file.text,
			exists: true,
			hash: contentHash(file.text),
			path: resolved.relativePath,
			root: resolved.root.id,
			uri: resolved.uri,
		};
	} catch (error: unknown) {
		if (!isMissingPath(error)) {
			throw error;
		}
	}

	const segments = resolved.relativePath.split('/');
	segments.pop();
	const parent = boundary.resolve(resolved.root.id, segments.join('/'));
	if (parent.relativePath) {
		await boundary.assertNoSymbolicLinks(parent);
	}
	const parentStat = await boundary.adapter.stat(parent.uri);
	if ((parentStat.type & vscode.FileType.Directory) === 0) {
		throw new Error('The proposed file parent path is not a directory.');
	}

	return {
		content: '',
		exists: false,
		hash: contentHash(''),
		path: resolved.relativePath,
		root: resolved.root.id,
		uri: resolved.uri,
	};
}

export class ProposeWriteTool {
	constructor(
		private readonly proposals: MultiFileProposalStore,
		private readonly boundary = new WorkspaceBoundary(),
	) {}

	async run(input: ProposeWriteInput): Promise<AgniToolResult> {
		try {
			if (typeof input.content !== 'string') {
				throw new Error('Proposed content must be a string.');
			}
			const resolved = this.boundary.resolve(input.root, input.path);
			if (!resolved.relativePath) {
				throw new Error('A workspace-relative file path is required.');
			}
			this.proposals.assertActivePathAllowed(resolved.root.id, resolved.relativePath);
			const normalized = normalizeGeneratedSourceContent(resolved.relativePath, input.content);
			const snapshot = await captureMultiFileSnapshot(
				this.boundary,
				resolved.root.id,
				resolved.relativePath,
			);
			const change = this.proposals.propose(snapshot, normalized.content);
			return {
				content: [{
					type: 'text',
					text: `Recorded proposal for ${snapshot.root}/${snapshot.path}. No workspace file was modified.`
						+ (normalized.normalizedPythonTripleQuotes
							? ' Normalized transport-escaped Python triple-quote delimiters.'
							: ''),
				}],
				structuredContent: {
					created: !snapshot.exists,
					normalizedPythonTripleQuotes: normalized.normalizedPythonTripleQuotes,
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
