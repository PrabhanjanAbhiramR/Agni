import * as assert from 'node:assert';
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { ContextAssembler } from '../context/contextAssembler.js';
import {
	contentHash,
	MultiFilePlanScopeError,
	MultiFileProposalStore,
} from '../multiFileEdit/multiFileProposal.js';
import {
	MultiFileEditCancelledError,
	runMultiFileAgentTurn,
	type MultiFileToolActivity,
	type MultiFileToolApprovalRequest,
} from '../trueforge/multiFileEditAgent.js';

const createdAt = '2026-11-09T00:00:00.000Z';

interface ScriptStep {
	events?: TrueForgeApi.TurnStreamingEvent[];
	onCreate?: (request: TrueForgeApi.CreateTurnSessionsStreamRequest) => void;
	streamError?: Error;
	waitFor?: Promise<void>;
}

interface ScriptedClient {
	cancelCount: () => number;
	client: TrueForge;
	requests: TrueForgeApi.CreateTurnSessionsStreamRequest[];
}

function turnCreated(turnId: string, previousTurnId: string | null = null): TrueForgeApi.TurnCreatedEvent {
	return {
		createdAt,
		id: `event-${turnId}`,
		input: [],
		previousTurnId,
		state: { status: 'running' },
		threadId: null,
		turnId,
		type: 'turn.created',
	};
}

function proposalMessage(
	messageId: string,
	toolCalls: Array<{ arguments?: string; id: string }>,
): TrueForgeApi.ModelMessageEvent {
	return {
		content: null,
		createdAt,
		id: messageId,
		threadId: 'main',
		toolCalls: toolCalls.map((toolCall) => ({
			function: {
				arguments: toolCall.arguments ?? '{"path":"src/example.ts"}',
				name: 'call_tool',
			},
			id: toolCall.id,
			toolInfo: {
				name: 'propose_write',
				serverId: 'mcp-server-id',
				serverName: 'agni-vscode-workspace',
				type: 'mcp',
			},
			type: 'function',
		})),
		type: 'model.message',
	};
}

function proposalCall(id: string, path: string, content: string): { arguments: string; id: string } {
	return { arguments: JSON.stringify({ content, path }), id };
}

function approvalRequired(
	eventId: string,
	messageId: string,
	toolCallIds: string[],
): TrueForgeApi.ToolApprovalRequiredEvent {
	return {
		createdAt,
		id: eventId,
		threadId: 'main',
		toolCalls: toolCallIds.map((id) => ({ id, sourceEventId: messageId })),
		type: 'tool.approval_required',
	};
}

function turnDone(
	eventId: string,
	requiredActions: TrueForgeApi.ActionRequiredEvent[] = [],
): TrueForgeApi.TurnDoneEvent {
	return {
		createdAt,
		id: eventId,
		state: {
			completedAt: createdAt,
			output: null,
			requiredActions,
			status: 'done',
		},
		threadId: null,
		type: 'turn.done',
	};
}

function textDelta(id: string, content: string): TrueForgeApi.ModelMessageDeltaEvent {
	return {
		content,
		id,
		threadId: 'main',
		type: 'model.message.delta',
	};
}

function toolResponse(
	id: string,
	toolCallId: string,
	path: string,
	root = 'project',
): TrueForgeApi.ToolResponseEvent {
	return {
		content: JSON.stringify({ created: true, path, proposedByteLength: 1, root }),
		createdAt,
		id,
		threadId: 'main',
		toolCallId,
		type: 'tool.response',
	};
}

function readOnlyMessage(
	messageId: string,
	toolCallId: string,
	toolName = 'read_file',
	argumentsJson = '{"path":"package.json"}',
): TrueForgeApi.ModelMessageEvent {
	return {
		content: null,
		createdAt,
		id: messageId,
		threadId: 'main',
		toolCalls: [{
			function: { arguments: argumentsJson, name: 'call_tool' },
			id: toolCallId,
			toolInfo: {
				name: toolName,
				serverId: 'mcp-server-id',
				serverName: 'agni-vscode-workspace',
				type: 'mcp',
			},
			type: 'function',
		}],
		type: 'model.message',
	};
}

