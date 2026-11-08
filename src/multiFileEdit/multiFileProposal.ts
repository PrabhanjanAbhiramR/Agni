import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
	createMultiFileHunks,
	materializeHunkDecisions,
	type MultiFileHunk,
	type MultiFileHunkDecision,
} from './multiFileHunks.js';

export const maxMultiFileCount = 20;
export const maxMultiFileBytes = 256 * 1024;
export const maxMultiFileBatchBytes = 1024 * 1024;

export type MultiFileTransactionStatus =
	| 'generating'
	| 'review'
	| 'applied'
	| 'rejected'
	| 'cancelled'
	| 'stale'
	| 'undone';

export interface MultiFileSnapshot {
	content: string;
	exists: boolean;
	hash: string;
	path: string;
	root: string;
	uri: vscode.Uri;
}

export interface MultiFileChange {
	hunks: MultiFileHunk[];
	proposedContent: string;
	proposedHash: string;
	snapshot: MultiFileSnapshot;
}

export interface AppliedMultiFileChange {
	appliedContent: string;
	appliedHash: string;
	snapshot: MultiFileSnapshot;
}

export interface AppliedMultiFileBatch {
	appliedAt: string;
	changes: readonly AppliedMultiFileChange[];
	transactionId: string;
}

export interface MultiFileProposalChangeEvent {
	changeKey?: string;
	transactionId: string;
}

export type MultiFileReviewStatus = 'pending' | 'accepted' | 'rejected' | 'partial';

export interface MultiFileTransaction {
	changes: Map<string, MultiFileChange>;
	createdAt: string;
	id: string;
	status: MultiFileTransactionStatus;
	task: string;
}

export class MultiFileProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'MultiFileProposalError';
	}
}

export class MultiFileStaleError extends MultiFileProposalError {
	constructor(message: string) {
		super(message);
		this.name = 'MultiFileStaleError';
	}
}

export function contentHash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function multiFileChangeKey(root: string, path: string): string {
	return `${root}\0${path}`;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, 'utf8');
}

export class MultiFileProposalStore implements vscode.Disposable {
	private activeTransactionId: string | undefined;
	private readonly changeEmitter = new vscode.EventEmitter<MultiFileProposalChangeEvent>();
	private lastAppliedBatch: AppliedMultiFileBatch | undefined;
	private readonly transactions = new Map<string, MultiFileTransaction>();
	readonly onDidChange = this.changeEmitter.event;

