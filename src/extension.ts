import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { AgniMcpHttpHost } from './mcp/httpMcpHost.js';
import { agniWorkspaceToolNames } from './mcp/agniMcpServer.js';
import {
	agniWorkspaceConnectorName,
	runWorkspaceAgentTurn,
	startAndRegisterWorkspaceConnector,
	verifyWorkspaceConnectorTools,
} from './trueforge/workspaceAgent.js';
import { defaultContextBudgetBytes } from './context/contextAssembler.js';
import {
	InlineEditController,
	InlineEditProposalError,
	InlineEditProposalStore,
	InlineEditStaleProposalError,
	VsCodeInlineEditWorkspace,
} from './inlineEdit/inlineEditProposal.js';
import { InlineEditDiffProvider, registerInlineEditDiffProvider } from './inlineEdit/inlineEditDiff.js';
import { InlineEditDecorationManager } from './inlineEdit/inlineEditDecorations.js';
import { captureInlineEditTarget } from './inlineEdit/inlineEditTarget.js';
import { InlineEditCancelledError, TrueForgeInlineEditGenerator } from './trueforge/inlineEditAgent.js';
import {
	MultiFileEditController,
	VsCodeMultiFileWorkspace,
} from './multiFileEdit/multiFileController.js';
import {
	acceptMultiFileHunkCommandId,
	isMultiFileHunkCommandTarget,
	MultiFileEditCodeLensProvider,
	type MultiFileHunkCommandTarget,
	registerMultiFileEditCodeLensProvider,
	rejectMultiFileHunkCommandId,
} from './multiFileEdit/multiFileCodeLens.js';
import {
	MultiFileDiffProvider,
	registerMultiFileDiffProvider,
} from './multiFileEdit/multiFileDiff.js';
import {
	MultiFileProposalError,
	MultiFileProposalStore,
	MultiFileStaleError,
} from './multiFileEdit/multiFileProposal.js';
import {
	MultiFileEditCancelledError,
	type MultiFileToolApprovalRequest,
	runMultiFileAgentTurn,
	verifyMultiFileConnectorTools,
} from './trueforge/multiFileEditAgent.js';
import {
	MultiFileReviewFileNode,
	MultiFileReviewHunkNode,
	MultiFileReviewTreeProvider,
	multiFileReviewViewId,
} from './multiFileEdit/multiFileReviewTree.js';

const commandId = 'agni.testTrueForgeConnection';
const workspaceToolsCommandId = 'agni.testWorkspaceTools';
const trueForgeWorkspaceCommandId = 'agni.testTrueForgeWorkspaceAgent';
const inlineEditCommandId = 'agni.inlineEdit';
const acceptInlineEditCommandId = 'agni.inlineEdit.accept';
const rejectInlineEditCommandId = 'agni.inlineEdit.reject';
const multiFileEditCommandId = 'agni.multiFileEdit';
const acceptMultiFileEditCommandId = 'agni.multiFileEdit.accept';
const rejectMultiFileEditCommandId = 'agni.multiFileEdit.reject';
const undoMultiFileEditCommandId = 'agni.multiFileEdit.undo';
const applyReviewedMultiFileEditCommandId = 'agni.multiFileEdit.applyReviewed';
const acceptMultiFileCommandId = 'agni.multiFileEdit.acceptFile';
const rejectMultiFileCommandId = 'agni.multiFileEdit.rejectFile';
const openMultiFileReviewCommandId = 'agni.multiFileEdit.openReviewFile';
const configurationSection = 'agni.trueForge';
const defaultServerUrl = 'http://localhost:8790';
const testPrompt = 'Reply with one short sentence confirming that the TrueForge connection works.';
let activeMcpHost: AgniMcpHttpHost | undefined;

interface ModelQuickPickItem extends vscode.QuickPickItem {
	modelFqn: string;
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
		.replace(/("authorization"\s*:\s*")[^"]+/giu, '$1[REDACTED]');
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return redactSensitiveText(error.message);
	}

	return redactSensitiveText(String(error));
}

function isLikelyConnectionFailure(error: unknown): boolean {
	const messages: string[] = [];
	let current: unknown = error;

	while (current instanceof Error) {
		messages.push(current.message.toLowerCase());
		current = current.cause;
	}

	const message = messages.join(' ');
	return message.includes('econnrefused')
		|| message.includes('enotfound')
		|| message.includes('fetch failed')
		|| message.includes('network')
		|| message.includes('socket');
}

function resolveMultiFileHunkTarget(
	value: MultiFileReviewHunkNode | MultiFileHunkCommandTarget | undefined,
): MultiFileHunkCommandTarget | undefined {
	if (value instanceof MultiFileReviewHunkNode) {
		return {
			changeKey: value.key,
			hunkId: value.hunk.id,
			transactionId: value.transactionId,
		};
	}
	return isMultiFileHunkCommandTarget(value) ? value : undefined;
}

async function showFailure(
	outputChannel: vscode.OutputChannel,
	message: string,
	error: unknown,
): Promise<void> {
	const details = describeError(error);
	outputChannel.appendLine(`[Error] ${message}: ${details}`);
	outputChannel.show(true);
	console.error(`[Agni] ${message}: ${details}`);
	await vscode.window.showErrorMessage(`${message}: ${details}`);
}

