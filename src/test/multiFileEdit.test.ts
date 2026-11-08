import * as assert from 'assert';
import { type TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { type ContextAssembler } from '../context/contextAssembler.js';
import {
	MultiFileEditController,
	type MultiFileDiffViewer,
	type MultiFileWorkspace,
} from '../multiFileEdit/multiFileController.js';
import { MultiFileDiffProvider } from '../multiFileEdit/multiFileDiff.js';
import {
	MultiFileReviewFileNode,
	MultiFileReviewHunkNode,
	MultiFileReviewTreeProvider,
} from '../multiFileEdit/multiFileReviewTree.js';
import {
	type AppliedMultiFileChange,
	contentHash,
	type MultiFileChange,
	multiFileChangeKey,
	MultiFileProposalStore,
	MultiFileStaleError,
	type MultiFileTransaction,
} from '../multiFileEdit/multiFileProposal.js';
import { ProposeWriteTool } from '../tools/proposeWrite.js';
import {
	MultiFileEditCancelledError,
	runMultiFileAgentTurn,
} from '../trueforge/multiFileEditAgent.js';
import { type WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

class ProposalWorkspaceAdapter implements WorkspaceAdapter {
	readonly files = new Map<string, string>();
	readonly root: vscode.WorkspaceFolder = {
		index: 0,
		name: 'project',
		uri: vscode.Uri.file('C:\\agni-multi-file-test\\project'),
	};

	add(path: string, content: string): void {
		this.files.set(vscode.Uri.joinPath(this.root.uri, ...path.split('/')).toString(), content);
	}

	findFiles(): Thenable<vscode.Uri[]> {
		return Promise.resolve([...this.files.keys()].map((value) => vscode.Uri.parse(value)));
	}

	getOpenDocumentText(): string | undefined {
		return undefined;
	}

	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return [this.root];
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		const content = this.files.get(uri.toString());
		return content === undefined
			? Promise.reject(vscode.FileSystemError.FileNotFound(uri))
			: Promise.resolve(new TextEncoder().encode(content));
	}

	stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
		const content = this.files.get(uri.toString());
		if (content !== undefined) {
			return Promise.resolve({
				ctime: 0,
				mtime: 0,
				size: Buffer.byteLength(content),
				type: vscode.FileType.File,
			});
		}
		const prefix = `${uri.toString().replace(/\/$/u, '')}/`;
		if (uri.toString() === this.root.uri.toString()
			|| [...this.files.keys()].some((entry) => entry.startsWith(prefix))) {
			return Promise.resolve({ ctime: 0, mtime: 0, size: 0, type: vscode.FileType.Directory });
		}
		return Promise.reject(vscode.FileSystemError.FileNotFound(uri));
	}
}

class MemoryMultiFileWorkspace implements MultiFileWorkspace {
	applyCount = 0;
	rollbackCount = 0;
	readonly files = new Map<string, string>();

	constructor(changes: readonly MultiFileChange[]) {
		for (const change of changes) {
			if (change.snapshot.exists) {
				this.files.set(change.snapshot.uri.toString(), change.snapshot.content);
			}
		}
	}

	applyProposal(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		this.applyCount += 1;
		for (const change of changes) {
			this.files.set(change.snapshot.uri.toString(), change.appliedContent);
		}
		return Promise.resolve(true);
	}

	applyRollback(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		this.rollbackCount += 1;
		for (const change of changes) {
			if (change.snapshot.exists) {
				this.files.set(change.snapshot.uri.toString(), change.snapshot.content);
			} else {
				this.files.delete(change.snapshot.uri.toString());
			}
		}
		return Promise.resolve(true);
	}

	readCurrent(change: Pick<AppliedMultiFileChange, 'snapshot'>): Promise<{ content: string; exists: boolean; hash: string }> {
		const content = this.files.get(change.snapshot.uri.toString());
		return Promise.resolve({
			content: content ?? '',
			exists: content !== undefined,
			hash: contentHash(content ?? ''),
		});
	}
}

function toCrlf(content: string): string {
	return content.replace(/\r\n|\r|\n/gu, '\r\n');
}

class EolNormalizingWorkspace extends MemoryMultiFileWorkspace {
	constructor(
		changes: readonly MultiFileChange[],
		private readonly corruptPath?: string,
	) {
		super(changes);
	}

