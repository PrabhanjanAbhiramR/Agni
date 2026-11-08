import * as assert from 'assert';
import {
	createMultiFileHunks,
	materializeHunkDecisions,
} from '../multiFileEdit/multiFileHunks.js';

suite('Multi-file hunk generation', () => {
	test('creates deterministic independent hunks and materializes mixed decisions', () => {
		const original = 'start\nold one\nmiddle\nold two\nend\n';
		const proposed = 'start\nnew one\nmiddle\nnew two\nend\n';
		const first = createMultiFileHunks(original, proposed, 'project\0src/example.ts');
		const second = createMultiFileHunks(original, proposed, 'project\0src/example.ts');

		assert.strictEqual(first.length, 2);
		assert.deepStrictEqual(first.map((hunk) => hunk.id), second.map((hunk) => hunk.id));
		first[0].decision = 'accepted';
		first[1].decision = 'rejected';
		assert.strictEqual(
			materializeHunkDecisions(original, first, false),
			'start\nnew one\nmiddle\nold two\nend\n',
		);
	});

	test('handles insertions and deletions', () => {
		const insertionOriginal = 'alpha\nomega\n';
		const insertionProposed = 'alpha\ninserted\nomega\n';
		const insertion = createMultiFileHunks(insertionOriginal, insertionProposed, 'insert');
		assert.strictEqual(insertion.length, 1);
		assert.strictEqual(insertion[0].originalStart, insertion[0].originalEnd);
		insertion[0].decision = 'accepted';
		assert.strictEqual(materializeHunkDecisions(insertionOriginal, insertion, false), insertionProposed);

		const deletionOriginal = 'alpha\nremove me\nomega\n';
		const deletionProposed = 'alpha\nomega\n';
		const deletion = createMultiFileHunks(deletionOriginal, deletionProposed, 'delete');
		assert.strictEqual(deletion.length, 1);
		assert.strictEqual(deletion[0].replacementText, '');
		deletion[0].decision = 'accepted';
		assert.strictEqual(materializeHunkDecisions(deletionOriginal, deletion, false), deletionProposed);
	});

	test('preserves CRLF and Unicode outside and inside accepted hunks', () => {
		const original = 'const face = "😀";\r\nconst value = "old";\r\nconst tail = "é";\r\n';
		const proposed = 'const face = "🚀";\r\nconst value = "old";\r\nconst tail = "é";\r\n';
		const hunks = createMultiFileHunks(original, proposed, 'unicode-crlf');
		assert.strictEqual(hunks.length, 1);
		hunks[0].decision = 'accepted';
		const materialized = materializeHunkDecisions(original, hunks, false);
		assert.strictEqual(materialized, proposed);
		assert.strictEqual(materialized.includes('\r\n'), true);
		assert.strictEqual(materialized.includes('é'), true);
	});

	test('shows pending hunks in review without applying them', () => {
		const original = 'old\n';
		const proposed = 'new\n';
		const hunks = createMultiFileHunks(original, proposed, 'pending');
		assert.strictEqual(materializeHunkDecisions(original, hunks, true), proposed);
		assert.strictEqual(materializeHunkDecisions(original, hunks, false), original);
	});
});