async function selectModel(
	client: TrueForge,
	configuredModel: string,
): Promise<ModelQuickPickItem | undefined> {
	const { data: models } = await client.models.list();
	if (models.length === 0) {
		throw new Error('TrueForge returned no configured models. Configure a model provider and try again.');
	}

	const modelItems: ModelQuickPickItem[] = models.map((model) => ({
		label: model.name,
		description: model.provider.name,
		detail: model.warning,
		modelFqn: model.name,
		picked: model.name === configuredModel,
	}));
	return vscode.window.showQuickPick(modelItems, {
		title: 'Agni: Select a TrueForge model',
		placeHolder: configuredModel
			? `Preferred model: ${configuredModel}`
			: 'Select a configured model FQN',
		matchOnDescription: true,
		matchOnDetail: true,
	});
}

async function runConnectionTest(outputChannel: vscode.OutputChannel): Promise<void> {
	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const configuredModel = configuration.get<string>('selectedModel', '').trim();
	const client = new TrueForge({
		baseUrl: serverUrl,
		timeoutInSeconds: 600,
	});

	outputChannel.clear();
	outputChannel.show(true);
	outputChannel.appendLine('Agni: TrueForge connection test');
	outputChannel.appendLine(`Server: ${serverUrl}`);
	outputChannel.appendLine('Fetching configured models...');

	let selectedModel: ModelQuickPickItem | undefined;
	try {
		selectedModel = await selectModel(client, configuredModel);
	} catch (error: unknown) {
		const message = isLikelyConnectionFailure(error)
			? `Could not connect to TrueForge at ${serverUrl}`
			: 'Failed to fetch configured models from TrueForge';
		await showFailure(outputChannel, message, error);
		return;
	}

	if (!selectedModel) {
		outputChannel.appendLine('Connection test cancelled before session creation.');
		return;
	}

	outputChannel.appendLine(`Model: ${selectedModel.modelFqn}`);
	outputChannel.appendLine('Creating inline TrueForge session...');

	let sessionId: string;
	try {
		const { data: session } = await client.sessions.create({
			agent: {
				spec: {
					model: { name: selectedModel.modelFqn },
					instructions: 'You are Agni, a concise VS Code AI coding assistant. This session is only a connection test.',
				},
			},
		});
		sessionId = session.id;
	} catch (error: unknown) {
		await showFailure(outputChannel, 'Failed to create an inline TrueForge session', error);
		return;
	}

	outputChannel.appendLine(`Session: ${sessionId}`);
	outputChannel.appendLine(`Prompt: ${testPrompt}`);
	outputChannel.appendLine('Response:');

	try {
		const stream = await client.sessions.createTurnStream(sessionId, {
			input: [{ type: 'user.message', content: testPrompt }],
		});
		let receivedTurnDone = false;

		for await (const event of stream) {
			if (event.type === 'model.message.delta' && event.threadId === 'main') {
				outputChannel.append(event.content ?? '');
			}

			if (event.type === 'turn.done') {
				receivedTurnDone = true;
				outputChannel.appendLine('');
				outputChannel.appendLine(`Turn status: ${event.state.status}`);

				if (event.state.status === 'error') {
					await vscode.window.showErrorMessage(`TrueForge turn failed: ${event.state.message}`);
				} else if (event.state.status === 'cancelled') {
					await vscode.window.showWarningMessage(`TrueForge turn was cancelled: ${event.state.reason}`);
				} else {
					await vscode.window.showInformationMessage(`Agni TrueForge test completed: ${event.state.status}`);
				}
			}
		}

		if (!receivedTurnDone) {
			throw new Error('The TrueForge event stream ended without a turn.done event.');
		}
	} catch (error: unknown) {
		await showFailure(outputChannel, 'TrueForge turn streaming failed', error);
	}
}

