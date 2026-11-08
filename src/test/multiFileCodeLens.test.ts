import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	acceptMultiFileHunkCommandId,
	MultiFileEditCodeLensProvider,
	type MultiFileHunkCommandTarget,
	rejectMultiFileHunkCommandId,
} from '../multiFileEdit/multiFileCodeLens.js';
import { createMultiFileDiffUri } from '../multiFileEdit/multiFileDiff.js';
import {
	contentHash,
	multiFileChangeKey,
	MultiFileProposalStore,
	type MultiFileTransaction,
} from '../multiFileEdit/multiFileProposal.js';

function codeLensFixture(): {
	changeKey: string;
	provider: MultiFileEditCodeLensProvider;
	store: MultiFileProposalStore;
	transaction: MultiFileTransaction;
	uri: vscode.Uri;
} {
	const store = new MultiFileProposalStore();
	const transaction = store.begin('Update two separated sections.', 'stable-transaction');
	const original = [
		'const first = 1;',
		'keep();',
		'const last = 3;',
		'',
	].join('\n');
	const proposed = [
		'const first = 10;',
		'const inserted = 11;',
		'keep();',
		'const last = 30;',
		'',
	].join('\n');
	const root = 'project';
	const path = 'src/example.ts';
	store.propose({
		content: original,
		exists: true,
		hash: contentHash(original),
		path,
		root,
		uri: vscode.Uri.file('C:\\agni-code-lens-test\\project\\src\\example.ts'),
	}, proposed);
	store.closeForReview(transaction.id);
	return {
		changeKey: multiFileChangeKey(root, path),
		provider: new MultiFileEditCodeLensProvider(store),
		store,
		transaction,
		uri: createMultiFileDiffUri(transaction.id, root, path, 'after'),
	};
}

function document(uri: vscode.Uri): vscode.TextDocument {
	return { uri } as vscode.TextDocument;
}

function provide(fixture: ReturnType<typeof codeLensFixture>, uri = fixture.uri): vscode.CodeLens[] {
	return fixture.provider.provideCodeLenses(
		document(uri),
		new vscode.CancellationTokenSource().token,
	);
}

suite('Multi-file edit CodeLens', () => {
	test('anchors Accept and Reject actions to materialized review hunks', () => {
		const fixture = codeLensFixture();
		const lenses = provide(fixture);

		assert.strictEqual(lenses.length, 4);
		assert.deepStrictEqual(lenses.map((lens) => lens.range.start.line), [0, 0, 3, 3]);
		assert.deepStrictEqual(lenses.map((lens) => lens.command?.command), [
			acceptMultiFileHunkCommandId,
			rejectMultiFileHunkCommandId,
			acceptMultiFileHunkCommandId,
			rejectMultiFileHunkCommandId,
		]);

		const firstHunk = fixture.transaction.changes.get(fixture.changeKey)?.hunks[0];
		assert.ok(firstHunk);
		const target = lenses[0].command?.arguments?.[0] as MultiFileHunkCommandTarget;
		assert.deepStrictEqual(target, {
			changeKey: fixture.changeKey,
			hunkId: firstHunk.id,
			transactionId: fixture.transaction.id,
		});
		assert.strictEqual(Object.isFrozen(target), true);
		fixture.provider.dispose();
		fixture.store.dispose();
	});

	test('keeps stable identifiers while placement follows review materialization', () => {
		const fixture = codeLensFixture();
		const change = fixture.transaction.changes.get(fixture.changeKey);
		assert.ok(change);
		const secondHunkId = change.hunks[1].id;
		const before = provide(fixture);
		const beforeTarget = before[2].command?.arguments?.[0] as MultiFileHunkCommandTarget;

		fixture.store.setHunkDecision(
			fixture.transaction.id,
			fixture.changeKey,
			change.hunks[0].id,
			'rejected',
		);
		const after = provide(fixture);
		const afterTarget = after[2].command?.arguments?.[0] as MultiFileHunkCommandTarget;

		assert.strictEqual(before[2].range.start.line, 3);
		assert.strictEqual(after[2].range.start.line, 2);
		assert.strictEqual(beforeTarget.hunkId, secondHunkId);
		assert.deepStrictEqual(afterTarget, beforeTarget);
		fixture.provider.dispose();
		fixture.store.dispose();
	});

	test('refreshes for hunk, file, and transaction review changes', () => {
		const fixture = codeLensFixture();
		const change = fixture.transaction.changes.get(fixture.changeKey);
		assert.ok(change);
		let refreshCount = 0;
		const subscription = fixture.provider.onDidChangeCodeLenses(() => {
			refreshCount += 1;
		});

		fixture.store.setHunkDecision(
			fixture.transaction.id,
			fixture.changeKey,
			change.hunks[0].id,
			'accepted',
		);
		fixture.store.setFileDecision(fixture.transaction.id, fixture.changeKey, 'rejected');
		fixture.store.reject(fixture.transaction.id);

		assert.strictEqual(refreshCount, 3);
		assert.deepStrictEqual(provide(fixture), []);
		subscription.dispose();
		fixture.provider.dispose();
		fixture.store.dispose();
	});

	test('ignores before documents and releases its store listener on disposal', () => {
		const fixture = codeLensFixture();
		const referenceChange = fixture.transaction.changes.get(fixture.changeKey);
		assert.ok(referenceChange);
		const beforeUri = createMultiFileDiffUri(
			fixture.transaction.id,
			referenceChange.snapshot.root,
			referenceChange.snapshot.path,
			'before',
		);
		assert.deepStrictEqual(provide(fixture, beforeUri), []);

		let refreshCount = 0;
		fixture.provider.onDidChangeCodeLenses(() => {
			refreshCount += 1;
		});
		fixture.provider.dispose();
		fixture.provider.dispose();
		fixture.store.setHunkDecision(
			fixture.transaction.id,
			fixture.changeKey,
			referenceChange.hunks[0].id,
			'accepted',
		);

		assert.strictEqual(refreshCount, 0);
		assert.deepStrictEqual(provide(fixture), []);
		fixture.store.dispose();
	});
});
