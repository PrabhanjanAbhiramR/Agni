import * as assert from 'assert';
import { TrueForge } from '@truefoundry/trueforge-sdk';
import { AgniMcpHttpHost } from '../mcp/httpMcpHost.js';
import {
	registerWorkspaceConnector,
	runWorkspaceAgentTurn,
	verifyWorkspaceConnectorTools,
} from '../trueforge/workspaceAgent.js';

const integrationTest = process.env.AGNI_RUN_TRUEFORGE_INTEGRATION === '1' ? test : test.skip;

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
});
