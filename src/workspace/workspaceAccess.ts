import * as vscode from 'vscode';

export interface WorkspaceAdapter {
	findFiles(
		include: vscode.GlobPattern,
		exclude: vscode.GlobPattern | null | undefined,
		maxResults: number,
		token?: vscode.CancellationToken,
	): Thenable<vscode.Uri[]>;
	getOpenDocumentText(uri: vscode.Uri): string | undefined;
	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[];
	readFile(uri: vscode.Uri): Thenable<Uint8Array>;
	stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
}

export const vscodeWorkspaceAdapter: WorkspaceAdapter = {
	findFiles: (include, exclude, maxResults, token) => vscode.workspace.findFiles(include, exclude, maxResults, token),
	getOpenDocumentText: (uri) => vscode.workspace.textDocuments
		.find((document) => document.uri.toString() === uri.toString())
		?.getText(),
	getWorkspaceFolders: () => vscode.workspace.workspaceFolders ?? [],
	readFile: (uri) => vscode.workspace.fs.readFile(uri),
	stat: (uri) => vscode.workspace.fs.stat(uri),
};
