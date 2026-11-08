import * as vscode from 'vscode';
import {
	multiFileDiffScheme,
	parseMultiFileDiffUri,
} from './multiFileDiff.js';
import { hunkLineNumber, type MultiFileHunk } from './multiFileHunks.js';
import { MultiFileProposalStore } from './multiFileProposal.js';

export const acceptMultiFileHunkCommandId = 'agni.multiFileEdit.acceptHunk';
export const rejectMultiFileHunkCommandId = 'agni.multiFileEdit.rejectHunk';

export interface MultiFileHunkCommandTarget {
	changeKey: string;
	hunkId: string;
	transactionId: string;
}

function materializedHunkLines(
	content: string,
	hunks: readonly MultiFileHunk[],
): Map<string, number> {
	const lines = new Map<string, number>();
	let materializedOffsetDelta = 0;
	for (const hunk of [...hunks].sort((left, right) => left.originalStart - right.originalStart)) {
		const offset = Math.max(0, Math.min(
			content.length,
			hunk.originalStart + materializedOffsetDelta,
		));
		lines.set(hunk.id, hunkLineNumber(content, offset) - 1);
		const visibleText = hunk.decision === 'rejected'
			? hunk.originalText
			: hunk.replacementText;
		materializedOffsetDelta += visibleText.length - hunk.originalText.length;
	}
	return lines;
}

export function isMultiFileHunkCommandTarget(value: unknown): value is MultiFileHunkCommandTarget {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<MultiFileHunkCommandTarget>;
	return typeof candidate.changeKey === 'string'
		&& typeof candidate.hunkId === 'string'
		&& typeof candidate.transactionId === 'string';
}

export class MultiFileEditCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private readonly storeSubscription: vscode.Disposable;
	private disposed = false;
	readonly onDidChangeCodeLenses = this.changeEmitter.event;

	constructor(private readonly store: MultiFileProposalStore) {
		this.storeSubscription = store.onDidChange(() => this.refresh());
	}

	provideCodeLenses(
		document: vscode.TextDocument,
		cancellationToken: vscode.CancellationToken,
	): vscode.CodeLens[] {
		if (this.disposed || cancellationToken.isCancellationRequested) {
			return [];
		}
		const reference = parseMultiFileDiffUri(document.uri);
		if (!reference || reference.side !== 'after') {
			return [];
		}
		const transaction = this.store.get(reference.transactionId);
		if (!transaction || transaction.status !== 'review') {
			return [];
		}
		const change = transaction.changes.get(reference.changeKey);
		if (!change) {
			return [];
		}

		const reviewContent = this.store.materializeReviewContent(change);
		const hunkLines = materializedHunkLines(reviewContent, change.hunks);
		return change.hunks.flatMap((hunk) => {
			const line = hunkLines.get(hunk.id);
			if (line === undefined) {
				return [];
			}
			const position = new vscode.Position(line, 0);
			const range = new vscode.Range(position, position);
			const target: MultiFileHunkCommandTarget = Object.freeze({
				changeKey: reference.changeKey,
				hunkId: hunk.id,
				transactionId: reference.transactionId,
			});
			return [
				new vscode.CodeLens(range, {
					arguments: [target],
					command: acceptMultiFileHunkCommandId,
					title: 'Accept Hunk',
					tooltip: `Accept this ${hunk.decision} Agni hunk`,
				}),
				new vscode.CodeLens(range, {
					arguments: [target],
					command: rejectMultiFileHunkCommandId,
					title: 'Reject Hunk',
					tooltip: `Reject this ${hunk.decision} Agni hunk`,
				}),
			];
		});
	}

	refresh(): void {
		if (!this.disposed) {
			this.changeEmitter.fire();
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.storeSubscription.dispose();
		this.changeEmitter.dispose();
	}
}

export function registerMultiFileEditCodeLensProvider(
	context: vscode.ExtensionContext,
	provider: MultiFileEditCodeLensProvider,
): void {
	context.subscriptions.push(
		provider,
		vscode.languages.registerCodeLensProvider({ scheme: multiFileDiffScheme }, provider),
	);
}