async function runTrueForgeWorkspaceTest(
	outputChannel: vscode.OutputChannel,
	mcpHost: AgniMcpHttpHost,
): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showErrorMessage('Agni workspace tools require a trusted VS Code workspace.');
		return;
	}

	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders?.length) {
		await vscode.window.showErrorMessage('Open a workspace folder before testing the TrueForge workspace agent.');
		return;
	}

	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const configuredModel = configuration.get<string>('selectedModel', '').trim();
	const contextBudgetBytes = vscode.workspace
		.getConfiguration('agni.context')
		.get<number>('maxBytes', defaultContextBudgetBytes);
	const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });

	outputChannel.clear();
	outputChannel.show(true);
	outputChannel.appendLine('Agni: TrueForge workspace agent test');
	outputChannel.appendLine(`Server: ${serverUrl}`);
	outputChannel.appendLine('Fetching configured models...');

	let selectedModel: ModelQuickPickItem | undefined;
	try {
		selectedModel = await selectModel(client, configuredModel);
	} catch (error: unknown) {
		const message = isLikelyConnectionFailure(error)
			? `Could not connect to TrueForge at ${serverUrl}`
			: 'Failed to fetch configured models from TrueForge';
		await showFailure(outputChannel, message, error);
		return;
	}
	if (!selectedModel) {
		outputChannel.appendLine('Workspace agent test cancelled before connector registration.');
		return;
	}

	outputChannel.appendLine(`Model: ${selectedModel.modelFqn}`);
	outputChannel.appendLine('Starting authenticated workspace MCP endpoint...');
	const endpoint = await startAndRegisterWorkspaceConnector(client, mcpHost);
	outputChannel.appendLine(`MCP endpoint: http://127.0.0.1:${endpoint.port}/mcp`);
	outputChannel.appendLine(`Registered TrueForge connector: ${agniWorkspaceConnectorName}`);

	outputChannel.appendLine('Verifying connector tool discovery through TrueForge...');
	try {
		const tools = await verifyWorkspaceConnectorTools(client);
		outputChannel.appendLine(`TrueForge discovered tools: ${tools.join(', ')}`);
	} catch (error: unknown) {
		await showFailure(outputChannel, 'TrueForge could not discover the Agni workspace tools', error);
		return;
	}

	const prompt = [
		'You must call at least one attached Agni workspace tool before answering.',
		'Inspect the currently open workspace and identify what kind of project it is.',
		'Name two files from the tool result that support your answer.',
	].join(' ');
	outputChannel.appendLine(`Prompt: ${prompt}`);
	outputChannel.appendLine('Response:');

	try {
		const result = await runWorkspaceAgentTurn(client, selectedModel.modelFqn, prompt, {
			onContextAssembled: (
				referenceCount,
				byteLength,
				automaticIncluded,
				automaticOmitted,
				automaticRankOmitted,
				automaticSearchTruncated,
			) => {
				if (referenceCount > 0) {
					outputChannel.appendLine(`[Explicit context: ${referenceCount} reference(s)]`);
				}
				if (byteLength > 0) {
					outputChannel.appendLine(`[Assembled context size: ${byteLength} bytes]`);
				}
				if (automaticIncluded > 0 || automaticOmitted > 0 || automaticRankOmitted > 0) {
					outputChannel.appendLine(
						`[Automatic context: ${automaticIncluded} included, ${automaticOmitted} omitted for budget, `
						+ `${automaticRankOmitted} omitted below the rank cap]`,
					);
				}
				if (automaticSearchTruncated) {
					outputChannel.appendLine('[Automatic context search reached its deterministic scan limit.]');
				}
			},
			onMcpInitialized: () => outputChannel.appendLine('[MCP connector initialized]'),
			onText: (content) => outputChannel.append(content),
			onToolCall: (name) => outputChannel.appendLine(`\n[Tool call: ${name}]`),
			onToolResponse: (name) => outputChannel.appendLine(`[Tool result returned: ${name}]`),
			onTurnDone: (status) => outputChannel.appendLine(`\nTurn status: ${status}`),
		}, { contextBudgetBytes });
		outputChannel.appendLine(`Verified workspace tool: ${result.toolName}`);
		await vscode.window.showInformationMessage(
			`Agni verified TrueForge workspace access through ${result.toolName}; turn status: ${result.turnStatus}.`,
		);
	} catch (error: unknown) {
		await showFailure(outputChannel, 'TrueForge workspace agent test failed', error);
	}
}

async function runWorkspaceToolsTest(
	outputChannel: vscode.OutputChannel,
	mcpHost: AgniMcpHttpHost,
): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showErrorMessage('Agni workspace tools require a trusted VS Code workspace.');
		return;
	}

	if (!vscode.workspace.workspaceFolders?.length) {
		await vscode.window.showErrorMessage('Open a workspace folder before starting Agni workspace tools.');
		return;
	}

	outputChannel.show(true);
	outputChannel.appendLine('Agni: Workspace tools test');
	outputChannel.appendLine('Starting authenticated MCP server...');
	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
	const endpoint = await startAndRegisterWorkspaceConnector(client, mcpHost);
	outputChannel.appendLine(`MCP endpoint: ${endpoint.url}`);
	outputChannel.appendLine('Authentication: ephemeral bearer token enabled');
	outputChannel.appendLine(`Registered TrueForge connector: ${agniWorkspaceConnectorName}`);
	outputChannel.appendLine('Requesting tools/list...');

	const exposedTools = await mcpHost.listToolNames();
	const missingTools = agniWorkspaceToolNames.filter((name) => !exposedTools.includes(name));
	if (missingTools.length > 0) {
		throw new Error(`MCP server did not expose required tools: ${missingTools.join(', ')}.`);
	}

	outputChannel.appendLine(`Exposed tools: ${exposedTools.join(', ')}`);
	await vscode.window.showInformationMessage(
		`Agni MCP server is running on 127.0.0.1:${endpoint.port} with all workspace tools exposed.`,
	);
}

async function updateInlineEditContext(hasProposal: boolean): Promise<void> {
	await vscode.commands.executeCommand('setContext', 'agni.hasInlineEditProposal', hasProposal);
}

async function updateMultiFileContexts(hasProposal: boolean, canUndo: boolean, canApply = false): Promise<void> {
	await Promise.all([
		vscode.commands.executeCommand('setContext', 'agni.hasMultiFileProposal', hasProposal),
		vscode.commands.executeCommand('setContext', 'agni.canUndoMultiFileEdit', canUndo),
		vscode.commands.executeCommand('setContext', 'agni.canApplyMultiFileReview', canApply),
	]);
}

