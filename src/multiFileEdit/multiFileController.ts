import * as vscode from 'vscode';
import {
	type AppliedMultiFileChange,
	contentHash,
	type MultiFileChange,
	MultiFileProposalError,
	MultiFileProposalStore,
	MultiFileStaleError,
	type MultiFileTransaction,
} from './multiFileProposal.js';
import { captureMultiFileSnapshot } from '../tools/proposeWrite.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

function normalizeEolForComparison(content: string): string {
	return content.replace(/\r\n|\r/gu, '\n');
}

export interface MultiFileWorkspace {
	applyProposal(changes: readonly AppliedMultiFileChange[]): Promise<boolean>;
	applyRollback(changes: readonly AppliedMultiFileChange[]): Promise<boolean>;
	readCurrent(change: Pick<AppliedMultiFileChange, 'snapshot'>): Promise<{ content: string; exists: boolean; hash: string }>;
}

export interface MultiFileDiffViewer {
	showReview(transaction: MultiFileTransaction): Promise<void>;
}

export class VsCodeMultiFileWorkspace implements MultiFileWorkspace {
	constructor(private readonly boundary = new WorkspaceBoundary()) {}

	async readCurrent(change: Pick<AppliedMultiFileChange, 'snapshot'>): Promise<{ content: string; exists: boolean; hash: string }> {
		const snapshot = await captureMultiFileSnapshot(
			this.boundary,
			change.snapshot.root,
			change.snapshot.path,
		);
		return { content: snapshot.content, exists: snapshot.exists, hash: snapshot.hash };
	}

	async applyProposal(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		const edit = new vscode.WorkspaceEdit();
		for (const change of changes) {
			if (change.snapshot.exists) {
				const document = await vscode.workspace.openTextDocument(change.snapshot.uri);
				edit.replace(
					change.snapshot.uri,
					new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
					change.appliedContent,
					{ label: `Apply Agni proposal: ${change.snapshot.path}`, needsConfirmation: false },
				);
			} else {
				edit.createFile(change.snapshot.uri, { ignoreIfExists: false, overwrite: false }, {
					label: `Create Agni proposal: ${change.snapshot.path}`,
					needsConfirmation: false,
				});
				edit.insert(change.snapshot.uri, new vscode.Position(0, 0), change.appliedContent, {
					label: `Populate Agni proposal: ${change.snapshot.path}`,
					needsConfirmation: false,
				});
			}
		}
		return vscode.workspace.applyEdit(edit, { isRefactoring: true });
	}

	async applyRollback(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		const edit = new vscode.WorkspaceEdit();
		for (const change of changes) {
			if (!change.snapshot.exists) {
				edit.deleteFile(change.snapshot.uri, { ignoreIfNotExists: false, recursive: false }, {
					label: `Undo Agni-created file: ${change.snapshot.path}`,
					needsConfirmation: false,
				});
				continue;
			}

			const document = await vscode.workspace.openTextDocument(change.snapshot.uri);
			edit.replace(
				change.snapshot.uri,
				new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
				change.snapshot.content,
				{ label: `Undo Agni proposal: ${change.snapshot.path}`, needsConfirmation: false },
			);
		}
		return vscode.workspace.applyEdit(edit, { isRefactoring: true });
	}
}

export class MultiFileEditController {
	constructor(
		private readonly workspace: MultiFileWorkspace,
		private readonly diffViewer: MultiFileDiffViewer,
		readonly store: MultiFileProposalStore,
	) {}

	async openReview(id: string): Promise<MultiFileTransaction> {
		const transaction = this.store.require(id);
		if (transaction.status !== 'review') {
			throw new MultiFileProposalError(`Multi-file edit is ${transaction.status}, not ready for review.`);
		}
		await this.diffViewer.showReview(transaction);
		return transaction;
	}

	async accept(id: string): Promise<MultiFileTransaction> {
		this.acceptAll(id);
		return this.applyReviewed(id);
	}

	acceptAll(id: string): MultiFileTransaction {
		const transaction = this.store.require(id);
		if (transaction.status !== 'review') {
			throw new MultiFileProposalError(`Multi-file edit is ${transaction.status} and cannot be accepted.`);
		}
		for (const key of transaction.changes.keys()) {
			this.store.setFileDecision(id, key, 'accepted');
		}
		return transaction;
	}

	acceptFile(id: string, key: string): MultiFileChange {
		return this.store.setFileDecision(id, key, 'accepted');
	}

	rejectFile(id: string, key: string): MultiFileChange {
		return this.store.setFileDecision(id, key, 'rejected');
	}

	acceptHunk(id: string, key: string, hunkId: string): MultiFileChange {
		return this.store.setHunkDecision(id, key, hunkId, 'accepted');
	}

	rejectHunk(id: string, key: string, hunkId: string): MultiFileChange {
		return this.store.setHunkDecision(id, key, hunkId, 'rejected');
	}

