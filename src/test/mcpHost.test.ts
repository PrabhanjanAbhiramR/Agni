import * as assert from 'assert';
import * as vscode from 'vscode';
import { agniWorkspaceToolNames } from '../mcp/agniMcpServer.js';
import { AgniMcpHttpHost } from '../mcp/httpMcpHost.js';
import type { WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

class EmptyWorkspaceAdapter implements WorkspaceAdapter {
	private readonly root: vscode.WorkspaceFolder = {
		index: 0,
		name: 'project',
		uri: vscode.Uri.file('C:\\agni-mcp-test\\project'),
	};

	findFiles(): Thenable<vscode.Uri[]> {
		return Promise.resolve([]);
	}

	getOpenDocumentText(): string | undefined {
		return undefined;
	}

	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return [this.root];
	}

	readFile(): Thenable<Uint8Array> {
		return Promise.reject(new Error('No test files are configured.'));
	}

	stat(): Thenable<vscode.FileStat> {
		return Promise.reject(new Error('No test paths are configured.'));
	}
}

suite('Agni MCP HTTP host', () => {
	test('binds to loopback, requires authentication, and exposes workspace tools', async () => {
		const errors: Error[] = [];
		const boundary = new WorkspaceBoundary(new EmptyWorkspaceAdapter());
		const host = new AgniMcpHttpHost(boundary, (error) => errors.push(error));

		try {
			const endpoint = await host.start();
			assert.match(endpoint.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
			assert.ok(endpoint.port > 0);

			const unauthorized = await fetch(endpoint.url, {
				body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
				headers: {
					Accept: 'application/json, text/event-stream',
					'Content-Type': 'application/json',
				},
				method: 'POST',
			});
			assert.strictEqual(unauthorized.status, 401);

			const toolNames = await host.listToolNames();
			assert.deepStrictEqual(toolNames, [...agniWorkspaceToolNames].sort());
			assert.deepStrictEqual(errors, []);

			await host.stop();
			await assert.rejects(fetch(endpoint.url));
		} finally {
			await host.stop();
		}
	});
});