	begin(task: string, id: string = randomUUID()): MultiFileTransaction {
		if (!task.trim()) {
			throw new MultiFileProposalError('A multi-file editing task is required.');
		}
		const unresolved = [...this.transactions.values()]
			.find((transaction) => transaction.status === 'generating' || transaction.status === 'review');
		if (unresolved) {
			throw new MultiFileProposalError(
				'Another Agni multi-file edit is still generating or awaiting review.',
			);
		}

		const transaction: MultiFileTransaction = {
			changes: new Map(),
			createdAt: new Date().toISOString(),
			id,
			status: 'generating',
			task,
		};
		this.transactions.set(id, transaction);
		this.activeTransactionId = id;
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	get(id: string): MultiFileTransaction | undefined {
		return this.transactions.get(id);
	}

	require(id: string): MultiFileTransaction {
		const transaction = this.get(id);
		if (!transaction) {
			throw new MultiFileProposalError(`Multi-file edit transaction "${id}" was not found.`);
		}
		return transaction;
	}

	getActive(): MultiFileTransaction | undefined {
		return this.activeTransactionId ? this.get(this.activeTransactionId) : undefined;
	}

	getLastApplied(): MultiFileTransaction | undefined {
		const transaction = this.lastAppliedBatch
			? this.get(this.lastAppliedBatch.transactionId)
			: undefined;
		return transaction?.status === 'applied' ? transaction : undefined;
	}

	getLastAppliedBatch(): AppliedMultiFileBatch | undefined {
		return this.getLastApplied() ? this.lastAppliedBatch : undefined;
	}

	propose(snapshot: MultiFileSnapshot, proposedContent: string): MultiFileChange {
		const transaction = this.getActive();
		if (!transaction || transaction.status !== 'generating') {
			throw new MultiFileProposalError('No active Agni multi-file generation transaction accepts proposals.');
		}
		if (proposedContent.includes('\0')) {
			throw new MultiFileProposalError('Proposed file content cannot contain NUL characters.');
		}
		const proposedBytes = byteLength(proposedContent);
		if (proposedBytes > maxMultiFileBytes) {
			throw new MultiFileProposalError(
				`Proposed file exceeds the ${maxMultiFileBytes}-byte per-file limit.`,
			);
		}

		const key = multiFileChangeKey(snapshot.root, snapshot.path);
		const existing = transaction.changes.get(key);
		const stableSnapshot = existing?.snapshot ?? snapshot;
		if (proposedContent === stableSnapshot.content && stableSnapshot.exists) {
			throw new MultiFileProposalError('The proposed content is unchanged from the captured file.');
		}
		if (!existing && transaction.changes.size >= maxMultiFileCount) {
			throw new MultiFileProposalError(`A task can propose at most ${maxMultiFileCount} files.`);
		}

		const otherBytes = [...transaction.changes.entries()]
			.filter(([entryKey]) => entryKey !== key)
			.reduce((total, [, change]) => total + byteLength(change.proposedContent), 0);
		if (otherBytes + proposedBytes > maxMultiFileBatchBytes) {
			throw new MultiFileProposalError(
				`Proposed changes exceed the ${maxMultiFileBatchBytes}-byte batch limit.`,
			);
		}

		const change: MultiFileChange = {
			hunks: createMultiFileHunks(
				stableSnapshot.content,
				proposedContent,
				key,
			),
			proposedContent,
			proposedHash: contentHash(proposedContent),
			snapshot: stableSnapshot,
		};
		transaction.changes.set(key, change);
		this.changeEmitter.fire({ changeKey: key, transactionId: transaction.id });
		return change;
	}

	closeForReview(id: string): MultiFileTransaction {
		const transaction = this.requireGenerating(id);
		if (transaction.changes.size === 0) {
			throw new MultiFileProposalError('TrueForge completed without proposing any file changes.');
		}
		transaction.status = 'review';
		this.activeTransactionId = undefined;
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	setFileDecision(id: string, key: string, decision: Exclude<MultiFileHunkDecision, 'pending'>): MultiFileChange {
		const change = this.requireReviewChange(id, key);
		for (const hunk of change.hunks) {
			hunk.decision = decision;
		}
		this.changeEmitter.fire({ changeKey: key, transactionId: id });
		return change;
	}

	setHunkDecision(
		id: string,
		key: string,
		hunkId: string,
		decision: Exclude<MultiFileHunkDecision, 'pending'>,
	): MultiFileChange {
		const change = this.requireReviewChange(id, key);
		const hunk = change.hunks.find((candidate) => candidate.id === hunkId);
		if (!hunk) {
			throw new MultiFileProposalError(`Review hunk "${hunkId}" was not found.`);
		}
		hunk.decision = decision;
		this.changeEmitter.fire({ changeKey: key, transactionId: id });
		return change;
	}

	getReviewStatus(change: MultiFileChange): MultiFileReviewStatus {
		const decisions = new Set(change.hunks.map((hunk) => hunk.decision));
		if (decisions.size === 1) {
			return change.hunks[0]?.decision ?? 'pending';
		}
		return 'partial';
	}

	materializeReviewContent(change: MultiFileChange): string {
		return materializeHunkDecisions(change.snapshot.content, change.hunks, true);
	}

	materializeAcceptedContent(change: MultiFileChange): string {
		return materializeHunkDecisions(change.snapshot.content, change.hunks, false);
	}

	markApplied(id: string, changes: readonly AppliedMultiFileChange[]): MultiFileTransaction {
		const transaction = this.requireStatus(id, 'review');
		if (changes.length === 0) {
			throw new MultiFileProposalError('Cannot create undo history for an empty approval.');
		}
		transaction.status = 'applied';
		this.lastAppliedBatch = Object.freeze({
			appliedAt: new Date().toISOString(),
			changes: Object.freeze(changes.map((change) => Object.freeze({
				...change,
				snapshot: Object.freeze({ ...change.snapshot }),
			}))),
			transactionId: id,
		});
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	markStale(id: string): MultiFileTransaction {
		const transaction = this.require(id);
		transaction.status = 'stale';
		if (this.activeTransactionId === id) {
			this.activeTransactionId = undefined;
		}
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	reject(id: string): MultiFileTransaction {
		const transaction = this.requireStatus(id, 'review');
		transaction.status = 'rejected';
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	cancel(id: string): MultiFileTransaction {
		const transaction = this.require(id);
		if (transaction.status === 'generating') {
			transaction.status = 'cancelled';
		}
		if (this.activeTransactionId === id) {
			this.activeTransactionId = undefined;
		}
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	markUndone(id: string): MultiFileTransaction {
		const transaction = this.requireStatus(id, 'applied');
		transaction.status = 'undone';
		if (this.lastAppliedBatch?.transactionId === id) {
			this.lastAppliedBatch = undefined;
		}
		this.changeEmitter.fire({ transactionId: id });
		return transaction;
	}

	dispose(): void {
		this.activeTransactionId = undefined;
		this.lastAppliedBatch = undefined;
		this.transactions.clear();
		this.changeEmitter.dispose();
	}

	private requireGenerating(id: string): MultiFileTransaction {
		return this.requireStatus(id, 'generating');
	}

	private requireReviewChange(id: string, key: string): MultiFileChange {
		const transaction = this.requireStatus(id, 'review');
		const change = transaction.changes.get(key);
		if (!change) {
			throw new MultiFileProposalError(`Multi-file review change "${key}" was not found.`);
		}
		return change;
	}

	private requireStatus(id: string, status: MultiFileTransactionStatus): MultiFileTransaction {
		const transaction = this.require(id);
		if (transaction.status !== status) {
			throw new MultiFileProposalError(
				`Multi-file edit transaction "${id}" is ${transaction.status}, not ${status}.`,
			);
		}
		return transaction;
	}
}