function readOnlyDelta(
	eventId: string,
	toolCallId: string,
	toolName: string,
): TrueForgeApi.ModelMessageDeltaEvent {
	return {
		id: eventId,
		threadId: 'main',
		toolCalls: [{
			id: toolCallId,
			index: 0,
			toolInfo: {
				name: toolName,
				serverId: 'mcp-server-id',
				serverName: 'agni-vscode-workspace',
				type: 'mcp',
			},
			type: 'function',
		}],
		type: 'model.message.delta',
	};
}

function createScriptedClient(steps: ScriptStep[]): ScriptedClient {
	const requests: TrueForgeApi.CreateTurnSessionsStreamRequest[] = [];
	let cancelCount = 0;
	let stepIndex = 0;
	const client = {
		sessions: {
			cancel: async () => {
				cancelCount += 1;
				return { data: {} };
			},
			create: async () => ({ data: { id: 'approval-session' } }),
			createTurnStream: async (
				_sessionId: string,
				request: TrueForgeApi.CreateTurnSessionsStreamRequest,
			) => {
				requests.push(structuredClone(request));
				const step = steps[stepIndex++];
				if (!step) {
					throw new Error('Unexpected extra TrueForge turn.');
				}
				step.onCreate?.(request);
				return {
					async *[Symbol.asyncIterator]() {
						for (const event of step.events ?? []) {
							yield event;
						}
						if (step.waitFor) {
							await step.waitFor;
						}
						if (step.streamError) {
							throw step.streamError;
						}
					},
				};
			},
		},
	} as unknown as TrueForge;
	return { cancelCount: () => cancelCount, client, requests };
}

function assembler(): ContextAssembler {
	return {
		assemble: () => Promise.resolve({ byteLength: 0, content: '' }),
	} as unknown as ContextAssembler;
}

function addProposal(store: MultiFileProposalStore, path: string, proposedContent: string): void {
	store.propose({
		content: '',
		exists: false,
		hash: contentHash(''),
		path,
		root: 'project',
		uri: vscode.Uri.file(`C:\\agni-approval-test\\project\\${path.replaceAll('/', '\\')}`),
	}, proposedContent);
}

function begin(store: MultiFileProposalStore, id: string): void {
	store.begin('Prepare a reviewed change.', id);
}

