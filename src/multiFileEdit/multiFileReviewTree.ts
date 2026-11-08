import * as vscode from 'vscode';
import { hunkLineNumber, type MultiFileHunk } from './multiFileHunks.js';
import {
	multiFileChangeKey,
	type MultiFileChange,
	MultiFileProposalStore,
} from './multiFileProposal.js';

export const multiFileReviewViewId = 'agni.multiFileReview';

function statusIcon(status: string): vscode.ThemeIcon {
	if (status === 'accepted') {
		return new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
	}
	if (status === 'rejected') {
		return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'));
	}
	if (status === 'partial') {
		return new vscode.ThemeIcon('diff-multiple');
	}
	return new vscode.ThemeIcon('question');
}

export class MultiFileReviewFileNode extends vscode.TreeItem {
	readonly key: string;

	constructor(
		readonly transactionId: string,
		readonly change: MultiFileChange,
		status: string,
	) {
		super(change.snapshot.path, vscode.TreeItemCollapsibleState.Expanded);
		this.key = multiFileChangeKey(change.snapshot.root, change.snapshot.path);
		this.description = status;
		this.contextValue = 'agniMultiFileReviewFile';
		this.iconPath = statusIcon(status);
		this.tooltip = `${change.snapshot.root}/${change.snapshot.path}`;
		this.command = {
			arguments: [transactionId, this.key],
			command: 'agni.multiFileEdit.openReviewFile',
			title: 'Open Agni file review',
		};
	}
}

export class MultiFileReviewHunkNode extends vscode.TreeItem {
	constructor(
		readonly transactionId: string,
		readonly key: string,
		readonly hunk: MultiFileHunk,
		change: MultiFileChange,
		index: number,
	) {
		const startLine = hunkLineNumber(change.snapshot.content, hunk.originalStart);
		const endLine = hunkLineNumber(change.snapshot.content, hunk.originalEnd);
		super(
			`Hunk ${index + 1}: ${startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`}`,
			vscode.TreeItemCollapsibleState.None,
		);
		this.description = hunk.decision;
		this.contextValue = 'agniMultiFileReviewHunk';
		this.iconPath = statusIcon(hunk.decision);
		this.tooltip = hunk.replacementText || '(deletion)';
		this.command = {
			arguments: [transactionId, key],
			command: 'agni.multiFileEdit.openReviewFile',
			title: 'Open Agni hunk review',
		};
	}
}

export type MultiFileReviewNode = MultiFileReviewFileNode | MultiFileReviewHunkNode;

export class MultiFileReviewTreeProvider implements vscode.TreeDataProvider<MultiFileReviewNode>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<MultiFileReviewNode | undefined>();
	private transactionId: string | undefined;
	readonly onDidChangeTreeData = this.changeEmitter.event;

	constructor(private readonly store: MultiFileProposalStore) {}

	setTransaction(transactionId: string | undefined): void {
		this.transactionId = transactionId;
		this.refresh();
	}

	refresh(node?: MultiFileReviewNode): void {
		this.changeEmitter.fire(node);
	}

	getTreeItem(element: MultiFileReviewNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: MultiFileReviewNode): MultiFileReviewNode[] {
		if (!this.transactionId) {
			return [];
		}
		const transaction = this.store.get(this.transactionId);
		if (!transaction) {
			return [];
		}
		if (element instanceof MultiFileReviewFileNode) {
			return element.change.hunks.map((hunk, index) => new MultiFileReviewHunkNode(
				element.transactionId,
				element.key,
				hunk,
				element.change,
				index,
			));
		}
		if (element) {
			return [];
		}
		return [...transaction.changes.values()]
			.sort((left, right) => left.snapshot.path.localeCompare(right.snapshot.path))
			.map((change) => new MultiFileReviewFileNode(
				transaction.id,
				change,
				this.store.getReviewStatus(change),
			));
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}