async function refreshMultiFileReview(
	controller: MultiFileEditController,
	diffProvider: MultiFileDiffProvider,
	treeProvider: MultiFileReviewTreeProvider,
	proposalId: string,
	key?: string,
): Promise<void> {
	treeProvider.refresh();
	if (key) {
		diffProvider.refresh(proposalId, key);
	}
	const state = controller.reviewState(proposalId);
	await updateMultiFileContexts(
		true,
		controller.store.getLastApplied() !== undefined,
		state.pending === 0,
	);
}

async function applyReviewedMultiFileEdit(
	controller: MultiFileEditController,
	proposalId: string | undefined,
	setActiveProposal: (id: string | undefined) => void,
	treeProvider: MultiFileReviewTreeProvider,
): Promise<void> {
	if (!proposalId) {
		await vscode.window.showWarningMessage('Agni has no reviewed multi-file proposal to apply.');
		return;
	}
	try {
		const review = controller.reviewState(proposalId);
		if (review.pending > 0) {
			throw new MultiFileProposalError(`Review all hunks before applying; ${review.pending} hunk(s) remain pending.`);
		}
		if (review.rejected > 0 && review.accepted > 0) {
			const confirmation = await vscode.window.showWarningMessage(
				'Some proposed hunks are rejected. Applying a partial change may leave the workspace incomplete or uncompilable.',
				{ modal: true },
				'Apply Reviewed Changes',
			);
			if (confirmation !== 'Apply Reviewed Changes') {
				return;
			}
		}

		const transaction = await controller.applyReviewed(proposalId);
		setActiveProposal(undefined);
		treeProvider.setTransaction(undefined);
		const appliedCount = controller.store.getLastAppliedBatch()?.changes.length ?? 0;
		await updateMultiFileContexts(false, appliedCount > 0);
		if (transaction.status === 'rejected') {
			await vscode.window.showInformationMessage('No Agni hunks were accepted. No workspace files were changed.');
		} else {
			await vscode.window.showInformationMessage(`Agni applied ${appliedCount} reviewed file change(s).`);
		}
	} catch (error: unknown) {
		if (error instanceof MultiFileStaleError) {
			setActiveProposal(undefined);
			treeProvider.setTransaction(undefined);
			await updateMultiFileContexts(false, controller.store.getLastApplied() !== undefined);
		} else if (controller.store.get(proposalId)?.status === 'applied') {
			setActiveProposal(undefined);
			treeProvider.setTransaction(undefined);
			await updateMultiFileContexts(false, true);
		}
		throw error;
	}
}

async function rejectMultiFileEdit(
	controller: MultiFileEditController,
	proposalId: string | undefined,
	setActiveProposal: (id: string | undefined) => void,
	treeProvider: MultiFileReviewTreeProvider,
): Promise<void> {
	if (!proposalId) {
		await vscode.window.showWarningMessage('Agni has no pending multi-file proposal to reject.');
		return;
	}
	controller.reject(proposalId);
	setActiveProposal(undefined);
	treeProvider.setTransaction(undefined);
	await updateMultiFileContexts(false, controller.store.getLastApplied() !== undefined);
	await vscode.window.showInformationMessage('Agni multi-file edit rejected. No workspace files were changed.');
}

async function undoLastMultiFileEdit(controller: MultiFileEditController): Promise<void> {
	const changeCount = controller.store.getLastAppliedBatch()?.changes.length ?? 0;
	const transaction = await controller.undoLast();
	await updateMultiFileContexts(false, false);
	await vscode.window.showInformationMessage(
		`Undid Agni multi-file edit across ${changeCount || transaction.changes.size} file(s).`,
	);
}

async function requestProposeWriteApproval(
	request: MultiFileToolApprovalRequest,
	outputChannel: vscode.OutputChannel,
	cancellationToken: vscode.CancellationToken,
): Promise<{ status: 'allow' } | { reason: string; status: 'deny' }> {
	const action = await vscode.window.showWarningMessage(
		`Agni wants permission to run ${request.toolName} and generate a workspace file-change proposal. `
		+ 'This only records a proposal for per-file and per-hunk review; it does not write any file.',
		'Allow Proposal',
		'Deny',
	);
	if (cancellationToken.isCancellationRequested) {
		return { reason: 'Multi-file edit generation was cancelled.', status: 'deny' };
	}
	if (action === 'Allow Proposal') {
		outputChannel.appendLine(`[Tool approval: allowed ${request.toolName}]`);
		return { status: 'allow' };
	}

	outputChannel.appendLine(`[Tool approval: denied ${request.toolName}]`);
	return {
		reason: action === 'Deny'
			? 'The user denied permission to generate this file-change proposal.'
			: 'The user dismissed the file-change proposal approval request.',
		status: 'deny',
	};
}