	override applyProposal(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		this.applyCount += 1;
		for (const change of changes) {
			let content = change.snapshot.exists
				? change.appliedContent
				: toCrlf(change.appliedContent);
			if (change.snapshot.path === this.corruptPath) {
				content += '// unexpected editor mutation\r\n';
			}
			this.files.set(change.snapshot.uri.toString(), content);
		}
		return Promise.resolve(true);
	}
}

class RecordingMultiFileDiffViewer implements MultiFileDiffViewer {
	transactions: MultiFileTransaction[] = [];

	showReview(transaction: MultiFileTransaction): Promise<void> {
		this.transactions.push(transaction);
		return Promise.resolve();
	}
}

function addChange(
	store: MultiFileProposalStore,
	path: string,
	original: string,
	proposed: string,
	exists = true,
): void {
	store.propose({
		content: original,
		exists,
		hash: contentHash(original),
		path,
		root: 'project',
		uri: vscode.Uri.file(`C:\\agni-multi-file-test\\project\\${path.replace(/\//gu, '\\')}`),
	}, proposed);
}

function threeFileFixture(): {
	controller: MultiFileEditController;
	diff: RecordingMultiFileDiffViewer;
	store: MultiFileProposalStore;
	transaction: MultiFileTransaction;
	workspace: MemoryMultiFileWorkspace;
} {
	const store = new MultiFileProposalStore();
	const transaction = store.begin('Update three modules.', 'transaction-1');
	addChange(store, 'src/one.ts', 'export const one = 1;', 'export const one = 10;');
	addChange(store, 'src/two.ts', 'export const two = 2;', 'export const two = 20;');
	addChange(store, 'src/three.ts', 'export const three = 3;', 'export const three = 30;');
	store.closeForReview(transaction.id);
	const diff = new RecordingMultiFileDiffViewer();
	const workspace = new MemoryMultiFileWorkspace([...transaction.changes.values()]);
	return {
		controller: new MultiFileEditController(workspace, diff, store),
		diff,
		store,
		transaction,
		workspace,
	};
}

