import * as assert from 'assert';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { AgniMcpHttpHost } from '../mcp/httpMcpHost.js';
import { MultiFileProposalStore } from '../multiFileEdit/multiFileProposal.js';
import { runMultiFileAgentTurn } from '../trueforge/multiFileEditAgent.js';
import { standaloneAgniAgentName } from '../trueforge/standaloneAgentDefinition.js';
import {
	registerWorkspaceConnector,
	runWorkspaceAgentTurn,
	startAndRegisterWorkspaceConnector,
	verifyWorkspaceConnectorTools,
} from '../trueforge/workspaceAgent.js';

const integrationTest = process.env.AGNI_RUN_TRUEFORGE_INTEGRATION === '1' ? test : test.skip;
const approvalIntegrationTest = process.env.AGNI_RUN_TRUEFORGE_APPROVAL_INTEGRATION === '1'
	? test
	: test.skip;

suite('TrueForge Extension Host integration', () => {
	integrationTest('registers MCP and completes a real workspace tool call', async function () {
		this.timeout(600_000);
		const serverUrl = process.env.AGNI_TRUEFORGE_SERVER_URL?.trim() || 'http://localhost:8790';
		const preferredModel = process.env.AGNI_TRUEFORGE_MODEL?.trim();
		const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
		const host = new AgniMcpHttpHost();

		try {
			const { data: models } = await client.models.list();
			assert.ok(models.length > 0, 'TrueForge must have at least one configured model.');
			const model = preferredModel
				? models.find((candidate) => candidate.name === preferredModel)
				: models[0];
			assert.ok(model, `Configured integration model was not returned by ${serverUrl}.`);

			await registerWorkspaceConnector(client, host);
			const tools = await verifyWorkspaceConnectorTools(client);
			assert.ok(tools.includes('read_file'));

			const result = await runWorkspaceAgentTurn(
				client,
				model.name,
				[
					'You must call the read_file tool with path "package.json" before answering.',
					'Report the exact value of the top-level name property from that file.',
					'Do not answer without using the tool.',
				].join(' '),
			);

			assert.strictEqual(result.toolName, 'read_file');
			const toolResponse = JSON.parse(result.toolResponse) as { content?: unknown };
			if (typeof toolResponse.content !== 'string') {
				assert.fail('read_file must return string content.');
			}
			assert.match(toolResponse.content, /"name"\s*:\s*"forge-agent"/u);
			assert.match(result.answer, /forge-agent/iu);
			assert.strictEqual(result.turnStatus, 'done');
		} finally {
			await host.stop();
		}
	});

	integrationTest('refreshes the connector before a real named-agent workspace turn', async function () {
		this.timeout(600_000);
		const serverUrl = process.env.AGNI_TRUEFORGE_SERVER_URL?.trim() || 'http://localhost:8790';
		const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
		const host = new AgniMcpHttpHost(undefined, undefined, new MultiFileProposalStore());

		try {
			const { data: agents } = await client.agents.list({
				agentName: standaloneAgniAgentName,
				limit: 100,
			});
			assert.ok(
				agents.some((agent) => agent.name === standaloneAgniAgentName),
				`Register ${standaloneAgniAgentName} before running the live integration test.`,
			);

			const { data: session } = await client.sessions.create({
				agent: { name: standaloneAgniAgentName },
			});
			// Session creation does not connect MCP. Refresh after creation to prove
			// that the turn resolves the connector's latest persisted settings.
			await startAndRegisterWorkspaceConnector(client, host);
			const stream = await client.sessions.createTurnStream(session.id, {
				input: [{
					content: [
						'Call read_file with path "package.json" before answering.',
						'Report the exact top-level name property. Do not propose any edits.',
					].join(' '),
					type: 'user.message',
				}],
			});
			let answer = '';
			let initialized = false;
			let receivedToolResponse = false;
			let turnStatus: string | undefined;
			for await (const event of stream) {
				if (event.type === 'mcp.initialize'
					&& event.mcpServers.some((server) => server.name === 'agni-vscode-workspace')) {
					initialized = true;
				}
				if (event.type === 'tool.response') {
					receivedToolResponse = true;
				}
				if (event.type === 'model.message.delta' && event.threadId === 'main' && event.content) {
					answer += event.content;
				}
				if (event.type === 'turn.done') {
					turnStatus = event.state.status;
				}
			}

			assert.ok(initialized, 'The named agent must initialize the refreshed Agni MCP connector.');
			assert.ok(receivedToolResponse, 'The named agent must receive a workspace tool response.');
			assert.match(answer, /forge-agent/iu);
			assert.strictEqual(turnStatus, 'done');
		} finally {
			await host.stop();
		}
	});

	approvalIntegrationTest('handles real propose_write approval and denial without applying files', async function () {
		this.timeout(600_000);
		const serverUrl = process.env.AGNI_TRUEFORGE_SERVER_URL?.trim() || 'http://localhost:8790';
		const preferredModel = process.env.AGNI_TRUEFORGE_MODEL?.trim();
		const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
		const store = new MultiFileProposalStore();
		const host = new AgniMcpHttpHost(undefined, undefined, store);

		try {
			const { data: models } = await client.models.list();
			const model = preferredModel
				? models.find((candidate) => candidate.name === preferredModel)
				: models[0];
			assert.ok(model, `A configured integration model was not returned by ${serverUrl}.`);
			await startAndRegisterWorkspaceConnector(client, host);

			const approved = store.begin('Prepare one proposal for the live approval test.', 'live-approved');
			let approvalCount = 0;
			const approvedResult = await runMultiFileAgentTurn(
				client,
				model.name,
				[
					'Call propose_write exactly once for path "agni-live-approval-test.txt".',
					'Use complete content "Agni approval test\\n" and do not modify any other file.',
				].join(' '),
				approved.id,
				store,
				new vscode.CancellationTokenSource().token,
				{
					onToolApprovalRequired: async () => {
						approvalCount += 1;
						return { status: 'allow' };
					},
				},
			);
			assert.ok(approvalCount > 0, 'TrueForge must emit tool.approval_required before propose_write.');
			assert.strictEqual(approvedResult.transaction.status, 'review');
			assert.strictEqual(approvedResult.transaction.changes.size, 1);
			assert.strictEqual(store.getLastAppliedBatch(), undefined);
			store.reject(approved.id);

			const denied = store.begin('Attempt one proposal for the live denial test.', 'live-denied');
			let denialCount = 0;
			await assert.rejects(runMultiFileAgentTurn(
				client,
				model.name,
				[
					'Call propose_write exactly once for path "agni-live-denial-test.txt".',
					'Use complete content "This proposal must be denied.\\n".',
				].join(' '),
				denied.id,
				store,
				new vscode.CancellationTokenSource().token,
				{
					onToolApprovalRequired: async () => {
						denialCount += 1;
						return { reason: 'Denied by the Agni live integration test.', status: 'deny' };
					},
				},
			), /without proposing any file changes/u);
			assert.ok(denialCount > 0, 'TrueForge must emit tool.approval_required before denial.');
			assert.strictEqual(store.require(denied.id).status, 'cancelled');
			assert.strictEqual(store.getLastAppliedBatch(), undefined);
		} finally {
			const active = store.getActive();
			if (active?.status === 'generating') {
				store.cancel(active.id);
			} else if (active?.status === 'review') {
				store.reject(active.id);
			}
			await host.stop();
		}
	});
});