async function runMultiFileEdit(
	outputChannel: vscode.OutputChannel,
	mcpHost: AgniMcpHttpHost,
	controller: MultiFileEditController,
	diffProvider: MultiFileDiffProvider,
	treeProvider: MultiFileReviewTreeProvider,
	setActiveProposal: (id: string | undefined) => void,
): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showErrorMessage('Agni multi-file editing requires a trusted VS Code workspace.');
		return;
	}
	if (!vscode.workspace.workspaceFolders?.length) {
		await vscode.window.showErrorMessage('Open a workspace folder before running Agni multi-file editing.');
		return;
	}

	const task = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		placeHolder: 'Describe the multi-file change Agni should prepare',
		prompt: 'Agni will explore the workspace and prepare proposals. Nothing is written until you accept the reviewed batch.',
		title: 'Agni: Multi-File Edit',
		validateInput: (value) => value.trim() ? undefined : 'Enter a multi-file editing task.',
	});
	if (task === undefined) {
		return;
	}

	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const configuredModel = configuration.get<string>('selectedModel', '').trim();
	const contextBudgetBytes = vscode.workspace
		.getConfiguration('agni.context')
		.get<number>('maxBytes', defaultContextBudgetBytes);
	const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });
	let selectedModel: ModelQuickPickItem | undefined;
	try {
		selectedModel = await selectModel(client, configuredModel);
	} catch (error: unknown) {
		const message = isLikelyConnectionFailure(error)
			? `Could not connect to TrueForge at ${serverUrl}`
			: 'Failed to fetch configured models from TrueForge';
		await showFailure(outputChannel, message, error);
		return;
	}
	if (!selectedModel) {
		return;
	}

	outputChannel.show(true);
	outputChannel.appendLine('Agni: Multi-file edit');
	outputChannel.appendLine(`Model: ${selectedModel.modelFqn}`);
	outputChannel.appendLine('Starting authenticated proposal-only MCP tools...');
	await startAndRegisterWorkspaceConnector(client, mcpHost);
	await verifyMultiFileConnectorTools(client);

	const transaction = controller.store.begin(task);
	try {
		const result = await vscode.window.withProgress({
			cancellable: true,
			location: vscode.ProgressLocation.Notification,
			title: 'Agni is preparing a reviewed multi-file edit…',
		}, async (_progress, cancellationToken) => runMultiFileAgentTurn(
			client,
			selectedModel.modelFqn,
			task,
			transaction.id,
			controller.store,
			cancellationToken,
			{
				onContextAssembled: (bytes) => outputChannel.appendLine(`[Context: ${bytes} bytes]`),
				onText: (content) => outputChannel.append(content),
				onToolApprovalRequired: (request) => requestProposeWriteApproval(
					request,
					outputChannel,
					cancellationToken,
				),
				onTurnDone: (status) => outputChannel.appendLine(`\nTurn status: ${status}`),
			},
			undefined,
			contextBudgetBytes,
			(error) => {
				const details = describeError(error);
				outputChannel.appendLine(`[Error] Failed to cancel TrueForge multi-file session: ${details}`);
				console.error(`[Agni] Failed to cancel TrueForge multi-file session: ${details}`);
			},
		));

		await controller.openReview(result.transaction.id);
		setActiveProposal(result.transaction.id);
		treeProvider.setTransaction(result.transaction.id);
		await updateMultiFileContexts(true, controller.store.getLastApplied() !== undefined);
		const action = await vscode.window.showInformationMessage(
			`Review ${result.transaction.changes.size} Agni file proposal(s) in the Agni Review view and diff editors.`,
			'Accept All',
			'Reject All',
		);
		if (action === 'Accept All') {
			controller.acceptAll(result.transaction.id);
			for (const key of result.transaction.changes.keys()) {
				diffProvider.refresh(result.transaction.id, key);
			}
			treeProvider.refresh();
			await applyReviewedMultiFileEdit(
				controller,
				result.transaction.id,
				setActiveProposal,
				treeProvider,
			);
		} else if (action === 'Reject All') {
			await rejectMultiFileEdit(controller, result.transaction.id, setActiveProposal, treeProvider);
		}
	} catch (error: unknown) {
		const current = controller.store.get(transaction.id);
		if (current?.status === 'generating') {
			controller.store.cancel(transaction.id);
		} else if (current?.status === 'review') {
			controller.store.reject(transaction.id);
		}
		if (error instanceof MultiFileEditCancelledError
			|| (error instanceof MultiFileProposalError && /cancelled/iu.test(error.message))) {
			outputChannel.appendLine('Multi-file edit generation cancelled. No workspace files were changed.');
			return;
		}
		throw error;
	}
}

async function acceptInlineEditProposal(
	controller: InlineEditController,
	decorationManager: InlineEditDecorationManager,
	proposalId: string | undefined,
	setActiveProposal: (id: string | undefined) => void,
): Promise<void> {
	if (!proposalId) {
		await vscode.window.showWarningMessage('Agni has no pending inline edit proposal to accept.');
		return;
	}

	try {
		await controller.accept(proposalId);
		decorationManager.clear();
		setActiveProposal(undefined);
		await updateInlineEditContext(false);
		await vscode.window.showInformationMessage('Agni inline edit accepted and applied.');
	} catch (error: unknown) {
		if (error instanceof InlineEditStaleProposalError) {
			decorationManager.clear();
			setActiveProposal(undefined);
			await updateInlineEditContext(false);
		}
		throw error;
	}
}

