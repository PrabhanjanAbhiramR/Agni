import * as vscode from 'vscode';

export const inlineEditModeContextKey = 'agni.inInlineEditMode';

export interface InlineEditDecorationEnvironment {
	createDecorationType(options: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType;
	executeCommand(command: string, ...rest: unknown[]): Thenable<unknown>;
	getVisibleTextEditors(): readonly vscode.TextEditor[];
	onDidChangeTextDocument(
		listener: (event: vscode.TextDocumentChangeEvent) => unknown,
	): vscode.Disposable;
	onDidChangeVisibleTextEditors(
		listener: (editors: readonly vscode.TextEditor[]) => unknown,
	): vscode.Disposable;
	onDidCloseTextDocument(
		listener: (document: vscode.TextDocument) => unknown,
	): vscode.Disposable;
}

const defaultEnvironment: InlineEditDecorationEnvironment = {
	createDecorationType: (options) => vscode.window.createTextEditorDecorationType(options),
	executeCommand: (command, ...rest) => vscode.commands.executeCommand(command, ...rest),
	getVisibleTextEditors: () => vscode.window.visibleTextEditors,
	onDidChangeTextDocument: (listener) => vscode.workspace.onDidChangeTextDocument(listener),
	onDidChangeVisibleTextEditors: (listener) => vscode.window.onDidChangeVisibleTextEditors(listener),
	onDidCloseTextDocument: (listener) => vscode.workspace.onDidCloseTextDocument(listener),
};

interface InlineEditDecorationTarget {
	range: vscode.Range;
	uri: string;
}

export class InlineEditDecorationManager implements vscode.Disposable {
	private readonly decoratedEditors = new Set<vscode.TextEditor>();
	private readonly decorationType: vscode.TextEditorDecorationType;
	private readonly subscriptions: vscode.Disposable[];
	private disposed = false;
	private target: InlineEditDecorationTarget | undefined;

	constructor(private readonly environment: InlineEditDecorationEnvironment = defaultEnvironment) {
		this.decorationType = environment.createDecorationType({
			backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
			isWholeLine: true,
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
		});
		this.subscriptions = [
			environment.onDidChangeVisibleTextEditors((editors) => this.syncVisibleEditors(editors)),
			environment.onDidChangeTextDocument((event) => {
				if (this.target?.uri === event.document.uri.toString()) {
					this.clear();
				}
			}),
			environment.onDidCloseTextDocument((document) => {
				if (this.target?.uri === document.uri.toString()) {
					this.clear();
				}
			}),
		];
	}

	show(editor: vscode.TextEditor, range: vscode.Range): void {
		if (this.disposed) {
			throw new Error('Cannot show an inline edit decoration after its manager was disposed.');
		}
		if (range.isEmpty) {
			throw new Error('Cannot decorate an empty inline edit range.');
		}

		this.removeDecorations();
		this.target = { range, uri: editor.document.uri.toString() };
		const visibleEditors = this.environment.getVisibleTextEditors();
		this.syncVisibleEditors(visibleEditors.includes(editor) ? visibleEditors : [...visibleEditors, editor]);
		void this.environment.executeCommand('setContext', inlineEditModeContextKey, true);
	}

	clear(): void {
		const wasActive = this.target !== undefined;
		this.target = undefined;
		this.removeDecorations();
		if (wasActive) {
			void this.environment.executeCommand('setContext', inlineEditModeContextKey, false);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.clear();
		this.disposed = true;
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.decorationType.dispose();
	}

	private removeDecorations(): void {
		for (const editor of this.decoratedEditors) {
			editor.setDecorations(this.decorationType, []);
		}
		this.decoratedEditors.clear();
	}

	private syncVisibleEditors(editors: readonly vscode.TextEditor[]): void {
		if (!this.target) {
			return;
		}

		const matchingEditors = new Set(
			editors.filter((editor) => editor.document.uri.toString() === this.target?.uri),
		);
		for (const editor of this.decoratedEditors) {
			if (!matchingEditors.has(editor)) {
				editor.setDecorations(this.decorationType, []);
				this.decoratedEditors.delete(editor);
			}
		}
		for (const editor of matchingEditors) {
			editor.setDecorations(this.decorationType, [this.target.range]);
			this.decoratedEditors.add(editor);
		}
	}
}
