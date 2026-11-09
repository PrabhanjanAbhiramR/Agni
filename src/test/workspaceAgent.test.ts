import * as assert from 'assert';
import { agniWorkspaceToolNames } from '../mcp/agniMcpServer.js';
import {
	agniWorkspaceConnectorName,
	buildWorkspaceTurnInput,
	createWorkspaceAgentSpec,
} from '../trueforge/workspaceAgent.js';
import { agniMultiFileToolNames } from '../mcp/agniMcpServer.js';
import { createMultiFileAgentSpec } from '../trueforge/multiFileEditAgent.js';

suite('TrueForge workspace agent configuration', () => {
	test('attaches only the configured Agni read-only MCP tools', () => {
		const spec = createWorkspaceAgentSpec('discovered/model-fqn');

		assert.strictEqual(spec.model.name, 'discovered/model-fqn');
		assert.deepStrictEqual(spec.mcpServers, [{
			disableTools: [],
			enableTools: [...agniWorkspaceToolNames],
			name: agniWorkspaceConnectorName,
			preload: true,
			requireApprovalForTools: [],
		}]);
	});

	test('passes explicit context separately and preserves the original prompt exactly', () => {
		const originalPrompt = 'Explain @file:src/example.ts exactly as written.';
		const input = buildWorkspaceTurnInput(originalPrompt, 'assembled workspace context');

		assert.deepStrictEqual(input, [
			{ type: 'user.message', content: 'assembled workspace context' },
			{ type: 'user.message', content: originalPrompt },
		]);
	});

	test('attaches read tools and proposal-only write tool for multi-file editing', () => {
		const spec = createMultiFileAgentSpec('discovered/model-fqn');
		assert.deepStrictEqual(spec.mcpServers, [{
			disableTools: [],
			enableTools: [...agniMultiFileToolNames],
			name: agniWorkspaceConnectorName,
			preload: true,
			requireApprovalForTools: ['propose_write'],
		}]);
		assert.deepStrictEqual(spec.mcpServers?.[0]?.requireApprovalForTools, ['propose_write']);
		assert.ok(!spec.mcpServers?.[0]?.requireApprovalForTools?.includes('read_file'));
		assert.ok(!spec.mcpServers?.[0]?.requireApprovalForTools?.includes('list_files'));
		assert.ok(!spec.mcpServers?.[0]?.requireApprovalForTools?.includes('search_code'));
	});
});