async function rejectInlineEditProposal(
	controller: InlineEditController,
	decorationManager: InlineEditDecorationManager,
	proposalId: string | undefined,
	setActiveProposal: (id: string | undefined) => void,
): Promise<void> {
	if (!proposalId) {
		await vscode.window.showWarningMessage('Agni has no pending inline edit proposal to reject.');
		return;
	}

	controller.reject(proposalId);
	decorationManager.clear();
	setActiveProposal(undefined);
	await updateInlineEditContext(false);
	await vscode.window.showInformationMessage('Agni inline edit rejected. The document was not changed.');
}

async function runInlineEdit(
	outputChannel: vscode.OutputChannel,
	controller: InlineEditController,
	decorationManager: InlineEditDecorationManager,
	setActiveProposal: (id: string | undefined) => void,
): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		await vscode.window.showErrorMessage('Agni inline editing requires a trusted VS Code workspace.');
		return;
	}

	const editor = vscode.window.activeTextEditor;
	if (!editor || editor.selection.isEmpty) {
		await vscode.window.showErrorMessage('Select non-empty code before running Agni: Inline Edit.');
		return;
	}

	const instruction = await vscode.window.showInputBox({
		ignoreFocusOut: true,
		placeHolder: 'Describe how Agni should change the selected code',
		prompt: 'Agni will generate a proposal and will not change the document until you accept it.',
		title: 'Agni: Inline Edit',
		validateInput: (value) => value.trim() ? undefined : 'Enter an editing instruction.',
	});
	if (instruction === undefined) {
		return;
	}

	const target = await captureInlineEditTarget(editor, instruction);
	decorationManager.show(editor, target.range);
	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const configuredModel = configuration.get<string>('selectedModel', '').trim();
	const contextBudgetBytes = vscode.workspace
		.getConfiguration('agni.context')
		.get<number>('maxBytes', defaultContextBudgetBytes);
	const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 600 });

	let selectedModel: ModelQuickPickItem | undefined;
	try {
		selectedModel = await selectModel(client, configuredModel);
	} catch (error: unknown) {
		decorationManager.clear();
		const message = isLikelyConnectionFailure(error)
			? `Could not connect to TrueForge at ${serverUrl}`
			: 'Failed to fetch configured models from TrueForge';
		await showFailure(outputChannel, message, error);
		return;
	}
	if (!selectedModel) {
		decorationManager.clear();
		return;
	}

	const generator = new TrueForgeInlineEditGenerator(
		client,
		selectedModel.modelFqn,
		contextBudgetBytes,
		undefined,
		(error) => {
			const details = describeError(error);
			outputChannel.appendLine(`[Error] Failed to cancel the TrueForge inline edit session: ${details}`);
			console.error(`[Agni] Failed to cancel the TrueForge inline edit session: ${details}`);
		},
	);

	outputChannel.show(true);
	outputChannel.appendLine(`Agni inline edit: ${target.root}/${target.filePath}`);
	outputChannel.appendLine(`Instruction: ${instruction}`);
	let proposalId: string;
	try {
		const proposal = await vscode.window.withProgress({
			cancellable: true,
			location: vscode.ProgressLocation.Notification,
			title: 'Agni is generating an inline edit proposal…',
		}, async (_progress, cancellationToken) => controller.generateProposal(
			target,
			generator,
			cancellationToken,
		));
		proposalId = proposal.id;
		setActiveProposal(proposal.id);
		await updateInlineEditContext(true);
		outputChannel.appendLine(`Proposal ready: ${proposal.id}`);
	} catch (error: unknown) {
		decorationManager.clear();
		if (error instanceof InlineEditCancelledError
			|| (error instanceof InlineEditProposalError && /cancelled/iu.test(error.message))) {
			outputChannel.appendLine('Inline edit generation cancelled.');
			return;
		}
		throw error;
	}

	const action = await vscode.window.showInformationMessage(
		'Agni inline edit proposal is open in the diff editor.',
		'Accept',
		'Reject',
	);
	if (action === 'Accept') {
		await acceptInlineEditProposal(controller, decorationManager, proposalId, setActiveProposal);
	} else if (action === 'Reject') {
		await rejectInlineEditProposal(controller, decorationManager, proposalId, setActiveProposal);
	}
}