suite('TrueForge propose_write approval flow', () => {
	test('stops implementation when propose_write targets a file outside the approved plan', async () => {
		const store = new MultiFileProposalStore();
		store.begin(
			'Prepare a scoped change.',
			'plan-scope',
			[{ path: 'src/approved.ts', root: 'project' }],
		);
		const pending = approvalRequired('approval-scope', 'message-scope', ['call-scope']);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-scope-1'),
					proposalMessage('message-scope', [proposalCall(
						'call-scope',
						'src/outside.ts',
						'export const outside = true;\n',
					)]),
					pending,
					turnDone('done-scope-1', [pending]),
				],
			},
			{
				onCreate: () => {
					try {
						addProposal(store, 'src/outside.ts', 'export const outside = true;\n');
					} catch (error: unknown) {
						assert.ok(error instanceof MultiFilePlanScopeError);
					}
				},
				events: [
					turnCreated('turn-scope-2', 'turn-scope-1'),
					toolResponse('response-scope', 'call-scope', 'src/outside.ts'),
				],
			},
		]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Implement the approved plan.',
			'plan-scope',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => ({ status: 'allow' }) },
			assembler(),
			undefined,
			undefined,
			[{ path: 'src/approved.ts', root: 'project' }],
		), (error: unknown) => error instanceof MultiFilePlanScopeError);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('plan-scope').status, 'cancelled');
		assert.strictEqual(store.require('plan-scope').changes.size, 0);
	});

	test('allows propose_write and resumes from the exact paused turn', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'approved');
		const pending = approvalRequired('approval-1', 'message-1', ['call-1']);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-1'),
					readOnlyMessage('message-read-only', 'call-read-only'),
					toolResponse('response-read-only', 'call-read-only', 'package.json'),
					proposalMessage('message-1', [proposalCall(
						'call-1',
						'src/approved.ts',
						'export const approved = true;\n',
					)]),
					pending,
					turnDone('done-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/approved.ts', 'export const approved = true;\n'),
				events: [
					turnCreated('turn-2', 'turn-1'),
					toolResponse('response-1', 'call-1', 'src/approved.ts'),
					textDelta('answer-1', 'Proposal prepared.'),
					turnDone('done-2'),
				],
			},
		]);
		const requests: MultiFileToolApprovalRequest[] = [];
		const toolActivity: MultiFileToolActivity[] = [];
		let assembledContextBytes: number | undefined;
		let createdSessionId: string | undefined;
		const result = await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'approved',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onContextDetails: (context) => { assembledContextBytes = context.byteLength; },
				onSessionCreated: (sessionId) => { createdSessionId = sessionId; },
				onToolActivity: (activity) => { toolActivity.push(activity); },
				onToolApprovalRequired: async (request) => {
					requests.push(request);
					return { status: 'allow' };
				},
			},
			assembler(),
		);

		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].toolName, 'propose_write');
		assert.deepStrictEqual(scripted.requests[1], {
			input: [{
				approval: { status: 'allow' },
				threadId: 'main',
				toolCallId: 'call-1',
				type: 'user.tool_approval',
			}],
			previousTurnId: 'turn-1',
		});
		assert.strictEqual(result.transaction.status, 'review');
		assert.strictEqual(result.transaction.changes.size, 1);
		assert.strictEqual(result.answer, 'Proposal prepared.');
		assert.strictEqual(assembledContextBytes, 0);
		assert.strictEqual(createdSessionId, 'approval-session');
		assert.deepStrictEqual(toolActivity, [
			{ status: 'started', toolName: 'read_file' },
			{ status: 'completed', toolName: 'read_file' },
			{ status: 'started', toolName: 'propose_write' },
			{ status: 'awaiting-approval', toolName: 'propose_write' },
			{ status: 'completed', toolName: 'propose_write' },
		]);
		assert.doesNotMatch(JSON.stringify(toolActivity), /package\.json|approved = true|src\/approved/u);
		assert.strictEqual(scripted.cancelCount(), 0);
		assert.strictEqual(store.getLastAppliedBatch(), undefined);
	});

	test('correlates an approved Python proposal after delimiter normalization', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'python-normalized');
		const generated = '\\"\\"\\"Module documentation.\\"\\"\\"\n\n'
			+ 'message = "She said \\"hello\\""\n';
		const normalized = '"""Module documentation."""\n\n'
			+ 'message = "She said \\"hello\\""\n';
		const pending = approvalRequired('approval-python', 'message-python', ['call-python']);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-python-1'),
					proposalMessage('message-python', [proposalCall(
						'call-python',
						'src/calculations.py',
						generated,
					)]),
					pending,
					turnDone('done-python-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/calculations.py', normalized),
				events: [
					turnCreated('turn-python-2', 'turn-python-1'),
					toolResponse('response-python', 'call-python', 'src/calculations.py'),
					turnDone('done-python-2'),
				],
			},
		]);

		const result = await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed Python change.',
			'python-normalized',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => ({ status: 'allow' }) },
			assembler(),
		);

		assert.strictEqual(result.transaction.status, 'review');
		assert.strictEqual(store.require('python-normalized').changes.values().next().value?.proposedContent, normalized);
		assert.strictEqual(scripted.cancelCount(), 0);
	});

	test('cancels the session once when the session-created callback fails', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'session-callback-failure');
		const scripted = createScriptedClient([]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'session-callback-failure',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onSessionCreated: () => {
					throw new Error('Session callback failed.');
				},
			},
			assembler(),
		), /Session callback failed/u);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(scripted.requests.length, 0);
		assert.strictEqual(store.require('session-callback-failure').status, 'cancelled');
		assert.strictEqual(store.getLastAppliedBatch(), undefined);
	});

	test('reports only safe activity for read-only and proposal tools', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'safe-tool-activity');
		const proposedContent = 'export const safeActivity = true;\n';
		const pending = approvalRequired('approval-safe-activity', 'message-proposal', ['call-proposal']);
		const malformed = readOnlyMessage(
			'message-malformed',
			'call-malformed',
			'read_file',
			'{"path":"do-not-leak-malformed.ts"}',
		);
		malformed.toolCalls = malformed.toolCalls?.map((call) => {
			const { toolInfo: _toolInfo, ...withoutToolInfo } = call;
			return withoutToolInfo as TrueForgeApi.ToolCall;
		});
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-safe-activity-1'),
					readOnlyMessage('message-read', 'call-read', 'read_file', '{"path":"do-not-leak-read.ts"}'),
					toolResponse('response-read', 'call-read', 'do-not-leak-read-response.ts'),
					readOnlyMessage('message-list', 'call-list', 'list_files', '{"glob":"do-not-leak-list/**"}'),
					toolResponse('response-list', 'call-list', 'do-not-leak-list-response.ts'),
					readOnlyDelta('delta-search', 'call-search', 'search_code'),
					toolResponse('response-search', 'call-search', 'do-not-leak-search-response.ts'),
					readOnlyMessage('message-unknown', 'call-unknown', 'unknown_tool', '{"secret":"do-not-leak"}'),
					toolResponse('response-unknown', 'call-unknown', 'do-not-leak-unknown-response.ts'),
					malformed,
					toolResponse('response-malformed', 'call-malformed', 'do-not-leak-malformed-response.ts'),
					proposalMessage('message-proposal', [proposalCall(
						'call-proposal',
						'src/safe-activity.ts',
						proposedContent,
					)]),
					pending,
					turnDone('done-safe-activity-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/safe-activity.ts', proposedContent),
				events: [
					turnCreated('turn-safe-activity-2', 'turn-safe-activity-1'),
					toolResponse('response-proposal', 'call-proposal', 'src/safe-activity.ts'),
					turnDone('done-safe-activity-2'),
				],
			},
		]);
		const activity: MultiFileToolActivity[] = [];

		await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'safe-tool-activity',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onToolActivity: (item) => { activity.push(item); },
				onToolApprovalRequired: async () => ({ status: 'allow' }),
			},
			assembler(),
		);

		assert.deepStrictEqual(activity, [
			{ status: 'started', toolName: 'read_file' },
			{ status: 'completed', toolName: 'read_file' },
			{ status: 'started', toolName: 'list_files' },
			{ status: 'completed', toolName: 'list_files' },
			{ status: 'started', toolName: 'search_code' },
			{ status: 'completed', toolName: 'search_code' },
			{ status: 'started', toolName: 'propose_write' },
			{ status: 'awaiting-approval', toolName: 'propose_write' },
			{ status: 'completed', toolName: 'propose_write' },
		]);
		assert.doesNotMatch(
			JSON.stringify(activity),
			/do-not-leak|unknown_tool|safe-activity\.ts|safeActivity/u,
		);
		assert.strictEqual(store.require('safe-tool-activity').status, 'review');
		assert.strictEqual(scripted.cancelCount(), 0);
	});

	test('rejects duplicate propose_write execution responses', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'duplicate-execution');
		const content = 'duplicate execution\n';
		const pending = approvalRequired('approval-duplicate-execution', 'message-duplicate-execution', ['call-duplicate-execution']);
		const response = toolResponse(
			'response-duplicate-execution',
			'call-duplicate-execution',
			'src/duplicate-execution.ts',
		);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-duplicate-execution-1'),
					proposalMessage('message-duplicate-execution', [proposalCall(
						'call-duplicate-execution',
						'src/duplicate-execution.ts',
						content,
					)]),
					pending,
					turnDone('done-duplicate-execution-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/duplicate-execution.ts', content),
				events: [
					turnCreated('turn-duplicate-execution-2', 'turn-duplicate-execution-1'),
					response,
					{ ...response, id: 'response-duplicate-execution-repeated' },
					turnDone('done-duplicate-execution-2'),
				],
			},
		]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'duplicate-execution',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => ({ status: 'allow' }) },
			assembler(),
		), /duplicate propose_write execution/u);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('duplicate-execution').status, 'cancelled');
	});

	test('cancels a paused session when approval UI handling fails after turn.done', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'approval-handler-error');
		const pending = approvalRequired('approval-error', 'message-error', ['call-error']);
		const scripted = createScriptedClient([{
			events: [
				turnCreated('turn-error-paused'),
				proposalMessage('message-error', [proposalCall('call-error', 'src/error.ts', 'error\n')]),
				pending,
				turnDone('done-error-paused', [pending]),
			],
		}]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'approval-handler-error',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => { throw new Error('approval UI failed'); } },
			assembler(),
		), /approval UI failed/u);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('approval-handler-error').status, 'cancelled');
	});

	test('cancels a paused session at most once when approval handling and cancellation race', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'approval-cancel-race');
		const pending = approvalRequired('approval-race', 'message-race', ['call-race']);
		const scripted = createScriptedClient([{
			events: [
				turnCreated('turn-race'),
				proposalMessage('message-race', [proposalCall('call-race', 'src/race.ts', 'race\n')]),
				pending,
				turnDone('done-race', [pending]),
			],
		}]);
		const cancellation = new vscode.CancellationTokenSource();

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'approval-cancel-race',
			store,
			cancellation.token,
			{
				onToolApprovalRequired: async () => {
					cancellation.cancel();
					throw new Error('late approval failure');
				},
			},
			assembler(),
		), (error: unknown) => error instanceof MultiFileEditCancelledError);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('approval-cancel-race').status, 'cancelled');
		cancellation.dispose();
	});

	test('rejects an unapproved propose_write execution', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'unapproved-execution');
		const content = 'unapproved\n';
		const scripted = createScriptedClient([{
			onCreate: () => addProposal(store, 'src/unapproved.ts', content),
			events: [
				turnCreated('turn-unapproved'),
				proposalMessage('message-unapproved', [proposalCall('call-unapproved', 'src/unapproved.ts', content)]),
				toolResponse('response-unapproved', 'call-unapproved', 'src/unapproved.ts'),
				turnDone('done-unapproved'),
			],
		}]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'unapproved-execution',
			store,
			new vscode.CancellationTokenSource().token,
			{},
			assembler(),
		), /unapproved propose_write execution/u);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('unapproved-execution').status, 'cancelled');
		assert.strictEqual(store.getLastAppliedBatch(), undefined);
	});

	test('rejects a mismatched propose_write tool-call identity', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'mismatched-execution');
		const content = 'mismatched\n';
		const pending = approvalRequired('approval-mismatch', 'message-mismatch', ['call-approved']);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-mismatch-1'),
					proposalMessage('message-mismatch', [proposalCall('call-approved', 'src/mismatch.ts', content)]),
					pending,
					turnDone('done-mismatch-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/mismatch.ts', content),
				events: [
					turnCreated('turn-mismatch-2', 'turn-mismatch-1'),
					toolResponse('response-mismatch', 'call-other', 'src/mismatch.ts'),
					turnDone('done-mismatch-2'),
				],
			},
		]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'mismatched-execution',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => ({ status: 'allow' }) },
			assembler(),
		), /not produced by an explicitly allowed propose_write execution/u);

		assert.strictEqual(store.require('mismatched-execution').status, 'cancelled');
		assert.strictEqual(store.getLastAppliedBatch(), undefined);
	});

	test('denies propose_write with a reason and cleans up without proposals', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'denied');
		const pending = approvalRequired('approval-denied', 'message-denied', ['call-denied']);
		const scripted = createScriptedClient([
			{ events: [turnCreated('turn-denied-1'), proposalMessage('message-denied', [{ id: 'call-denied' }]), pending, turnDone('done-denied-1', [pending])] },
			{ events: [turnCreated('turn-denied-2', 'turn-denied-1'), turnDone('done-denied-2')] },
		]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'denied',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onToolApprovalRequired: async () => ({
					reason: 'The user denied proposal generation.',
					status: 'deny',
				}),
			},
			assembler(),
		), /without proposing any file changes/u);

		assert.deepStrictEqual(scripted.requests[1].input, [{
			approval: { reason: 'The user denied proposal generation.', status: 'deny' },
			threadId: 'main',
			toolCallId: 'call-denied',
			type: 'user.tool_approval',
		}]);
		assert.strictEqual(store.require('denied').status, 'cancelled');
		assert.strictEqual(store.getActive(), undefined);
	});

	test('supports multiple sequential approval turns without applying files', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'multiple');
		const first = approvalRequired('approval-first', 'message-first', ['call-first']);
		const second = approvalRequired('approval-second', 'message-second', ['call-second']);
		const scripted = createScriptedClient([
			{ events: [turnCreated('turn-multi-1'), proposalMessage('message-first', [proposalCall('call-first', 'src/first.ts', 'export const first = true;\n')]), first, turnDone('done-multi-1', [first])] },
			{
				onCreate: () => addProposal(store, 'src/first.ts', 'export const first = true;\n'),
				events: [turnCreated('turn-multi-2', 'turn-multi-1'), toolResponse('response-first', 'call-first', 'src/first.ts'), proposalMessage('message-second', [proposalCall('call-second', 'src/second.ts', 'export const second = true;\n')]), second, turnDone('done-multi-2', [second])],
			},
			{
				onCreate: () => addProposal(store, 'src/second.ts', 'export const second = true;\n'),
				events: [turnCreated('turn-multi-3', 'turn-multi-2'), toolResponse('response-second', 'call-second', 'src/second.ts'), turnDone('done-multi-3')],
			},
		]);
		const prompted: string[] = [];
		const result = await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'multiple',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onToolApprovalRequired: async (request) => {
					prompted.push(request.toolCallId);
					return { status: 'allow' };
				},
			},
			assembler(),
		);

		assert.deepStrictEqual(prompted, ['call-first', 'call-second']);
		assert.strictEqual(scripted.requests[1].previousTurnId, 'turn-multi-1');
		assert.strictEqual(scripted.requests[2].previousTurnId, 'turn-multi-2');
		assert.strictEqual(result.transaction.changes.size, 2);
		assert.strictEqual(result.transaction.status, 'review');
		assert.strictEqual(store.getLastAppliedBatch(), undefined);
	});

	test('batches multiple pending calls into one approval continuation', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'batched');
		const pending = approvalRequired(
			'approval-batched',
			'message-batched',
			['call-batched-allow', 'call-batched-deny'],
		);
		const scripted = createScriptedClient([
			{
				events: [
					turnCreated('turn-batched-1'),
					proposalMessage('message-batched', [
						proposalCall('call-batched-allow', 'src/batched.ts', 'export const batched = true;\n'),
						proposalCall('call-batched-deny', 'src/denied.ts', 'export const denied = true;\n'),
					]),
					pending,
					turnDone('done-batched-1', [pending]),
				],
			},
			{
				onCreate: () => addProposal(store, 'src/batched.ts', 'export const batched = true;\n'),
				events: [turnCreated('turn-batched-2', 'turn-batched-1'), toolResponse('response-batched', 'call-batched-allow', 'src/batched.ts'), turnDone('done-batched-2')],
			},
		]);
		await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'batched',
			store,
			new vscode.CancellationTokenSource().token,
			{
				onToolApprovalRequired: async (request) => request.toolCallId === 'call-batched-allow'
					? { status: 'allow' }
					: { reason: 'Only one proposal was approved.', status: 'deny' },
			},
			assembler(),
		);

		assert.strictEqual(scripted.requests.length, 2);
		assert.deepStrictEqual(scripted.requests[1].input, [
			{
				approval: { status: 'allow' },
				threadId: 'main',
				toolCallId: 'call-batched-allow',
				type: 'user.tool_approval',
			},
			{
				approval: { reason: 'Only one proposal was approved.', status: 'deny' },
				threadId: 'main',
				toolCallId: 'call-batched-deny',
				type: 'user.tool_approval',
			},
		]);
	});

	test('deduplicates repeated approval events and sends one response', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'duplicate');
		const pending = approvalRequired('approval-duplicate', 'message-duplicate', ['call-duplicate']);
		const scripted = createScriptedClient([
			{ events: [turnCreated('turn-duplicate-1'), proposalMessage('message-duplicate', [proposalCall('call-duplicate', 'src/duplicate.ts', 'export const once = true;\n')]), pending, pending, turnDone('done-duplicate-1', [pending])] },
			{
				onCreate: () => addProposal(store, 'src/duplicate.ts', 'export const once = true;\n'),
				events: [turnCreated('turn-duplicate-2', 'turn-duplicate-1'), toolResponse('response-duplicate', 'call-duplicate', 'src/duplicate.ts'), turnDone('done-duplicate-2')],
			},
		]);
		let promptCount = 0;
		await runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'duplicate',
			store,
			new vscode.CancellationTokenSource().token,
			{ onToolApprovalRequired: async () => { promptCount += 1; return { status: 'allow' }; } },
			assembler(),
		);

		assert.strictEqual(promptCount, 1);
		assert.strictEqual(scripted.requests.length, 2);
		assert.strictEqual(scripted.requests[1].input?.length, 1);
	});

	test('cancels while awaiting approval and ignores a late decision', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'cancel-waiting');
		const pending = approvalRequired('approval-waiting', 'message-waiting', ['call-waiting']);
		const scripted = createScriptedClient([
			{ events: [turnCreated('turn-waiting'), proposalMessage('message-waiting', [{ id: 'call-waiting' }]), pending, turnDone('done-waiting', [pending])] },
		]);
		let resolveApproval: ((decision: TrueForgeApi.ApprovalDecision) => void) | undefined;
		let markPrompted: (() => void) | undefined;
		const prompted = new Promise<void>((resolve) => { markPrompted = resolve; });
		const cancellation = new vscode.CancellationTokenSource();
		const generation = runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'cancel-waiting',
			store,
			cancellation.token,
			{
				onToolApprovalRequired: () => {
					markPrompted?.();
					return new Promise((resolve) => { resolveApproval = resolve; });
				},
			},
			assembler(),
		);
		await prompted;
		cancellation.cancel();
		await assert.rejects(generation, (error: unknown) => error instanceof MultiFileEditCancelledError);
		resolveApproval?.({ status: 'allow' });
		await Promise.resolve();

		assert.strictEqual(scripted.requests.length, 1);
		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('cancel-waiting').status, 'cancelled');
		cancellation.dispose();
	});

	test('cancels after approval while the resumed proposal turn is running', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'cancel-after');
		const pending = approvalRequired('approval-after', 'message-after', ['call-after']);
		let releaseStream: (() => void) | undefined;
		const blockedStream = new Promise<void>((resolve) => { releaseStream = resolve; });
		let markResumed: (() => void) | undefined;
		const resumed = new Promise<void>((resolve) => { markResumed = resolve; });
		const scripted = createScriptedClient([
			{ events: [turnCreated('turn-after-1'), proposalMessage('message-after', [{ id: 'call-after' }]), pending, turnDone('done-after-1', [pending])] },
			{ onCreate: () => markResumed?.(), events: [turnCreated('turn-after-2', 'turn-after-1')], waitFor: blockedStream },
		]);
		const cancellation = new vscode.CancellationTokenSource();
		const generation = runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'cancel-after',
			store,
			cancellation.token,
			{ onToolApprovalRequired: async () => ({ status: 'allow' }) },
			assembler(),
		);
		await resumed;
		cancellation.cancel();
		await assert.rejects(generation, (error: unknown) => error instanceof MultiFileEditCancelledError);
		releaseStream?.();

		assert.strictEqual(scripted.requests.length, 2);
		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('cancel-after').status, 'cancelled');
		cancellation.dispose();
	});

	test('cancels the session and transaction after a stream error', async () => {
		const store = new MultiFileProposalStore();
		begin(store, 'stream-error');
		const scripted = createScriptedClient([{
			events: [turnCreated('turn-error')],
			streamError: new Error('stream failed'),
		}]);

		await assert.rejects(runMultiFileAgentTurn(
			scripted.client,
			'model/fqn',
			'Prepare a reviewed change.',
			'stream-error',
			store,
			new vscode.CancellationTokenSource().token,
			{},
			assembler(),
		), /stream failed/u);

		assert.strictEqual(scripted.cancelCount(), 1);
		assert.strictEqual(store.require('stream-error').status, 'cancelled');
		assert.strictEqual(store.getActive(), undefined);
	});
});
