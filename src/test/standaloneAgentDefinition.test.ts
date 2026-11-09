import * as assert from 'node:assert';
import { readFile } from 'node:fs/promises';
import { type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { agniMultiFileToolNames } from '../mcp/agniMcpServer.js';
import {
	createStandaloneAgniAgentDefinition,
	standaloneAgniAgentName,
	standaloneAgniConnectorName,
	standaloneAgniModelPlaceholder,
	standaloneAgniToolNames,
} from '../trueforge/standaloneAgentDefinition.js';
import { agniWorkspaceConnectorName } from '../trueforge/workspaceAgent.js';

async function readJson(relativePath: string): Promise<unknown> {
	const path = new URL(`../../trueforge/${relativePath}`, import.meta.url);
	return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function requireAgentDefinition(value: unknown): TrueForgeApi.CreateAgentRequest {
	assert.ok(typeof value === 'object' && value !== null);
	const candidate = value as Record<string, unknown>;
	assert.strictEqual(typeof candidate.name, 'string');
	assert.strictEqual(typeof candidate.description, 'string');
	assert.ok(typeof candidate.manifest === 'object' && candidate.manifest !== null);
	return candidate as unknown as TrueForgeApi.CreateAgentRequest;
}

suite('Standalone TrueForge agent definition', () => {
	test('matches the serializable checked-in definition and SDK request type', async () => {
		const checkedIn = requireAgentDefinition(await readJson('agni-agent.json'));
		const expected = createStandaloneAgniAgentDefinition('configured-provider/configured-model');
		const substituted = structuredClone(checkedIn);
		substituted.manifest.model.name = 'configured-provider/configured-model';

		assert.deepStrictEqual(substituted, expected);
		assert.strictEqual(expected.name, standaloneAgniAgentName);
		assert.doesNotThrow(() => JSON.stringify(expected));
	});

	test('matches the extension connector and tool contract', () => {
		assert.strictEqual(standaloneAgniConnectorName, agniWorkspaceConnectorName);
		assert.deepStrictEqual(standaloneAgniToolNames, agniMultiFileToolNames);
	});

	test('contains no credentials, tokens, or endpoint URLs', async () => {
		const serialized = JSON.stringify(await readJson('agni-agent.json'));
		assert.ok(!/api[_-]?key/iu.test(serialized));
		assert.ok(!/authorization|bearer/iu.test(serialized));
		assert.ok(!/https?:\/\//iu.test(serialized));
	});

	test('requires callers to replace the model placeholder', () => {
		assert.throws(
			() => createStandaloneAgniAgentDefinition(standaloneAgniModelPlaceholder),
			/ configured TrueForge model FQN /u,
		);
		assert.throws(
			() => createStandaloneAgniAgentDefinition('   '),
			/ configured TrueForge model FQN /u,
		);
	});

	test('provides a credential-free model selection example', async () => {
		const value = await readJson('model.example.json');
		assert.deepStrictEqual(value, {
			modelFqn: standaloneAgniModelPlaceholder,
			serverUrl: 'http://localhost:8790',
		});
	});
});
