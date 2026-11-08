import * as vscode from 'vscode';
import { type InlineEditTarget, InlineEditProposalError } from './inlineEditProposal.js';
import { type ResolvedWorkspacePath, WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

function resolveDocumentPath(boundary: WorkspaceBoundary, uri: vscode.Uri): ResolvedWorkspacePath {
	for (const root of boundary.listRoots()) {
		try {
			const relativePath = boundary.relativePath(root, uri);
			return boundary.resolve(root.id, relativePath);
		} catch {
			// Continue until a workspace root contains the document URI.
		}
	}

	throw new InlineEditProposalError('The selected document is outside the open VS Code workspace.');
}

export async function captureInlineEditTarget(
	editor: vscode.TextEditor,
	instruction: string,
	boundary = new WorkspaceBoundary(),
): Promise<InlineEditTarget> {
	if (editor.selection.isEmpty) {
		throw new InlineEditProposalError('Select non-empty code before running Agni: Inline Edit.');
	}

	const document = editor.document;
	const range = new vscode.Range(editor.selection.start, editor.selection.end);
	if (!document.validateRange(range).isEqual(range)) {
		throw new InlineEditProposalError('The selected range is outside the current document.');
	}

	const path = resolveDocumentPath(boundary, document.uri);
	await boundary.assertNoSymbolicLinks(path);
	const stat = await boundary.adapter.stat(path.uri);
	if ((stat.type & vscode.FileType.File) === 0) {
		throw new InlineEditProposalError('The selected editor does not contain a workspace file.');
	}

	const originalText = document.getText(range);
	if (originalText.length === 0) {
		throw new InlineEditProposalError('Select non-empty code before running Agni: Inline Edit.');
	}

	return {
		documentText: document.getText(),
		endOffset: document.offsetAt(range.end),
		filePath: path.relativePath,
		instruction,
		languageId: document.languageId,
		originalText,
		range,
		root: path.root.id,
		startOffset: document.offsetAt(range.start),
		uri: document.uri,
		version: document.version,
	};
}