suite('Autonomous multi-file editing', () => {
	test('propose_write records three proposals without writing workspace files', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/one.ts', 'one');
		adapter.add('src/two.ts', 'two');
		adapter.add('src/three.ts', 'three');
		const store = new MultiFileProposalStore();
		store.begin('Change three files.', 'proposal-tool-transaction');
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));

		for (const [path, content] of [
			['src/one.ts', 'updated one'],
			['src/two.ts', 'updated two'],
			['src/three.ts', 'updated three'],
		] as const) {
			const result = await tool.run({ content, path, root: 'project' });
			assert.strictEqual(result.isError, undefined);
		}

		assert.strictEqual(store.getActive()?.changes.size, 3);
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'one.ts').toString()), 'one');
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'two.ts').toString()), 'two');
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'three.ts').toString()), 'three');
	});

	test('propose_write rejects traversal and late proposals', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/one.ts', 'one');
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Safe proposal.', 'safe-transaction');
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));
		const traversal = await tool.run({ content: 'bad', path: '../outside.ts', root: 'project' });
		assert.strictEqual(traversal.isError, true);

		await tool.run({ content: 'updated', path: 'src/one.ts', root: 'project' });
		store.closeForReview(transaction.id);
		const late = await tool.run({ content: 'later', path: 'src/one.ts', root: 'project' });
		assert.strictEqual(late.isError, true);
	});

	test('reviews and atomically applies a three-file task, then rolls it back', async () => {
		const fixture = threeFileFixture();
		await fixture.controller.openReview(fixture.transaction.id);
		assert.deepStrictEqual(fixture.diff.transactions, [fixture.transaction]);
		assert.strictEqual(fixture.workspace.applyCount, 0);

		const applied = await fixture.controller.accept(fixture.transaction.id);
		assert.strictEqual(applied.status, 'applied');
		assert.strictEqual(fixture.workspace.applyCount, 1);
		for (const change of fixture.transaction.changes.values()) {
			assert.strictEqual(fixture.workspace.files.get(change.snapshot.uri.toString()), change.proposedContent);
		}

		const undone = await fixture.controller.undoLast();
		assert.strictEqual(undone.status, 'undone');
		assert.strictEqual(fixture.workspace.rollbackCount, 1);
		for (const change of fixture.transaction.changes.values()) {
			assert.strictEqual(fixture.workspace.files.get(change.snapshot.uri.toString()), change.snapshot.content);
		}
	});

	test('rejects a reviewed batch without applying it', () => {
		const fixture = threeFileFixture();
		const rejected = fixture.controller.reject(fixture.transaction.id);
		assert.strictEqual(rejected.status, 'rejected');
		assert.strictEqual(fixture.workspace.applyCount, 0);
	});

	test('blocks stale acceptance across the entire batch', async () => {
		const fixture = threeFileFixture();
		const first = [...fixture.transaction.changes.values()][0];
		fixture.workspace.files.set(first.snapshot.uri.toString(), 'changed outside Agni');
		await assert.rejects(
			fixture.controller.accept(fixture.transaction.id),
			(error: unknown) => error instanceof MultiFileStaleError,
		);
		assert.strictEqual(fixture.transaction.status, 'stale');
		assert.strictEqual(fixture.workspace.applyCount, 0);
	});

	test('blocks rollback when an applied file changed afterward', async () => {
		const fixture = threeFileFixture();
		await fixture.controller.accept(fixture.transaction.id);
		const first = [...fixture.transaction.changes.values()][0];
		fixture.workspace.files.set(first.snapshot.uri.toString(), 'user change after apply');
		await assert.rejects(
			fixture.controller.undoLast(),
			(error: unknown) => error instanceof MultiFileStaleError,
		);
		assert.strictEqual(fixture.workspace.rollbackCount, 0);
	});

	test('accepts VS Code EOL normalization and stores exact read-back hashes', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Apply an EOL-normalized batch.', 'eol-batch');
		addChange(store, 'src/existing.ts', 'export const old = true;\n', 'export const updated = true;\n');
		addChange(store, 'src/new-one.ts', '', 'export const one = 1;\n', false);
		addChange(store, 'src/new-two.ts', '', 'export const two = 2;\n', false);
		store.closeForReview(transaction.id);
		const changes = [...transaction.changes.values()];
		const workspace = new EolNormalizingWorkspace(changes);
		const controller = new MultiFileEditController(workspace, new RecordingMultiFileDiffViewer(), store);

		const applied = await controller.accept(transaction.id);
		assert.strictEqual(applied.status, 'applied');
		const history = store.getLastAppliedBatch();
		assert.strictEqual(history?.changes.length, 3);
		const existing = history?.changes.find((change) => change.snapshot.path === 'src/existing.ts');
		assert.strictEqual(existing?.appliedContent, 'export const updated = true;\n');
		for (const path of ['src/new-one.ts', 'src/new-two.ts']) {
			const recorded: AppliedMultiFileChange | undefined = history?.changes
				.find((change) => change.snapshot.path === path);
			assert.ok(recorded);
			assert.match(recorded.appliedContent, /\r\n/u);
			assert.strictEqual(recorded.appliedHash, contentHash(recorded.appliedContent));
			assert.strictEqual(
				recorded.appliedContent,
				workspace.files.get(recorded.snapshot.uri.toString()),
			);
		}

		const undone = await controller.undoLast();
		assert.strictEqual(undone.status, 'undone');
		assert.strictEqual(workspace.rollbackCount, 1);
		assert.strictEqual(
			workspace.files.get(changes[0].snapshot.uri.toString()),
			changes[0].snapshot.content,
		);
		assert.strictEqual(workspace.files.has(changes[1].snapshot.uri.toString()), false);
		assert.strictEqual(workspace.files.has(changes[2].snapshot.uri.toString()), false);
	});

	test('retains exact recovery history after a genuine post-apply mismatch', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Apply a genuinely mismatched batch.', 'mismatch-batch');
		addChange(store, 'src/existing.ts', 'export const old = true;\n', 'export const updated = true;\n');
		addChange(store, 'src/new.ts', '', 'export const created = true;\n', false);
		store.closeForReview(transaction.id);
		const changes = [...transaction.changes.values()];
		const workspace = new EolNormalizingWorkspace(changes, 'src/new.ts');
		const controller = new MultiFileEditController(workspace, new RecordingMultiFileDiffViewer(), store);

		await assert.rejects(
			controller.accept(transaction.id),
			(error: unknown) => error instanceof MultiFileStaleError
				&& /src\/new\.ts/iu.test(error.message),
		);
		assert.strictEqual(transaction.status, 'applied');
		const history = store.getLastAppliedBatch();
		const recorded = history?.changes.find((change) => change.snapshot.path === 'src/new.ts');
		assert.ok(recorded);
		assert.match(recorded.appliedContent, /unexpected editor mutation/iu);
		assert.strictEqual(recorded.appliedHash, contentHash(recorded.appliedContent));

		const undone = await controller.undoLast();
		assert.strictEqual(undone.status, 'undone');
		assert.strictEqual(workspace.files.has(changes[1].snapshot.uri.toString()), false);
		assert.strictEqual(
			workspace.files.get(changes[0].snapshot.uri.toString()),
			changes[0].snapshot.content,
		);
	});

	test('applies one accepted hunk and rejects another in the same file', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Partially update one file.', 'partial-transaction');
		addChange(
			store,
			'src/partial.ts',
			'const first = "old";\nconst middle = true;\nconst second = "old";\n',
			'const first = "new";\nconst middle = true;\nconst second = "new";\n',
		);
		store.closeForReview(transaction.id);
		const change = [...transaction.changes.values()][0];
		assert.strictEqual(change.hunks.length, 2);
		const key = multiFileChangeKey(change.snapshot.root, change.snapshot.path);
		const workspace = new MemoryMultiFileWorkspace([change]);
		const controller = new MultiFileEditController(workspace, new RecordingMultiFileDiffViewer(), store);
		controller.acceptHunk(transaction.id, key, change.hunks[0].id);
		controller.rejectHunk(transaction.id, key, change.hunks[1].id);

		await controller.applyReviewed(transaction.id);
		assert.strictEqual(
			workspace.files.get(change.snapshot.uri.toString()),
			'const first = "new";\nconst middle = true;\nconst second = "old";\n',
		);
		assert.strictEqual(store.getLastAppliedBatch()?.changes.length, 1);
		await controller.undoLast();
		assert.strictEqual(workspace.files.get(change.snapshot.uri.toString()), change.snapshot.content);
	});

	test('applies a three-file review with mixed file decisions', async () => {
		const fixture = threeFileFixture();
		const entries = [...fixture.transaction.changes.entries()];
		fixture.controller.acceptFile(fixture.transaction.id, entries[0][0]);
		fixture.controller.rejectFile(fixture.transaction.id, entries[1][0]);
		fixture.controller.acceptFile(fixture.transaction.id, entries[2][0]);

		await fixture.controller.applyReviewed(fixture.transaction.id);
		assert.strictEqual(fixture.workspace.applyCount, 1);
		assert.strictEqual(fixture.store.getLastAppliedBatch()?.changes.length, 2);
		assert.strictEqual(
			fixture.workspace.files.get(entries[0][1].snapshot.uri.toString()),
			entries[0][1].proposedContent,
		);
		assert.strictEqual(
			fixture.workspace.files.get(entries[1][1].snapshot.uri.toString()),
			entries[1][1].snapshot.content,
		);
		assert.strictEqual(
			fixture.workspace.files.get(entries[2][1].snapshot.uri.toString()),
			entries[2][1].proposedContent,
		);
	});

	test('fully rejected files produce no WorkspaceEdit or undo history', async () => {
		const fixture = threeFileFixture();
		for (const key of fixture.transaction.changes.keys()) {
			fixture.controller.rejectFile(fixture.transaction.id, key);
		}
		const transaction = await fixture.controller.applyReviewed(fixture.transaction.id);
		assert.strictEqual(transaction.status, 'rejected');
		assert.strictEqual(fixture.workspace.applyCount, 0);
		assert.strictEqual(fixture.store.getLastAppliedBatch(), undefined);
	});

	test('stale protection covers partially approved files', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Partial stale change.', 'partial-stale');
		addChange(store, 'src/stale.ts', 'old one\nmiddle\nold two\n', 'new one\nmiddle\nnew two\n');
		store.closeForReview(transaction.id);
		const change = [...transaction.changes.values()][0];
		const key = multiFileChangeKey(change.snapshot.root, change.snapshot.path);
		const workspace = new MemoryMultiFileWorkspace([change]);
		const controller = new MultiFileEditController(workspace, new RecordingMultiFileDiffViewer(), store);
		controller.acceptHunk(transaction.id, key, change.hunks[0].id);
		controller.rejectHunk(transaction.id, key, change.hunks[1].id);
		workspace.files.set(change.snapshot.uri.toString(), 'external edit\n');

		await assert.rejects(
			controller.applyReviewed(transaction.id),
			(error: unknown) => error instanceof MultiFileStaleError,
		);
		assert.strictEqual(workspace.applyCount, 0);
	});

	test('deletes a newly created proposal during rollback', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Create one file.', 'create-transaction');
		addChange(store, 'src/new.ts', '', 'export const created = true;', false);
		store.closeForReview(transaction.id);
		const workspace = new MemoryMultiFileWorkspace([...transaction.changes.values()]);
		const controller = new MultiFileEditController(workspace, new RecordingMultiFileDiffViewer(), store);
		await controller.accept(transaction.id);
		const change = [...transaction.changes.values()][0];
		assert.strictEqual(workspace.files.has(change.snapshot.uri.toString()), true);
		await controller.undoLast();
		assert.strictEqual(workspace.files.has(change.snapshot.uri.toString()), false);
	});

	test('serves stable before and after virtual diff documents', async () => {
		const fixture = threeFileFixture();
		const calls: unknown[][] = [];
		const provider = new MultiFileDiffProvider(fixture.store, (_command, ...args) => {
			calls.push(args);
			return Promise.resolve(undefined);
		});
		await provider.showReview(fixture.transaction);
		assert.strictEqual(calls.length, 3);
		const first = [...fixture.transaction.changes.values()][0];
		assert.strictEqual(provider.provideTextDocumentContent(calls[0][0] as vscode.Uri), first.snapshot.content);
		assert.strictEqual(provider.provideTextDocumentContent(calls[0][1] as vscode.Uri), first.proposedContent);
	});

	test('refreshes the virtual proposed document after a hunk decision', async () => {
		const fixture = threeFileFixture();
		const provider = new MultiFileDiffProvider(fixture.store, () => Promise.resolve(undefined));
		const emitted: vscode.Uri[] = [];
		const subscription = provider.onDidChange((uri) => emitted.push(uri));
		const [key, change] = [...fixture.transaction.changes.entries()][0];
		fixture.controller.rejectHunk(fixture.transaction.id, key, change.hunks[0].id);
		provider.refresh(fixture.transaction.id, key);
		subscription.dispose();
		assert.strictEqual(emitted.length, 1);
		assert.strictEqual(provider.provideTextDocumentContent(emitted[0]), change.snapshot.content);
	});

	test('shows files and stable hunks in the Agni review tree', () => {
		const fixture = threeFileFixture();
		const provider = new MultiFileReviewTreeProvider(fixture.store);
		provider.setTransaction(fixture.transaction.id);
		const files = provider.getChildren();
		assert.strictEqual(files.length, 3);
		assert.ok(files[0] instanceof MultiFileReviewFileNode);
		const hunks = provider.getChildren(files[0]);
		assert.strictEqual(hunks.length, 1);
		assert.ok(hunks[0] instanceof MultiFileReviewHunkNode);
		assert.strictEqual(hunks[0].description, 'pending');
		fixture.controller.acceptHunk(
			fixture.transaction.id,
			(files[0] as MultiFileReviewFileNode).key,
			(hunks[0] as MultiFileReviewHunkNode).hunk.id,
		);
		const refreshed = provider.getChildren(files[0]);
		assert.strictEqual(refreshed[0].description, 'accepted');
		provider.dispose();
	});

	test('cancels the TrueForge session and closes the active transaction', async () => {
		let cancelCount = 0;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const client = {
			sessions: {
				cancel: async () => { cancelCount += 1; },
				create: async () => ({ data: { id: 'multi-session' } }),
				createTurnStream: async () => ({
					async *[Symbol.asyncIterator]() {
						markStarted?.();
						await new Promise(() => undefined);
					},
				}),
			},
		} as unknown as TrueForge;
		const assembler = { assemble: () => Promise.resolve({ byteLength: 0, content: '' }) } as unknown as ContextAssembler;
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Cancel this task.', 'cancel-transaction');
		const cancellation = new vscode.CancellationTokenSource();
		const generation = runMultiFileAgentTurn(
			client,
			'model/fqn',
			transaction.task,
			transaction.id,
			store,
			cancellation.token,
			{},
			assembler,
		);
		await started;
		cancellation.cancel();
		await assert.rejects(
			generation,
			(error: unknown) => error instanceof MultiFileEditCancelledError,
		);
		cancellation.dispose();
		assert.strictEqual(cancelCount, 1);
		assert.strictEqual(transaction.status, 'cancelled');
		assert.strictEqual(store.getActive(), undefined);
	});
});