async function registerWorkspaceConnectorForCurrentExtensionHost(
	outputChannel: vscode.OutputChannel,
	mcpHost: AgniMcpHttpHost,
): Promise<void> {
	if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
		return;
	}

	const configuration = vscode.workspace.getConfiguration(configurationSection);
	const serverUrl = configuration.get<string>('serverUrl', defaultServerUrl).trim() || defaultServerUrl;
	const client = new TrueForge({ baseUrl: serverUrl, timeoutInSeconds: 15 });
	try {
		const endpoint = await startAndRegisterWorkspaceConnector(client, mcpHost);
		outputChannel.appendLine(
			`[MCP] Registered ${agniWorkspaceConnectorName} for this Extension Host at ${endpoint.url}.`,
		);
	} catch (error: unknown) {
		const details = describeError(error);
		outputChannel.appendLine(`[MCP] Connector registration deferred: ${details}`);
		console.warn(`[Agni] MCP connector registration deferred: ${details}`);
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const outputChannel = vscode.window.createOutputChannel('Agni');
	const multiFileStore = new MultiFileProposalStore();
	const multiFileDiffProvider = new MultiFileDiffProvider(multiFileStore);
	registerMultiFileDiffProvider(context, multiFileDiffProvider);
	const multiFileCodeLensProvider = new MultiFileEditCodeLensProvider(multiFileStore);
	registerMultiFileEditCodeLensProvider(context, multiFileCodeLensProvider);
	const multiFileReviewTreeProvider = new MultiFileReviewTreeProvider(multiFileStore);
	const multiFileReviewTree = vscode.window.createTreeView(multiFileReviewViewId, {
		showCollapseAll: true,
		treeDataProvider: multiFileReviewTreeProvider,
	});
	const multiFileController = new MultiFileEditController(
		new VsCodeMultiFileWorkspace(),
		multiFileDiffProvider,
		multiFileStore,
	);
	let activeMultiFileProposalId: string | undefined;
	const setActiveMultiFileProposal = (id: string | undefined): void => {
		activeMultiFileProposalId = id;
	};
	const inlineEditStore = new InlineEditProposalStore();
	const inlineEditDecorationManager = new InlineEditDecorationManager();
	const inlineEditDiffProvider = new InlineEditDiffProvider(inlineEditStore);
	registerInlineEditDiffProvider(context, inlineEditDiffProvider);
	const inlineEditController = new InlineEditController(
		new VsCodeInlineEditWorkspace(),
		inlineEditDiffProvider,
		inlineEditStore,
	);
	let activeInlineEditProposalId: string | undefined;
	const setActiveInlineEditProposal = (id: string | undefined): void => {
		activeInlineEditProposalId = id;
	};
	const mcpHost = new AgniMcpHttpHost(undefined, (error) => {
		const details = describeError(error);
		outputChannel.appendLine(`[MCP Error] ${details}`);
		console.error(`[Agni] MCP server error: ${details}`);
	}, multiFileStore);
	activeMcpHost = mcpHost;
	const command = vscode.commands.registerCommand(commandId, async () => {
		try {
			await runConnectionTest(outputChannel);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Unexpected Agni connection test failure', error);
		}
	});
	const workspaceToolsCommand = vscode.commands.registerCommand(workspaceToolsCommandId, async () => {
		try {
			await runWorkspaceToolsTest(outputChannel, mcpHost);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Agni workspace tools test failed', error);
		}
	});
	const trueForgeWorkspaceCommand = vscode.commands.registerCommand(trueForgeWorkspaceCommandId, async () => {
		try {
			await runTrueForgeWorkspaceTest(outputChannel, mcpHost);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Unexpected Agni TrueForge workspace test failure', error);
		}
	});
	const inlineEditCommand = vscode.commands.registerCommand(inlineEditCommandId, async () => {
		try {
			await runInlineEdit(
				outputChannel,
				inlineEditController,
				inlineEditDecorationManager,
				setActiveInlineEditProposal,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Agni inline edit failed', error);
		}
	});
	const acceptInlineEditCommand = vscode.commands.registerCommand(acceptInlineEditCommandId, async () => {
		try {
			await acceptInlineEditProposal(
				inlineEditController,
				inlineEditDecorationManager,
				activeInlineEditProposalId,
				setActiveInlineEditProposal,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Could not accept Agni inline edit', error);
		}
	});
	const rejectInlineEditCommand = vscode.commands.registerCommand(rejectInlineEditCommandId, async () => {
		try {
			await rejectInlineEditProposal(
				inlineEditController,
				inlineEditDecorationManager,
				activeInlineEditProposalId,
				setActiveInlineEditProposal,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Could not reject Agni inline edit', error);
		}
	});
	const multiFileEditCommand = vscode.commands.registerCommand(multiFileEditCommandId, async () => {
		try {
			await runMultiFileEdit(
				outputChannel,
				mcpHost,
				multiFileController,
				multiFileDiffProvider,
				multiFileReviewTreeProvider,
				setActiveMultiFileProposal,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Agni multi-file edit failed', error);
		}
	});
	const acceptMultiFileEditCommand = vscode.commands.registerCommand(acceptMultiFileEditCommandId, async () => {
		try {
			if (!activeMultiFileProposalId) {
				await vscode.window.showWarningMessage('Agni has no pending multi-file proposal to accept.');
				return;
			}
			const transaction = multiFileController.acceptAll(activeMultiFileProposalId);
			for (const key of transaction.changes.keys()) {
				multiFileDiffProvider.refresh(transaction.id, key);
			}
			multiFileReviewTreeProvider.refresh();
			await applyReviewedMultiFileEdit(
				multiFileController,
				activeMultiFileProposalId,
				setActiveMultiFileProposal,
				multiFileReviewTreeProvider,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Could not accept Agni multi-file edit', error);
		}
	});
	const rejectMultiFileEditCommand = vscode.commands.registerCommand(rejectMultiFileEditCommandId, async () => {
		try {
			await rejectMultiFileEdit(
				multiFileController,
				activeMultiFileProposalId,
				setActiveMultiFileProposal,
				multiFileReviewTreeProvider,
			);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Could not reject Agni multi-file edit', error);
		}
	});
	const undoMultiFileEditCommand = vscode.commands.registerCommand(undoMultiFileEditCommandId, async () => {
		try {
			await undoLastMultiFileEdit(multiFileController);
		} catch (error: unknown) {
			await showFailure(outputChannel, 'Could not undo Agni multi-file edit', error);
		}
	});
	const applyReviewedMultiFileEditCommand = vscode.commands.registerCommand(
		applyReviewedMultiFileEditCommandId,
		async () => {
			try {
				await applyReviewedMultiFileEdit(
					multiFileController,
					activeMultiFileProposalId,
					setActiveMultiFileProposal,
					multiFileReviewTreeProvider,
				);
			} catch (error: unknown) {
				await showFailure(outputChannel, 'Could not apply reviewed Agni changes', error);
			}
		},
	);
	const acceptMultiFileCommand = vscode.commands.registerCommand(
		acceptMultiFileCommandId,
		async (node: MultiFileReviewFileNode | undefined) => {
			if (!node) {
				await vscode.window.showWarningMessage('Select a file in the Agni Review view.');
				return;
			}
			multiFileController.acceptFile(node.transactionId, node.key);
			await refreshMultiFileReview(
				multiFileController,
				multiFileDiffProvider,
				multiFileReviewTreeProvider,
				node.transactionId,
				node.key,
			);
		},
	);
	const rejectMultiFileCommand = vscode.commands.registerCommand(
		rejectMultiFileCommandId,
		async (node: MultiFileReviewFileNode | undefined) => {
			if (!node) {
				await vscode.window.showWarningMessage('Select a file in the Agni Review view.');
				return;
			}
			multiFileController.rejectFile(node.transactionId, node.key);
			await refreshMultiFileReview(
				multiFileController,
				multiFileDiffProvider,
				multiFileReviewTreeProvider,
				node.transactionId,
				node.key,
			);
		},
	);
	const acceptMultiFileHunkCommand = vscode.commands.registerCommand(
		acceptMultiFileHunkCommandId,
		async (value: MultiFileReviewHunkNode | MultiFileHunkCommandTarget | undefined) => {
			const target = resolveMultiFileHunkTarget(value);
			if (!target) {
				await vscode.window.showWarningMessage('Select a hunk in the Agni Review view.');
				return;
			}
			multiFileController.acceptHunk(target.transactionId, target.changeKey, target.hunkId);
			await refreshMultiFileReview(
				multiFileController,
				multiFileDiffProvider,
				multiFileReviewTreeProvider,
				target.transactionId,
				target.changeKey,
			);
		},
	);
	const rejectMultiFileHunkCommand = vscode.commands.registerCommand(
		rejectMultiFileHunkCommandId,
		async (value: MultiFileReviewHunkNode | MultiFileHunkCommandTarget | undefined) => {
			const target = resolveMultiFileHunkTarget(value);
			if (!target) {
				await vscode.window.showWarningMessage('Select a hunk in the Agni Review view.');
				return;
			}
			multiFileController.rejectHunk(target.transactionId, target.changeKey, target.hunkId);
			await refreshMultiFileReview(
				multiFileController,
				multiFileDiffProvider,
				multiFileReviewTreeProvider,
				target.transactionId,
				target.changeKey,
			);
		},
	);
	const openMultiFileReviewCommand = vscode.commands.registerCommand(
		openMultiFileReviewCommandId,
		async (transactionOrNode: unknown, keyArgument: unknown) => {
			const transactionId = transactionOrNode instanceof MultiFileReviewFileNode
				|| transactionOrNode instanceof MultiFileReviewHunkNode
				? transactionOrNode.transactionId
				: transactionOrNode;
			const key = transactionOrNode instanceof MultiFileReviewFileNode
				|| transactionOrNode instanceof MultiFileReviewHunkNode
				? transactionOrNode.key
				: keyArgument;
			if (typeof transactionId !== 'string' || typeof key !== 'string') {
				return;
			}
			await multiFileDiffProvider.showFile(transactionId, key);
		},
	);

	context.subscriptions.push(
		outputChannel,
		mcpHost,
		multiFileStore,
		multiFileReviewTreeProvider,
		multiFileReviewTree,
		inlineEditStore,
		inlineEditDecorationManager,
		command,
		workspaceToolsCommand,
		trueForgeWorkspaceCommand,
		inlineEditCommand,
		acceptInlineEditCommand,
		rejectInlineEditCommand,
		multiFileEditCommand,
		acceptMultiFileEditCommand,
		rejectMultiFileEditCommand,
		undoMultiFileEditCommand,
		applyReviewedMultiFileEditCommand,
		acceptMultiFileCommand,
		rejectMultiFileCommand,
		acceptMultiFileHunkCommand,
		rejectMultiFileHunkCommand,
		openMultiFileReviewCommand,
	);

	await registerWorkspaceConnectorForCurrentExtensionHost(outputChannel, mcpHost);
}

export async function deactivate(): Promise<void> {
	const mcpHost = activeMcpHost;
	activeMcpHost = undefined;
	mcpHost?.dispose();
	await mcpHost?.stop();
}
