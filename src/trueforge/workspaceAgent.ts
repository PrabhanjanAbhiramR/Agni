import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { ContextAssembler, defaultContextBudgetBytes } from '../context/contextAssembler.js';
import { agniWorkspaceToolNames } from '../mcp/agniMcpServer.js';
import { AgniMcpHttpHost, type AgniMcpEndpoint } from '../mcp/httpMcpHost.js';

export const agniWorkspaceConnectorName = 'agni-vscode-workspace';

export interface WorkspaceAgentProgress {
	onContextAssembled?: (
		referenceCount: number,
		byteLength: number,
		automaticIncluded: number,
		automaticOmitted: number,
		automaticRankOmitted: number,
		automaticSearchTruncated: boolean,
	) => void;
	onMcpInitialized?: () => void;
	onText?: (content: string) => void;
	onToolCall?: (name: string) => void;
	onToolResponse?: (name: string) => void;
	onTurnDone?: (status: string) => void;
}

export interface WorkspaceAgentTurnOptions {
	contextAssembler?: ContextAssembler;
	contextBudgetBytes?: number;
}

export interface WorkspaceAgentResult {
	answer: string;
	toolName: string;
	toolResponse: string;
	turnStatus: string;
}

interface PendingToolCall {
	id?: string;
	name?: string;
	serverName?: string;
}

function connectorRegistrationError(error: unknown, sensitiveValue: string): Error {
	const rawMessage = error instanceof Error ? error.message : String(error);
	const message = rawMessage
		.split(sensitiveValue).join('[REDACTED]')
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]');
	const loopbackHelp = message.includes('Outbound URL blocked for host')
		? ' Restart the local TrueForge server with OUTBOUND_URL_ALLOWED_HOSTS=["127.0.0.1","localhost"] to allow Agni\'s loopback-only MCP endpoint.'
		: '';
	return new Error(`TrueForge rejected the Agni MCP connector registration: ${message}${loopbackHelp}`);
}

function isAgniToolName(name: string | undefined): name is typeof agniWorkspaceToolNames[number] {
	return name !== undefined && agniWorkspaceToolNames.some((toolName) => toolName === name);
}

export function createWorkspaceAgentSpec(modelName: string): TrueForgeApi.AgentSpec {
	return {
		instructions: [
			'You are Agni, a VS Code coding assistant.',
			'Use the attached Agni workspace tools whenever the user asks about the open workspace.',
			'Do not claim to have inspected a file unless a workspace tool returned its contents.',
		].join(' '),
		mcpServers: [{
			disableTools: [],
			enableTools: [...agniWorkspaceToolNames],
			name: agniWorkspaceConnectorName,
			preload: true,
			requireApprovalForTools: [],
		}],
		model: { name: modelName },
	};
}

export function buildWorkspaceTurnInput(
	prompt: string,
	assembledContext: string,
): TrueForgeApi.TurnInputItem[] {
	const input: TrueForgeApi.TurnInputItem[] = [];
	if (assembledContext) {
		input.push({ type: 'user.message', content: assembledContext });
	}
	input.push({ type: 'user.message', content: prompt });
	return input;
}

export async function registerWorkspaceConnector(
	client: TrueForge,
	mcpHost: AgniMcpHttpHost,
): Promise<void> {
	const connection = await mcpHost.getConnectionDetails();
	const authorization = connection.headers.Authorization;
	try {
		await client.settings.mcpServers.createOrUpdate({
			manifest: {
				auth: {
					headers: { ...connection.headers },
					type: 'header',
				},
				description: 'Secure access to read the open VS Code workspace and record in-memory file proposals for explicit user review.',
				name: agniWorkspaceConnectorName,
				type: 'remote',
				url: connection.url,
			},
		});
	} catch (error: unknown) {
		throw connectorRegistrationError(error, authorization);
	}
}

/**
 * Start the current Extension Host's ephemeral MCP endpoint and immediately
 * replace TrueForge's persisted connector settings with its URL and token.
 */
export async function startAndRegisterWorkspaceConnector(
	client: TrueForge,
	mcpHost: AgniMcpHttpHost,
): Promise<AgniMcpEndpoint> {
	const endpoint = await mcpHost.start();
	await registerWorkspaceConnector(client, mcpHost);
	return endpoint;
}

export async function verifyWorkspaceConnectorTools(client: TrueForge): Promise<string[]> {
	const { data: tools } = await client.mcpServers.listTools(agniWorkspaceConnectorName);
	const names = tools
		.map((tool) => tool.name)
		.filter((name): name is string => typeof name === 'string')
		.sort();
	const missingTools = agniWorkspaceToolNames.filter((name) => !names.includes(name));
	if (missingTools.length > 0) {
		throw new Error(`TrueForge connector did not expose required tools: ${missingTools.join(', ')}.`);
	}

	return names;
}

