import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { MultiFileProposalStore, multiFileChangeKey } from '../multiFileEdit/multiFileProposal.js';
import { normalizeGeneratedSourceContent } from '../tools/generatedSourceContent.js';
import { ProposeWriteTool } from '../tools/proposeWrite.js';
import { type WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

class SourceProposalAdapter implements WorkspaceAdapter {
	private readonly files = new Map<string, string>();
	private readonly root: vscode.WorkspaceFolder = {
		index: 0,
		name: 'project',
		uri: vscode.Uri.file('C:\\agni-generated-source\\project'),
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
			return Promise.resolve({ ctime: 0, mtime: 0, size: content.length, type: vscode.FileType.File });
		}
		return Promise.resolve({ ctime: 0, mtime: 0, size: 0, type: vscode.FileType.Directory });
	}
}

suite('Generated source content', () => {
	test('normalizes Python triple-quote delimiters while preserving ordinary string escapes and newlines', () => {
		const generated = '\\"\\"\\"This module contains basic calculation utilities.\\"\\"\\"\r\n'
			+ '\r\nmessage = "She said \\"hello\\""\r\n';
		const expected = '"""This module contains basic calculation utilities."""\r\n'
			+ '\r\nmessage = "She said \\"hello\\""\r\n';

		const normalized = normalizeGeneratedSourceContent('src/calculations.py', generated);

		assert.strictEqual(normalized.normalizedPythonTripleQuotes, true);
		assert.strictEqual(normalized.content, expected);
		assert.match(normalized.content, /^"""This module/gu);
		assert.match(normalized.content, /She said \\"hello\\"/gu);
		assert.ok(normalized.content.includes('\r\n\r\n'));
	});

	test('does not alter escaped quote sequences inside ordinary strings or comments', () => {
		const source = 'value = "literal \\"\\"\\" text"\n# keep \\"\\"\\" in this comment\n';
		const normalized = normalizeGeneratedSourceContent('src/literals.py', source);
		assert.strictEqual(normalized.normalizedPythonTripleQuotes, false);
		assert.strictEqual(normalized.content, source);
	});

	test('does not alter non-Python source content', () => {
		const source = 'const value = "\\"\\"\\"";\n';
		assert.deepStrictEqual(normalizeGeneratedSourceContent('src/value.ts', source), {
			content: source,
			normalizedPythonTripleQuotes: false,
		});
	});

	test('records two proposals with valid Python delimiters and exact ordinary escapes', async () => {
		const adapter = new SourceProposalAdapter();
		adapter.add('first.py', 'old first\n');
		adapter.add('second.py', 'old second\n');
		const store = new MultiFileProposalStore();
		store.begin('Update two Python modules.', 'python-multi-file', [
			{ path: 'first.py', root: 'project' },
			{ path: 'second.py', root: 'project' },
		]);
		const tool = new ProposeWriteTool(store, new WorkspaceBoundary(adapter));
		const first = '\\"\\"\\"First module.\\"\\"\\"\n\ndef first():\n    return 1\n';
		const second = '\\"\\"\\"Second module.\\"\\"\\"\n\ndef quote():\n    return "She said \\"hello\\""\n';

		const firstResult = await tool.run({ content: first, path: 'first.py', root: 'project' });
		const secondResult = await tool.run({ content: second, path: 'second.py', root: 'project' });

		assert.strictEqual(firstResult.isError, undefined);
		assert.strictEqual(secondResult.isError, undefined);
		const transaction = store.require('python-multi-file');
		assert.strictEqual(transaction.changes.size, 2);
		assert.strictEqual(
			transaction.changes.get(multiFileChangeKey('project', 'first.py'))?.proposedContent,
			'"""First module."""\n\ndef first():\n    return 1\n',
		);
		assert.strictEqual(
			transaction.changes.get(multiFileChangeKey('project', 'second.py'))?.proposedContent,
			'"""Second module."""\n\ndef quote():\n    return "She said \\"hello\\""\n',
		);
	});
});
