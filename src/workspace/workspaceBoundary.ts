import * as vscode from 'vscode';
import { vscodeWorkspaceAdapter, type WorkspaceAdapter } from './workspaceAccess.js';

export interface WorkspaceRoot {
	id: string;
	name: string;
	uri: vscode.Uri;
}

export interface ResolvedWorkspacePath {
	relativePath: string;
	root: WorkspaceRoot;
	uri: vscode.Uri;
}

export class WorkspaceBoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkspaceBoundaryError';
	}
}

function comparableUriPath(uri: vscode.Uri): string {
	const value = uri.path.replace(/\/$/, '');
	return uri.scheme === 'file' && process.platform === 'win32'
		? value.toLowerCase()
		: value;
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith('/')
		|| value.startsWith('\\')
		|| /^[a-zA-Z]:[\\/]/.test(value)
		|| /^\\\\/.test(value);
}

export class WorkspaceBoundary {
	constructor(public readonly adapter: WorkspaceAdapter = vscodeWorkspaceAdapter) {}

	listRoots(): WorkspaceRoot[] {
		const folders = this.adapter.getWorkspaceFolders();
		const nameCounts = new Map<string, number>();

		for (const folder of folders) {
			nameCounts.set(folder.name, (nameCounts.get(folder.name) ?? 0) + 1);
		}

		return folders.map((folder) => ({
			id: nameCounts.get(folder.name) === 1 ? folder.name : `${folder.index}:${folder.name}`,
			name: folder.name,
			uri: folder.uri,
		}));
	}

	resolve(rootId: string | undefined, relativePath: string): ResolvedWorkspacePath {
		const root = this.resolveRoot(rootId);
		const normalizedPath = this.normalizeRelativePath(relativePath);
		const uri = normalizedPath.length === 0
			? root.uri
			: vscode.Uri.joinPath(root.uri, ...normalizedPath.split('/'));

		if (!this.contains(root, uri)) {
			throw new WorkspaceBoundaryError(`Path escapes workspace root "${root.id}".`);
		}

		return { relativePath: normalizedPath, root, uri };
	}

	resolveRoot(rootId?: string): WorkspaceRoot {
		const roots = this.listRoots();
		if (roots.length === 0) {
			throw new WorkspaceBoundaryError('No workspace folder is open.');
		}

		if (!rootId) {
			if (roots.length === 1) {
				return roots[0];
			}

			throw new WorkspaceBoundaryError(
				`A workspace root is required. Available roots: ${roots.map((root) => root.id).join(', ')}.`,
			);
		}

		const exact = roots.find((root) => root.id === rootId);
		if (exact) {
			return exact;
		}

		const named = roots.filter((root) => root.name === rootId);
		if (named.length === 1) {
			return named[0];
		}

		throw new WorkspaceBoundaryError(
			`Unknown workspace root "${rootId}". Available roots: ${roots.map((root) => root.id).join(', ')}.`,
		);
	}

	normalizeRelativePath(relativePath: string): string {
		if (relativePath.includes('\0')) {
			throw new WorkspaceBoundaryError('Paths cannot contain NUL characters.');
		}

		if (isAbsolutePath(relativePath)) {
			throw new WorkspaceBoundaryError('Only workspace-relative paths are allowed.');
		}

		const segments = relativePath.replace(/\\/g, '/').split('/');
		if (segments.some((segment) => segment === '..')) {
			throw new WorkspaceBoundaryError('Path traversal using ".." is not allowed.');
		}

		return segments.filter((segment) => segment.length > 0 && segment !== '.').join('/');
	}

	normalizeGlob(glob: string): string {
		if (glob.includes('\0') || isAbsolutePath(glob)) {
			throw new WorkspaceBoundaryError('Only workspace-relative glob patterns are allowed.');
		}

		const normalized = glob.replace(/\\/g, '/');
		if (normalized.split('/').some((segment) => segment === '..')) {
			throw new WorkspaceBoundaryError('Glob traversal using ".." is not allowed.');
		}

		return normalized || '**/*';
	}

	relativePath(root: WorkspaceRoot, uri: vscode.Uri): string {
		if (!this.contains(root, uri)) {
			throw new WorkspaceBoundaryError(`URI is outside workspace root "${root.id}".`);
		}

		const rootPath = root.uri.path.replace(/\/$/, '');
		return uri.path.slice(rootPath.length).replace(/^\//, '');
	}

	async assertNoSymbolicLinks(path: ResolvedWorkspacePath): Promise<void> {
		if (!path.relativePath) {
			return;
		}

		let current = path.root.uri;
		for (const segment of path.relativePath.split('/')) {
			current = vscode.Uri.joinPath(current, segment);
			const stat = await this.adapter.stat(current);
			if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
				throw new WorkspaceBoundaryError(`Symbolic links are not allowed: ${path.relativePath}.`);
			}
		}
	}

	private contains(root: WorkspaceRoot, uri: vscode.Uri): boolean {
		if (root.uri.scheme !== uri.scheme || root.uri.authority !== uri.authority) {
			return false;
		}

		const rootPath = comparableUriPath(root.uri);
		const candidatePath = comparableUriPath(uri);
		return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
	}
}