function recordToolCall(
	toolCallId: string | undefined,
	toolName: string | undefined,
	serverName: string | undefined,
	callsById: Map<string, string>,
	progress: WorkspaceAgentProgress,
): void {
	if (!toolCallId || serverName !== agniWorkspaceConnectorName || !isAgniToolName(toolName)) {
		return;
	}

	if (!callsById.has(toolCallId)) {
		callsById.set(toolCallId, toolName);
		progress.onToolCall?.(toolName);
	}
}

function inspectToolCalls(
	event: TrueForgeApi.TurnStreamingEvent,
	callsById: Map<string, string>,
	deltaCalls: Map<string, PendingToolCall>,
	progress: WorkspaceAgentProgress,
): void {
	if (event.type === 'model.message') {
		for (const toolCall of event.toolCalls ?? []) {
			const toolInfo = toolCall.toolInfo.type === 'mcp' ? toolCall.toolInfo : undefined;
			recordToolCall(toolCall.id, toolInfo?.name, toolInfo?.serverName, callsById, progress);
		}
		return;
	}

	if (event.type !== 'model.message.delta') {
		return;
	}

	for (const toolCall of event.toolCalls ?? []) {
		const key = `${event.threadId}:${toolCall.index}`;
		const pending = deltaCalls.get(key) ?? {};
		pending.id = toolCall.id ?? pending.id;
		if (toolCall.function?.name) {
			pending.name = `${pending.name ?? ''}${toolCall.function.name}`;
		}
		if (toolCall.toolInfo?.type === 'mcp') {
			pending.name = toolCall.toolInfo.name;
			pending.serverName = toolCall.toolInfo.serverName;
		}
		deltaCalls.set(key, pending);
		recordToolCall(pending.id, pending.name, pending.serverName, callsById, progress);
	}
}

export async function runWorkspaceAgentTurn(
	client: TrueForge,
	modelName: string,
	prompt: string,
	progress: WorkspaceAgentProgress = {},
	options: WorkspaceAgentTurnOptions = {},
): Promise<WorkspaceAgentResult> {
	const contextAssembler = options.contextAssembler ?? new ContextAssembler();
	const assembledContext = await contextAssembler.assemble(
		prompt,
		options.contextBudgetBytes ?? defaultContextBudgetBytes,
	);
	progress.onContextAssembled?.(
		assembledContext.references.length,
		assembledContext.byteLength,
		assembledContext.automatic.included.length,
		assembledContext.automatic.omittedForBudget,
		assembledContext.automatic.omittedByRanking,
		assembledContext.automatic.truncatedSearch,
	);
	const { data: session } = await client.sessions.create({
		agent: { spec: createWorkspaceAgentSpec(modelName) },
	});
	const stream = await client.sessions.createTurnStream(session.id, {
		input: buildWorkspaceTurnInput(prompt, assembledContext.content),
	});
	const callsById = new Map<string, string>();
	const deltaCalls = new Map<string, PendingToolCall>();
	let answer = '';
	let completedStatus: string | undefined;
	let matchedToolName: string | undefined;
	let matchedToolResponse: string | undefined;

	for await (const event of stream) {
		inspectToolCalls(event, callsById, deltaCalls, progress);

		if (event.type === 'mcp.initialize'
			&& event.mcpServers.some((server) => server.name === agniWorkspaceConnectorName)) {
			progress.onMcpInitialized?.();
		}

		if (event.type === 'tool.response') {
			const toolName = callsById.get(event.toolCallId);
			if (toolName) {
				matchedToolName = toolName;
				matchedToolResponse = event.content;
				progress.onToolResponse?.(toolName);
			}
		}

		if (event.type === 'model.message.delta' && event.threadId === 'main' && event.content) {
			answer += event.content;
			progress.onText?.(event.content);
		}

		if (event.type === 'turn.done') {
			completedStatus = event.state.status;
			progress.onTurnDone?.(completedStatus);
			if (event.state.status === 'error') {
				throw new Error(`TrueForge workspace turn failed: ${event.state.message}`);
			}
			if (event.state.status === 'cancelled') {
				throw new Error(`TrueForge workspace turn was cancelled: ${event.state.reason}`);
			}
		}
	}

	if (!completedStatus) {
		throw new Error('The TrueForge workspace event stream ended without a turn.done event.');
	}
	if (!matchedToolName) {
		throw new Error('TrueForge completed the turn without calling an Agni workspace tool.');
	}
	if (!matchedToolResponse?.trim()) {
		throw new Error(`TrueForge called ${matchedToolName}, but no non-empty tool result was returned.`);
	}
	if (!answer.trim()) {
		throw new Error('TrueForge returned the workspace tool result but produced no final model response.');
	}

	return {
		answer,
		toolName: matchedToolName,
		toolResponse: matchedToolResponse,
		turnStatus: completedStatus,
	};
}
