import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	InlineEditDecorationManager,
	type InlineEditDecorationEnvironment,
	inlineEditModeContextKey,
} from '../inlineEdit/inlineEditDecorations.js';

interface DecorationCall {
	ranges: readonly vscode.Range[];
	type: vscode.TextEditorDecorationType;
}

function fakeEditor(uri: vscode.Uri): { calls: DecorationCall[]; editor: vscode.TextEditor } {
	const calls: DecorationCall[] = [];
	const document = { uri } as vscode.TextDocument;
	return {
		calls,
		editor: {
			document,
			setDecorations: (type: vscode.TextEditorDecorationType, ranges: readonly vscode.Range[]) => {
				calls.push({ ranges: [...ranges], type });
			},
		} as vscode.TextEditor,
	};
}

class RecordingDecorationEnvironment implements InlineEditDecorationEnvironment, vscode.Disposable {
	private readonly changeDocumentEmitter = new vscode.EventEmitter<vscode.TextDocumentChangeEvent>();
	private readonly changeVisibleEditorsEmitter = new vscode.EventEmitter<readonly vscode.TextEditor[]>();
	private readonly closeDocumentEmitter = new vscode.EventEmitter<vscode.TextDocument>();
	readonly contextValues: Array<{ key: string; value: boolean }> = [];
	decorationDisposeCount = 0;
	visibleEditors: readonly vscode.TextEditor[] = [];
	readonly decorationType = {
		dispose: () => {
			this.decorationDisposeCount += 1;
		},
		key: 'agni-inline-edit-test-decoration',
	} as vscode.TextEditorDecorationType;

	createDecorationType(): vscode.TextEditorDecorationType {
		return this.decorationType;
	}

	executeCommand(command: string, ...rest: unknown[]): Thenable<unknown> {
		assert.strictEqual(command, 'setContext');
		this.contextValues.push({ key: String(rest[0]), value: Boolean(rest[1]) });
		return Promise.resolve(undefined);
	}

	getVisibleTextEditors(): readonly vscode.TextEditor[] {
		return this.visibleEditors;
	}

	onDidChangeTextDocument(
		listener: (event: vscode.TextDocumentChangeEvent) => unknown,
	): vscode.Disposable {
		return this.changeDocumentEmitter.event(listener);
	}

	onDidChangeVisibleTextEditors(
		listener: (editors: readonly vscode.TextEditor[]) => unknown,
	): vscode.Disposable {
		return this.changeVisibleEditorsEmitter.event(listener);
	}

	onDidCloseTextDocument(
		listener: (document: vscode.TextDocument) => unknown,
	): vscode.Disposable {
		return this.closeDocumentEmitter.event(listener);
	}

	changeDocument(document: vscode.TextDocument): void {
		this.changeDocumentEmitter.fire({ document } as vscode.TextDocumentChangeEvent);
	}

	changeVisibleEditors(editors: readonly vscode.TextEditor[]): void {
		this.visibleEditors = editors;
		this.changeVisibleEditorsEmitter.fire(editors);
	}

	closeDocument(document: vscode.TextDocument): void {
		this.closeDocumentEmitter.fire(document);
	}

	dispose(): void {
		this.changeDocumentEmitter.dispose();
		this.changeVisibleEditorsEmitter.dispose();
		this.closeDocumentEmitter.dispose();
	}
}

suite('Inline edit decorations', () => {
	test('highlights the target without changing document content and clears explicitly', () => {
		const environment = new RecordingDecorationEnvironment();
		const sourceText = 'const selected = true;';
		const source = fakeEditor(vscode.Uri.file('C:\\agni-decoration-test\\source.ts'));
		(source.editor.document as { getText?: () => string }).getText = () => sourceText;
		environment.visibleEditors = [source.editor];
		const manager = new InlineEditDecorationManager(environment);
		const range = new vscode.Range(0, 0, 0, sourceText.length);

		manager.show(source.editor, range);

		assert.deepStrictEqual(source.calls.at(-1)?.ranges, [range]);
		assert.strictEqual(source.editor.document.getText(), sourceText);
		assert.deepStrictEqual(environment.contextValues, [
			{ key: inlineEditModeContextKey, value: true },
		]);

		manager.clear();

		assert.deepStrictEqual(source.calls.at(-1)?.ranges, []);
		assert.deepStrictEqual(environment.contextValues.at(-1), {
			key: inlineEditModeContextKey,
			value: false,
		});
		manager.dispose();
		environment.dispose();
	});

	test('moves the highlight between visible editors for the same document', () => {
		const environment = new RecordingDecorationEnvironment();
		const uri = vscode.Uri.file('C:\\agni-decoration-test\\source.ts');
		const first = fakeEditor(uri);
		const second = fakeEditor(uri);
		const unrelated = fakeEditor(vscode.Uri.file('C:\\agni-decoration-test\\other.ts'));
		environment.visibleEditors = [first.editor];
		const manager = new InlineEditDecorationManager(environment);
		const range = new vscode.Range(2, 1, 3, 4);
		manager.show(first.editor, range);

		environment.changeVisibleEditors([second.editor, unrelated.editor]);

		assert.deepStrictEqual(first.calls.at(-1)?.ranges, []);
		assert.deepStrictEqual(second.calls.at(-1)?.ranges, [range]);
		assert.strictEqual(unrelated.calls.length, 0);
		assert.deepStrictEqual(environment.contextValues.at(-1), {
			key: inlineEditModeContextKey,
			value: true,
		});
		manager.dispose();
		environment.dispose();
	});

	test('clears safely when the target document changes or closes', () => {
		const environment = new RecordingDecorationEnvironment();
		const source = fakeEditor(vscode.Uri.file('C:\\agni-decoration-test\\source.ts'));
		const unrelated = fakeEditor(vscode.Uri.file('C:\\agni-decoration-test\\other.ts'));
		environment.visibleEditors = [source.editor];
		const manager = new InlineEditDecorationManager(environment);
		const range = new vscode.Range(0, 0, 0, 5);
		manager.show(source.editor, range);

		environment.changeDocument(unrelated.editor.document);
		assert.deepStrictEqual(source.calls.at(-1)?.ranges, [range]);

		environment.changeDocument(source.editor.document);
		assert.deepStrictEqual(source.calls.at(-1)?.ranges, []);
		assert.deepStrictEqual(environment.contextValues.at(-1), {
			key: inlineEditModeContextKey,
			value: false,
		});

		manager.show(source.editor, range);
		environment.closeDocument(source.editor.document);
		assert.deepStrictEqual(source.calls.at(-1)?.ranges, []);
		assert.deepStrictEqual(environment.contextValues.at(-1), {
			key: inlineEditModeContextKey,
			value: false,
		});
		manager.dispose();
		environment.dispose();
	});

	test('disposes decorations and listeners exactly once', () => {
		const environment = new RecordingDecorationEnvironment();
		const source = fakeEditor(vscode.Uri.file('C:\\agni-decoration-test\\source.ts'));
		environment.visibleEditors = [source.editor];
		const manager = new InlineEditDecorationManager(environment);
		const range = new vscode.Range(0, 0, 0, 5);
		manager.show(source.editor, range);

		manager.dispose();
		manager.dispose();
		const callCountAfterDisposal = source.calls.length;
		environment.changeVisibleEditors([source.editor]);

		assert.strictEqual(environment.decorationDisposeCount, 1);
		assert.strictEqual(source.calls.length, callCountAfterDisposal);
		assert.throws(() => manager.show(source.editor, range), /disposed/iu);
		environment.dispose();
	});
});