	reviewState(id: string): { accepted: number; pending: number; rejected: number } {
		const transaction = this.store.require(id);
		let accepted = 0;
		let pending = 0;
		let rejected = 0;
		for (const change of transaction.changes.values()) {
			for (const hunk of change.hunks) {
				if (hunk.decision === 'accepted') {
					accepted += 1;
				} else if (hunk.decision === 'rejected') {
					rejected += 1;
				} else {
					pending += 1;
				}
			}
		}
		return { accepted, pending, rejected };
	}

	async applyReviewed(id: string): Promise<MultiFileTransaction> {
		const transaction = this.store.require(id);
		if (transaction.status !== 'review') {
			throw new MultiFileProposalError(`Multi-file edit is ${transaction.status} and cannot be applied.`);
		}
		const review = this.reviewState(id);
		if (review.pending > 0) {
			throw new MultiFileProposalError(`Review all hunks before applying; ${review.pending} hunk(s) remain pending.`);
		}
		const changes: AppliedMultiFileChange[] = [];
		for (const change of transaction.changes.values()) {
			const acceptedContent = this.store.materializeAcceptedContent(change);
			const hasAcceptedHunk = change.hunks.some((hunk) => hunk.decision === 'accepted');
			if (!hasAcceptedHunk || (change.snapshot.exists && acceptedContent === change.snapshot.content)) {
				continue;
			}
			changes.push({
				appliedContent: acceptedContent,
				appliedHash: contentHash(acceptedContent),
				snapshot: change.snapshot,
			});
		}
		if (changes.length === 0) {
			return this.store.reject(id);
		}
		try {
			await this.assertOriginalsCurrent(changes);
		} catch (error: unknown) {
			this.store.markStale(id);
			throw error;
		}

		const applied = await this.workspace.applyProposal(changes);
		if (!applied) {
			throw new MultiFileProposalError('VS Code did not apply the approved multi-file edit.');
		}
		const readBack = await this.readBackAppliedChanges(changes);
		const appliedTransaction = this.store.markApplied(id, readBack.changes);
		if (readBack.mismatch) {
			throw new MultiFileStaleError(
				`VS Code reported success, but an applied file did not match its proposal. File: `
				+ `${readBack.mismatch.snapshot.root}/${readBack.mismatch.snapshot.path}.`,
			);
		}
		return appliedTransaction;
	}

	reject(id: string): MultiFileTransaction {
		return this.store.reject(id);
	}

	async undoLast(): Promise<MultiFileTransaction> {
		const batch = this.store.getLastAppliedBatch();
		if (!batch) {
			throw new MultiFileProposalError('There is no applied Agni multi-file edit available to undo.');
		}
		const transaction = this.store.require(batch.transactionId);
		const changes = batch.changes;
		await this.assertProposalsCurrent(
			changes,
			'Cannot undo because a file changed after Agni applied the multi-file edit.',
		);
		const applied = await this.workspace.applyRollback(changes);
		if (!applied) {
			throw new MultiFileProposalError('VS Code did not apply the multi-file rollback.');
		}
		await this.assertOriginalsCurrent(changes);
		return this.store.markUndone(transaction.id);
	}

	private async assertOriginalsCurrent(changes: readonly AppliedMultiFileChange[]): Promise<void> {
		for (const change of changes) {
			const current = await this.workspace.readCurrent(change);
			if (current.exists !== change.snapshot.exists || current.hash !== change.snapshot.hash) {
				throw new MultiFileStaleError(
					`File changed since the proposal was captured: ${change.snapshot.root}/${change.snapshot.path}.`,
				);
			}
		}
	}

	private async assertProposalsCurrent(changes: readonly AppliedMultiFileChange[], message: string): Promise<void> {
		for (const change of changes) {
			const current = await this.workspace.readCurrent(change);
			if (!current.exists || current.hash !== change.appliedHash) {
				throw new MultiFileStaleError(`${message} File: ${change.snapshot.root}/${change.snapshot.path}.`);
			}
		}
	}

	private async readBackAppliedChanges(changes: readonly AppliedMultiFileChange[]): Promise<{
		changes: AppliedMultiFileChange[];
		mismatch?: AppliedMultiFileChange;
	}> {
		const actualChanges: AppliedMultiFileChange[] = [];
		let mismatch: AppliedMultiFileChange | undefined;
		for (const change of changes) {
			const current = await this.workspace.readCurrent(change);
			const actualChange: AppliedMultiFileChange = {
				appliedContent: current.content,
				appliedHash: current.hash,
				snapshot: change.snapshot,
			};
			actualChanges.push(actualChange);
			if (!mismatch && (!current.exists
				|| normalizeEolForComparison(current.content)
					!== normalizeEolForComparison(change.appliedContent))) {
				mismatch = actualChange;
			}
		}
		return { changes: actualChanges, mismatch };
	}
}
