import * as assert from 'assert';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { agniWorkspaceToolNames } from '../mcp/agniMcpServer.js';
import { AgniMcpHttpHost } from '../mcp/httpMcpHost.js';
import {
	agniWorkspaceConnectorName,
	startAndRegisterWorkspaceConnector,
} from '../trueforge/workspaceAgent.js';
import type { WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

interface RecordedConnectorRegistration {
	manifest: {
		auth: {
			headers: Record<string, string>;
			type: string;
		};
		name: string;
		type: string;
		url: string;
	};
}

function createRecordingClient(registrations: RecordedConnectorRegistration[]): TrueForge {
	return {
		settings: {
			mcpServers: {
				createOrUpdate: (request: RecordedConnectorRegistration): Promise<{ data: unknown }> => {
					registrations.push(request);
					return Promise.resolve({ data: {} });
				},
			},
		},
	} as unknown as TrueForge;
}

function mcpRequest(authorization: string): RequestInit {
	return {
		body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
		headers: {
			Accept: 'application/json, text/event-stream',
			Authorization: authorization,
			'Content-Type': 'application/json',
		},
		method: 'POST',
	};
}

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

	test('registers the live endpoint and bearer credential with TrueForge', async () => {
		const registrations: RecordedConnectorRegistration[] = [];
		const client = createRecordingClient(registrations);
		const host = new AgniMcpHttpHost(new WorkspaceBoundary(new EmptyWorkspaceAdapter()));

		try {
			const endpoint = await startAndRegisterWorkspaceConnector(client, host);
			assert.strictEqual(registrations.length, 1);
			const registration = registrations[0];
			assert.strictEqual(registration.manifest.name, agniWorkspaceConnectorName);
			assert.strictEqual(registration.manifest.type, 'remote');
			assert.strictEqual(registration.manifest.url, endpoint.url);
			assert.strictEqual(registration.manifest.auth.type, 'header');
			assert.match(registration.manifest.auth.headers.Authorization, /^Bearer [A-Za-z0-9_-]+$/u);
			assert.deepStrictEqual(await host.listToolNames(), [...agniWorkspaceToolNames].sort());
		} finally {
			await host.stop();
		}
	});

	test('re-registers a restarted endpoint with a new credential and cleans it up', async () => {
		const registrations: RecordedConnectorRegistration[] = [];
		const client = createRecordingClient(registrations);
		const host = new AgniMcpHttpHost(new WorkspaceBoundary(new EmptyWorkspaceAdapter()));

		try {
			const firstEndpoint = await startAndRegisterWorkspaceConnector(client, host);
			const firstAuthorization = registrations[0].manifest.auth.headers.Authorization;
			await host.stop();
			await assert.rejects(fetch(firstEndpoint.url));

			const secondEndpoint = await startAndRegisterWorkspaceConnector(client, host);
			const secondRegistration = registrations[1];
			const secondAuthorization = secondRegistration.manifest.auth.headers.Authorization;
			assert.strictEqual(registrations.length, 2);
			assert.strictEqual(secondRegistration.manifest.url, secondEndpoint.url);
			assert.notStrictEqual(secondAuthorization, firstAuthorization);

			const staleCredential = await fetch(secondEndpoint.url, mcpRequest(firstAuthorization));
			assert.strictEqual(staleCredential.status, 401);
			assert.deepStrictEqual(await host.listToolNames(), [...agniWorkspaceToolNames].sort());

			await host.stop();
			await assert.rejects(fetch(secondEndpoint.url, mcpRequest(secondAuthorization)));
		} finally {
			await host.stop();
		}
	});
});
