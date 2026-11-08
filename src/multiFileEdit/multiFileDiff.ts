import * as vscode from 'vscode';
import {
	multiFileChangeKey,
	MultiFileProposalStore,
	type MultiFileTransaction,
} from './multiFileProposal.js';
import { type MultiFileDiffViewer } from './multiFileController.js';

export const multiFileDiffScheme = 'agni-multi-file-edit';
type CommandExecutor = (command: string, ...rest: unknown[]) => Thenable<unknown>;

export type MultiFileDiffSide = 'after' | 'before';

export interface MultiFileDiffReference {
	changeKey: string;
	path: string;
	root: string;
	side: MultiFileDiffSide;
	transactionId: string;
}

export function createMultiFileDiffUri(
	transactionId: string,
	root: string,
	path: string,
	side: MultiFileDiffSide,
): vscode.Uri {
	const fileName = path.slice(path.lastIndexOf('/') + 1) || 'proposal.txt';
	return vscode.Uri.from({
		path: `/${transactionId}/${side}/${fileName}`,
		query: new URLSearchParams({ path, root, side, transaction: transactionId }).toString(),
		scheme: multiFileDiffScheme,
	});
}

export function parseMultiFileDiffUri(uri: vscode.Uri): MultiFileDiffReference | undefined {
	if (uri.scheme !== multiFileDiffScheme) {
		return undefined;
	}
	const query = new URLSearchParams(uri.query);
	const path = query.get('path');
	const root = query.get('root');
	const side = query.get('side');
	const transactionId = query.get('transaction');
	if (!path || !root || !transactionId || (side !== 'after' && side !== 'before')) {
		return undefined;
	}
	return {
		changeKey: multiFileChangeKey(root, path),
		path,
		root,
		side,
		transactionId,
	};
}

export class MultiFileDiffProvider implements vscode.TextDocumentContentProvider, MultiFileDiffViewer, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(
		private readonly store: MultiFileProposalStore,
		private readonly executeCommand: CommandExecutor = vscode.commands.executeCommand,
	) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const reference = parseMultiFileDiffUri(uri);
		if (!reference) {
			throw new Error('Agni multi-file diff URI is invalid.');
		}
		const transaction = this.store.require(reference.transactionId);
		const change = transaction.changes.get(reference.changeKey);
		if (!change) {
			throw new Error('Agni multi-file diff does not reference a known proposal.');
		}
		return reference.side === 'before'
			? change.snapshot.content
			: this.store.materializeReviewContent(change);
	}

	async showReview(transaction: MultiFileTransaction): Promise<void> {
		for (const key of transaction.changes.keys()) {
			await this.showFile(transaction.id, key);
		}
	}

	async showFile(transactionId: string, key: string): Promise<void> {
		const transaction = this.store.require(transactionId);
		const change = transaction.changes.get(key);
		if (!change) {
			throw new Error(`Agni multi-file review change "${key}" was not found.`);
		}
		await this.executeCommand(
			'vscode.diff',
			createMultiFileDiffUri(transaction.id, change.snapshot.root, change.snapshot.path, 'before'),
			createMultiFileDiffUri(transaction.id, change.snapshot.root, change.snapshot.path, 'after'),
			`Agni Multi-File Edit: ${change.snapshot.path}`,
			{ preview: false },
		);
	}

	refresh(transactionId: string, key: string): void {
		const change = this.store.require(transactionId).changes.get(key);
		if (!change) {
			return;
		}
		this.changeEmitter.fire(
			createMultiFileDiffUri(transactionId, change.snapshot.root, change.snapshot.path, 'after'),
		);
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

}

export function registerMultiFileDiffProvider(
	context: vscode.ExtensionContext,
	provider: MultiFileDiffProvider,
): void {
	context.subscriptions.push(
		provider,
		vscode.workspace.registerTextDocumentContentProvider(multiFileDiffScheme, provider),
	);
}
