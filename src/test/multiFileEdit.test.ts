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
	MultiFilePlanScopeError,
	MultiFileProposalStore,
	MultiFileStaleError,
	type MultiFileTransaction,
} from '../multiFileEdit/multiFileProposal.js';
import { ProposeWriteTool } from '../tools/proposeWrite.js';
import { ProposeEditTool } from '../tools/proposeEdit.js';
import {
	MultiFileEditCancelledError,
	runMultiFileAgentTurn,
} from '../trueforge/multiFileEditAgent.js';
import { type WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

class ProposalWorkspaceAdapter implements WorkspaceAdapter {
	readonly files = new Map<string, string>();
	readonly openFiles = new Map<string, string>();
	readonly symbolicLinks = new Set<string>();
	readCount = 0;
	readonly root: vscode.WorkspaceFolder = {
		index: 0,
		name: 'project',
		uri: vscode.Uri.file('C:\\agni-multi-file-test\\project'),
	};

	add(path: string, content: string, openContent?: string): void {
		const uri = vscode.Uri.joinPath(this.root.uri, ...path.split('/')).toString();
		this.files.set(uri, content);
		if (openContent !== undefined) {
			this.openFiles.set(uri, openContent);
		}
	}

	addSymbolicLink(path: string, content: string): void {
		const uri = vscode.Uri.joinPath(this.root.uri, ...path.split('/')).toString();
		this.files.set(uri, content);
		this.symbolicLinks.add(uri);
	}

	findFiles(): Thenable<vscode.Uri[]> {
		return Promise.resolve([...this.files.keys()].map((value) => vscode.Uri.parse(value)));
	}

	getOpenDocumentText(uri: vscode.Uri): string | undefined {
		return this.openFiles.get(uri.toString());
	}

	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return [this.root];
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		this.readCount += 1;
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
				type: vscode.FileType.File
					| (this.symbolicLinks.has(uri.toString()) ? vscode.FileType.SymbolicLink : 0),
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

class PartiallyFailingWorkspace extends MemoryMultiFileWorkspace {
	override applyProposal(changes: readonly AppliedMultiFileChange[]): Promise<boolean> {
		this.applyCount += 1;
		const first = changes[0];
		if (first) {
			this.files.set(first.snapshot.uri.toString(), first.appliedContent);
		}
		return Promise.resolve(false);
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
	test('propose_edit records three proposals without writing workspace files', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/one.ts', 'one');
		adapter.add('src/two.ts', 'two');
		adapter.add('src/three.ts', 'three');
		const store = new MultiFileProposalStore();
		store.begin('Change three files.', 'proposal-tool-transaction');
		const tool = new ProposeEditTool(store, new WorkspaceBoundary(adapter));

		for (const [path, oldContent, newContent] of [
			['src/one.ts', 'one', 'updated one'],
			['src/two.ts', 'two', 'updated two'],
			['src/three.ts', 'three', 'updated three'],
		] as const) {
			const result = await tool.run({
				edits: [{ new_str: newContent, old_str: oldContent }], path, root: 'project',
			});
			assert.strictEqual(result.isError, undefined);
		}

		assert.strictEqual(store.getActive()?.changes.size, 3);
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'one.ts').toString()), 'one');
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'two.ts').toString()), 'two');
		assert.strictEqual(adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'three.ts').toString()), 'three');
	});

	test('propose_edit preserves existing code outside a targeted edit', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		const original = [
			'import json',
			'',
			'def existing_before():',
			'    return "before"',
			'',
			'def target():',
			'    return "old"',
			'',
			'def existing_after():',
			'    return "after"',
			'',
		].join('\n');
		const proposed = original.replace('    return "old"', '    return "new"');
		adapter.add('src/module.py', original);
		const store = new MultiFileProposalStore();
		store.begin('Change one function.', 'targeted-proposal');
		const tool = new ProposeEditTool(store, new WorkspaceBoundary(adapter));

		const result = await tool.run({
			edits: [{ new_str: '    return "new"', old_str: '    return "old"' }],
			path: 'src/module.py',
			root: 'project',
		});
		const change = store.require('targeted-proposal').changes.get(
			multiFileChangeKey('project', 'src/module.py'),
		);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(change?.snapshot.content, original);
		assert.strictEqual(change?.proposedContent, proposed);
		assert.strictEqual(change?.hunks.length, 1);
		assert.ok(change?.proposedContent.includes('def existing_before():\n    return "before"'));
		assert.ok(change?.proposedContent.includes('def existing_after():\n    return "after"'));
		assert.strictEqual(
			adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'module.py').toString()),
			original,
		);
	});

	test('propose_edit applies one unique match from unsaved editor content', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/open.ts', 'const value = "saved";\n', 'const value = "unsaved";\n');
		const store = new MultiFileProposalStore();
		store.begin('Edit unsaved source.', 'unsaved-edit');
		const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
			edits: [{ new_str: 'const value = "updated";', old_str: 'const value = "unsaved";' }],
			path: 'src/open.ts',
			root: 'project',
		});
		const change = store.require('unsaved-edit').changes.get(
			multiFileChangeKey('project', 'src/open.ts'),
		);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(change?.snapshot.content, 'const value = "unsaved";\n');
		assert.strictEqual(change?.proposedContent, 'const value = "updated";\n');
	});

	test('propose_edit applies multiple exact replacements in one invocation', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		const original = [
			'export const first = 1;',
			'export const unchanged = true;',
			'export const second = 2;',
			'',
		].join('\n');
		adapter.add('src/multiple.ts', original);
		const store = new MultiFileProposalStore();
		store.begin('Update two declarations.', 'multiple-exact-edits');

		const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
			edits: [
				{ new_str: 'export const first = 10;', old_str: 'export const first = 1;' },
				{ new_str: 'export const second = 20;', old_str: 'export const second = 2;' },
			],
			path: 'src/multiple.ts',
			root: 'project',
		});
		const change = store.require('multiple-exact-edits').changes.get(
			multiFileChangeKey('project', 'src/multiple.ts'),
		);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(change?.proposedContent, [
			'export const first = 10;',
			'export const unchanged = true;',
			'export const second = 20;',
			'',
		].join('\n'));
		assert.strictEqual(change?.hunks.length, 2);
		assert.strictEqual(
			adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'multiple.ts').toString()),
			original,
		);
	});

	test('propose_edit rejects symbolic links before reading or recording a proposal', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.addSymbolicLink('src/linked.ts', 'export const linked = false;\n');
		const store = new MultiFileProposalStore();
		store.begin('Reject a linked target.', 'symbolic-link-edit');

		const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
			edits: [{ new_str: 'true', old_str: 'false' }],
			path: 'src/linked.ts',
			root: 'project',
		});

		assert.strictEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? '', /symbolic links are not allowed/iu);
		assert.strictEqual(adapter.readCount, 0);
		assert.strictEqual(store.require('symbolic-link-edit').changes.size, 0);
	});

	test('propose_edit rejects zero and multiple exact matches without recording a proposal', async () => {
		for (const [transactionId, old_str, expected] of [
			['zero-match', 'missing()', /did not match/iu],
			['multiple-match', 'repeat()', /matched more than once/iu],
		] as const) {
			const adapter = new ProposalWorkspaceAdapter();
			adapter.add('src/repeated.ts', 'repeat();\nkeep();\nrepeat();\n');
			const store = new MultiFileProposalStore();
			store.begin('Reject ambiguous edit.', transactionId);
			const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
				edits: [{ new_str: 'updated()', old_str }],
				path: 'src/repeated.ts',
				root: 'project',
			});

			assert.strictEqual(result.isError, true);
			assert.match(result.content[0]?.text ?? '', expected);
			assert.strictEqual(store.require(transactionId).changes.size, 0);
		}
	});

	test('propose_edit preserves CRLF outside the exact replacement', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		const original = 'first\r\nconst oldValue = 1;\r\nlast\r\n';
		adapter.add('src/crlf.ts', original);
		const store = new MultiFileProposalStore();
		store.begin('Preserve CRLF.', 'crlf-edit');
		const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
			edits: [{ new_str: 'const newValue = 2;', old_str: 'const oldValue = 1;' }],
			path: 'src/crlf.ts',
			root: 'project',
		});
		const change = store.require('crlf-edit').changes.get(multiFileChangeKey('project', 'src/crlf.ts'));

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(change?.proposedContent, 'first\r\nconst newValue = 2;\r\nlast\r\n');
	});

	test('a small propose_edit in a large file produces only a local diff hunk', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		const lines = Array.from({ length: 1_200 }, (_, index) => `const line${index + 1} = ${index + 1};`);
		const original = `${lines.join('\n')}\n`;
		adapter.add('src/large.ts', original);
		const store = new MultiFileProposalStore();
		store.begin('Update one declaration.', 'large-targeted-edit');
		const result = await new ProposeEditTool(store, new WorkspaceBoundary(adapter)).run({
			edits: [{ new_str: 'const line600 = 6000;', old_str: 'const line600 = 600;' }],
			path: 'src/large.ts',
			root: 'project',
		});
		const change = store.require('large-targeted-edit').changes.get(
			multiFileChangeKey('project', 'src/large.ts'),
		);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(change?.hunks.length, 1);
		assert.ok((change?.hunks[0]?.originalText.split(/\r\n|\r|\n/u).length ?? 0) < 20);
		assert.ok((change?.hunks[0]?.replacementText.split(/\r\n|\r|\n/u).length ?? 0) < 20);
		assert.ok(change?.proposedContent.startsWith('const line1 = 1;\n'));
		assert.ok(change?.proposedContent.endsWith('const line1200 = 1200;\n'));
	});

	test('propose_write rejects an existing file and directs the model to propose_edit', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		const original = 'def existing():\n    return "preserved"\n';
		adapter.add('src/module.py', original);
		const store = new MultiFileProposalStore();
		store.begin('Change one function.', 'placeholder-proposal');
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));

		const result = await tool.run({
			content: 'def replacement():\n    return "new"\n\n[RETAIN EXISTING CODE]\n',
			path: 'src/module.py',
			root: 'project',
		});

		assert.strictEqual(result.isError, true);
		assert.match(result.content[0]?.text ?? '', /propose_write only creates new files.*propose_edit/iu);
		assert.strictEqual(store.require('placeholder-proposal').changes.size, 0);
		assert.strictEqual(
			adapter.files.get(vscode.Uri.joinPath(adapter.root.uri, 'src', 'module.py').toString()),
			original,
		);
	});

	test('propose_write continues to support complete new-file proposals', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/existing.ts', 'export const existing = true;\n');
		const store = new MultiFileProposalStore();
		store.begin('Create a module.', 'new-file-proposal');
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));
		const content = 'export function created(): string {\n\treturn "ready";\n}\n';

		const result = await tool.run({ content, path: 'src/created.ts', root: 'project' });
		const change = store.require('new-file-proposal').changes.get(
			multiFileChangeKey('project', 'src/created.ts'),
		);

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(result.structuredContent?.created, true);
		assert.strictEqual(change?.snapshot.exists, false);
		assert.strictEqual(change?.proposedContent, content);
		assert.strictEqual(
			adapter.files.has(vscode.Uri.joinPath(adapter.root.uri, 'src', 'created.ts').toString()),
			false,
		);
	});

	test('propose_write rejects traversal and late proposals', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/one.ts', 'one');
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Safe proposal.', 'safe-transaction');
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));
		const traversal = await tool.run({ content: 'bad', path: '../outside.ts', root: 'project' });
		assert.strictEqual(traversal.isError, true);

		await tool.run({ content: 'created', path: 'src/new.ts', root: 'project' });
		store.closeForReview(transaction.id);
		const late = await tool.run({ content: 'later', path: 'src/later.ts', root: 'project' });
		assert.strictEqual(late.isError, true);
	});

	test('rejects an out-of-plan propose_edit before reading the target file', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('src/outside.ts', 'sensitive workspace text');
		const store = new MultiFileProposalStore();
		store.begin(
			'Scoped proposal.',
			'pre-read-scope',
			[{ path: 'src/approved.ts', root: 'project' }],
		);
		const tool = new ProposeEditTool(store, new WorkspaceBoundary(adapter));

		const result = await tool.run({
			edits: [{ new_str: 'replacement', old_str: 'sensitive workspace text' }],
			path: 'src/outside.ts',
			root: 'project',
		});

		assert.strictEqual(result.isError, true);
		assert.strictEqual(adapter.readCount, 0);
		assert.deepStrictEqual(
			store.require('pre-read-scope').scopeViolation,
			{ path: 'src/outside.ts', root: 'project' },
		);
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

	test('accepts two unchanged files whose current text differs only by EOL representation', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Update two EOL-normalized files.', 'two-eol-files');
		addChange(store, 'src/one.py', 'first\r\nsecond\n', 'first updated\nsecond\n');
		addChange(store, 'src/two.py', 'alpha\nbeta\n', 'alpha updated\nbeta\n');
		store.closeForReview(transaction.id);
		const changes = [...transaction.changes.values()];
		const workspace = new MemoryMultiFileWorkspace(changes);
		workspace.files.set(changes[0].snapshot.uri.toString(), 'first\nsecond\n');
		workspace.files.set(changes[1].snapshot.uri.toString(), 'alpha\r\nbeta\r\n');
		const controller = new MultiFileEditController(
			workspace,
			new RecordingMultiFileDiffViewer(),
			store,
		);

		const applied = await controller.accept(transaction.id);

		assert.strictEqual(applied.status, 'applied');
		assert.strictEqual(workspace.applyCount, 1);
		assert.strictEqual(workspace.files.get(changes[0].snapshot.uri.toString()), changes[0].proposedContent);
		assert.strictEqual(workspace.files.get(changes[1].snapshot.uri.toString()), changes[1].proposedContent);
	});

	test('normalizes Windows proposal paths without changing snapshot identity', async () => {
		const adapter = new ProposalWorkspaceAdapter();
		adapter.add('pkg/greetings.py', 'def greet():\r\n    return "hello"\r\n');
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Update a Windows path.', 'windows-path');
		const tool = new ProposeEditTool(store, new WorkspaceBoundary(adapter));
		const result = await tool.run({
			edits: [{ new_str: '    return "hello, Agni"', old_str: '    return "hello"' }],
			path: 'pkg\\greetings.py',
			root: 'project',
		});
		assert.strictEqual(result.isError, undefined);
		store.closeForReview(transaction.id);
		const change = [...transaction.changes.values()][0];
		assert.strictEqual(change.snapshot.path, 'pkg/greetings.py');
		assert.strictEqual(
			change.snapshot.uri.toString(),
			vscode.Uri.joinPath(adapter.root.uri, 'pkg', 'greetings.py').toString(),
		);
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

	test('rejects genuine content changes even when line endings also change', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Reject a genuinely stale file.', 'genuine-stale');
		addChange(store, 'src/greetings.py', 'first\r\nsecond\n', 'first updated\nsecond\n');
		store.closeForReview(transaction.id);
		const change = [...transaction.changes.values()][0];
		const workspace = new MemoryMultiFileWorkspace([change]);
		workspace.files.set(change.snapshot.uri.toString(), 'first\nchanged externally\n');
		const controller = new MultiFileEditController(
			workspace,
			new RecordingMultiFileDiffViewer(),
			store,
		);

		await assert.rejects(
			controller.accept(transaction.id),
			(error: unknown) => error instanceof MultiFileStaleError,
		);
		assert.strictEqual(transaction.status, 'stale');
		assert.strictEqual(workspace.applyCount, 0);
	});

	test('revalidates approved plan scope immediately before applying edits', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin(
			'Apply only the approved file.',
			'apply-scope-check',
			[{ path: 'src/approved.ts', root: 'project' }],
		);
		addChange(store, 'src/approved.ts', 'old\n', 'new\n');
		store.closeForReview(transaction.id);
		const change = [...transaction.changes.values()][0];
		const workspace = new MemoryMultiFileWorkspace([change]);
		change.snapshot.path = 'src/outside.ts';
		const controller = new MultiFileEditController(
			workspace,
			new RecordingMultiFileDiffViewer(),
			store,
		);

		await assert.rejects(
			controller.accept(transaction.id),
			(error: unknown) => error instanceof MultiFilePlanScopeError,
		);
		assert.strictEqual(workspace.applyCount, 0);
		assert.strictEqual(transaction.status, 'review');
	});

	test('retains exact recovery history after a partial apply failure', async () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Recover a partial two-file application.', 'partial-apply-failure');
		addChange(store, 'src/one.py', 'one\n', 'one updated\n');
		addChange(store, 'src/two.py', 'two\n', 'two updated\n');
		store.closeForReview(transaction.id);
		const changes = [...transaction.changes.values()];
		const workspace = new PartiallyFailingWorkspace(changes);
		const controller = new MultiFileEditController(
			workspace,
			new RecordingMultiFileDiffViewer(),
			store,
		);

		await assert.rejects(
			controller.accept(transaction.id),
			(error: unknown) => error instanceof MultiFileStaleError
				&& /recovery history was retained/iu.test(error.message),
		);
		assert.strictEqual(transaction.status, 'applied');
		assert.strictEqual(store.getLastAppliedBatch()?.changes.length, 1);
		assert.strictEqual(workspace.files.get(changes[0].snapshot.uri.toString()), changes[0].proposedContent);
		assert.strictEqual(workspace.files.get(changes[1].snapshot.uri.toString()), changes[1].snapshot.content);

		const undone = await controller.undoLast();
		assert.strictEqual(undone.status, 'undone');
		assert.strictEqual(workspace.files.get(changes[0].snapshot.uri.toString()), changes[0].snapshot.content);
		assert.strictEqual(workspace.files.get(changes[1].snapshot.uri.toString()), changes[1].snapshot.content);
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
