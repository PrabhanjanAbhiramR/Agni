import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReadFileTool } from '../tools/readFile.js';
import { SearchCodeTool } from '../tools/searchCode.js';
import type { WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary, WorkspaceBoundaryError } from '../workspace/workspaceBoundary.js';

interface TestFile {
	openText?: string;
	text: string;
}

class TestWorkspaceAdapter implements WorkspaceAdapter {
	readonly files = new Map<string, TestFile>();

	constructor(private readonly folders: readonly vscode.WorkspaceFolder[]) {}

	addFile(uri: vscode.Uri, text: string, openText?: string): void {
		this.files.set(uri.toString(), { openText, text });
	}

	findFiles(
		_include: vscode.GlobPattern,
		_exclude: vscode.GlobPattern | null | undefined,
		maxResults: number,
	): Thenable<vscode.Uri[]> {
		return Promise.resolve([...this.files.keys()].slice(0, maxResults).map((value) => vscode.Uri.parse(value)));
	}

	getOpenDocumentText(uri: vscode.Uri): string | undefined {
		return this.files.get(uri.toString())?.openText;
	}

	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return this.folders;
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		const file = this.files.get(uri.toString());
		if (!file) {
			return Promise.reject(new Error(`Missing test file: ${uri.toString()}`));
		}

		return Promise.resolve(new TextEncoder().encode(file.text));
	}

	stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
		const file = this.files.get(uri.toString());
		if (file) {
			return Promise.resolve({
				ctime: 0,
				mtime: 0,
				size: new TextEncoder().encode(file.text).byteLength,
				type: vscode.FileType.File,
			});
		}

		const directoryPrefix = `${uri.toString().replace(/\/$/, '')}/`;
		if ([...this.files.keys()].some((value) => value.startsWith(directoryPrefix))) {
			return Promise.resolve({ ctime: 0, mtime: 0, size: 0, type: vscode.FileType.Directory });
		}

		return Promise.reject(new Error(`Missing test path: ${uri.toString()}`));
	}
}

function folder(name: string, fsPath: string, index = 0): vscode.WorkspaceFolder {
	return { index, name, uri: vscode.Uri.file(fsPath) };
}

suite('Workspace boundary and read-only tools', () => {
	test('rejects path traversal', () => {
		const adapter = new TestWorkspaceAdapter([folder('project', 'C:\\agni-test\\project')]);
		const boundary = new WorkspaceBoundary(adapter);

		assert.throws(
			() => boundary.resolve('project', '../secret.txt'),
			(error: unknown) => error instanceof WorkspaceBoundaryError && /traversal/.test(error.message),
		);
	});

	test('rejects invalid workspace roots', () => {
		const adapter = new TestWorkspaceAdapter([
			folder('one', 'C:\\agni-test\\one', 0),
			folder('two', 'C:\\agni-test\\two', 1),
		]);
		const boundary = new WorkspaceBoundary(adapter);

		assert.throws(
			() => boundary.resolve('missing', 'file.ts'),
			(error: unknown) => error instanceof WorkspaceBoundaryError && /Unknown workspace root/.test(error.message),
		);
	});

	test('reads unsaved editor contents inside the workspace', async () => {
		const root = folder('project', 'C:\\agni-test\\project');
		const adapter = new TestWorkspaceAdapter([root]);
		const uri = vscode.Uri.joinPath(root.uri, 'src', 'example.ts');
		adapter.addFile(uri, 'const value = "saved";', 'const value = "unsaved";');
		const result = await new ReadFileTool(new WorkspaceBoundary(adapter)).run({
			path: 'src/example.ts',
			root: 'project',
		});

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual(result.structuredContent?.content, 'const value = "unsaved";');
		assert.strictEqual(result.structuredContent?.fromOpenDocument, true);
	});

	test('limits search results', async () => {
		const root = folder('project', 'C:\\agni-test\\project');
		const adapter = new TestWorkspaceAdapter([root]);
		adapter.addFile(vscode.Uri.joinPath(root.uri, 'one.ts'), 'needle one');
		adapter.addFile(vscode.Uri.joinPath(root.uri, 'two.ts'), 'needle two');
		adapter.addFile(vscode.Uri.joinPath(root.uri, 'three.ts'), 'needle three');
		const result = await new SearchCodeTool(new WorkspaceBoundary(adapter)).run({
			maxResults: 2,
			query: 'needle',
			root: 'project',
		});

		assert.strictEqual(result.isError, undefined);
		assert.strictEqual((result.structuredContent?.matches as unknown[]).length, 2);
		assert.strictEqual(result.structuredContent?.truncated, true);
	});
});
