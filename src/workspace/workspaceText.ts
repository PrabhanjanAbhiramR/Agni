import * as vscode from 'vscode';
import { type ResolvedWorkspacePath, WorkspaceBoundary } from './workspaceBoundary.js';

export interface WorkspaceTextFile {
	byteLength: number;
	fromOpenDocument: boolean;
	text: string;
}

export class WorkspaceTextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkspaceTextError';
	}
}

function decodeUtf8(bytes: Uint8Array): string {
	if (bytes.includes(0)) {
		throw new WorkspaceTextError('Binary files cannot be read as text.');
	}

	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw new WorkspaceTextError('The file is not valid UTF-8 text.');
	}
}

export async function readWorkspaceText(
	boundary: WorkspaceBoundary,
	path: ResolvedWorkspacePath,
	maxBytes: number,
): Promise<WorkspaceTextFile> {
	await boundary.assertNoSymbolicLinks(path);

	const openText = boundary.adapter.getOpenDocumentText(path.uri);
	if (openText !== undefined) {
		const byteLength = new TextEncoder().encode(openText).byteLength;
		if (byteLength > maxBytes) {
			throw new WorkspaceTextError(`Open editor content exceeds the ${maxBytes}-byte limit.`);
		}

		return { byteLength, fromOpenDocument: true, text: openText };
	}

	const stat = await boundary.adapter.stat(path.uri);
	if ((stat.type & vscode.FileType.File) === 0) {
		throw new WorkspaceTextError('The requested path is not a file.');
	}

	if (stat.size > maxBytes) {
		throw new WorkspaceTextError(`File exceeds the ${maxBytes}-byte limit.`);
	}

	const bytes = await boundary.adapter.readFile(path.uri);
	if (bytes.byteLength > maxBytes) {
		throw new WorkspaceTextError(`File exceeds the ${maxBytes}-byte limit.`);
	}

	return {
		byteLength: bytes.byteLength,
		fromOpenDocument: false,
		text: decodeUtf8(bytes),
	};
}
