import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { type AssembledContext } from '../context/contextAssembler.js';
import { type MultiFileToolActivity } from '../trueforge/multiFileEditAgent.js';

export const agniAgentPanelViewId = 'agni.agentPanel';

export interface AgentPanelContextFile {
	path: string;
	reason: string;
	root: string;
}

export interface AgentPanelContextEvidence {
	byteLength: number;
	files: AgentPanelContextFile[];
	omittedForBudget: number;
}

export interface AgentPanelSessionInfo {
	model: string;
	serverUrl: string;
	sessionId?: string;
}

export interface AgentPanelTaskResult {
	proposalCount: number;
	transactionId: string;
	turnStatus: string;
}

export interface AgentPanelProposalState {
	canApply: boolean;
	canOpenReview: boolean;
	canReject: boolean;
	canUndo: boolean;
	hasPendingProposal: boolean;
	transactionId?: string;
}

export interface AgentPanelRunEvents {
	appendText(content: string): void;
	context(evidence: AgentPanelContextEvidence): void;
	session(info: AgentPanelSessionInfo): void;
	status(message: string): void;
	toolActivity(activity: MultiFileToolActivity): void;
}

export type AgentPanelTaskRunner = (
	task: string,
	cancellationToken: vscode.CancellationToken,
	events: AgentPanelRunEvents,
) => Promise<AgentPanelTaskResult | undefined>;

export interface AgentPanelActions {
	applyReviewed(): Promise<void>;
	openReview(): Promise<void>;
	rejectReviewed(): Promise<void>;
	undo(): Promise<void>;
}

interface PanelInboundMessage {
	task?: unknown;
	type?: unknown;
}

interface MutableContextFile {
	automaticLines: string[];
	explicitReasons: string[];
	matchedTerms: Set<string>;
	path: string;
	root: string;
	score: number;
}

export function buildAgentPanelContextEvidence(context: AssembledContext): AgentPanelContextEvidence {
	const files = new Map<string, MutableContextFile>();
	const ensure = (root: string, path: string): MutableContextFile => {
		const key = `${root}\0${path}`;
		const existing = files.get(key);
		if (existing) {
			return existing;
		}
		const created: MutableContextFile = {
			automaticLines: [],
			explicitReasons: [],
			matchedTerms: new Set(),
			path,
			root,
			score: 0,
		};
		files.set(key, created);
		return created;
	};

	for (const reference of context.references) {
		const file = ensure(reference.root, reference.path);
		file.explicitReasons.push(reference.kind === 'symbol'
			? `Explicit @symbol reference${reference.symbol ? ` to ${reference.symbol}` : ''}.`
			: 'Explicit @file reference.');
	}

	for (const snippet of context.automatic.included) {
		const file = ensure(snippet.root, snippet.path);
		file.automaticLines.push(`${snippet.startLine}-${snippet.endLine}`);
		file.score = Math.max(file.score, snippet.score);
		for (const term of snippet.matchedTerms) {
			file.matchedTerms.add(term);
		}
	}

	return {
		byteLength: context.byteLength,
		files: [...files.values()]
			.sort((left, right) => left.root.localeCompare(right.root) || left.path.localeCompare(right.path))
			.map((file) => {
				const reasons = [...file.explicitReasons];
				if (file.automaticLines.length > 0) {
					const terms = [...file.matchedTerms].sort().join(', ') || context.automatic.terms.join(', ');
					reasons.push(
						`Automatically retrieved from task terms${terms ? ` (${terms})` : ''}; `
						+ `relevance score ${file.score}; lines ${file.automaticLines.join(', ')}.`,
					);
				}
				return { path: file.path, reason: reasons.join(' '), root: file.root };
			}),
		omittedForBudget: context.automatic.omittedForBudget,
	};
}

function nonce(): string {
	return randomBytes(18).toString('base64url');
}

function panelHtml(webview: vscode.Webview): string {
	const scriptNonce = nonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
	<style>
		body { padding: 10px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
		#messages { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
		.message, .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
		.user { background: var(--vscode-textBlockQuote-background); }
		.assistant { background: var(--vscode-editor-background); }
		.status { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
		.context-file { margin-top: 6px; }
		.context-file strong { display: block; }
		textarea { box-sizing: border-box; width: 100%; min-height: 88px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; }
		.actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
		button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 6px 10px; cursor: pointer; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
		button:disabled { opacity: 0.55; cursor: default; }
	</style>
</head>
<body>
	<div id="messages" aria-live="polite"></div>
	<form id="task-form">
		<label for="task"><strong>Ask Agni to change the workspace</strong></label>
		<textarea id="task" placeholder="Describe the task. Agni will discover relevant files through TrueForge." required></textarea>
		<div class="actions">
			<button id="send" type="submit">Send</button>
			<button id="cancel" class="secondary" type="button" disabled>Cancel</button>
		</div>
	</form>
	<div id="review-actions" class="actions" hidden>
		<button id="open-review" type="button">Open Agni Review</button>
		<button id="apply-reviewed" type="button">Apply Reviewed Changes</button>
		<button id="reject-reviewed" class="secondary" type="button">Reject Proposal</button>
		<button id="undo" class="secondary" type="button">Undo Last Edit</button>
	</div>
	<script nonce="${scriptNonce}">
		const vscode = acquireVsCodeApi();
		const messages = document.getElementById('messages');
		const form = document.getElementById('task-form');
		const task = document.getElementById('task');
		const send = document.getElementById('send');
		const cancel = document.getElementById('cancel');
		const reviewActions = document.getElementById('review-actions');
		const openReview = document.getElementById('open-review');
		const applyReviewed = document.getElementById('apply-reviewed');
		const rejectReviewed = document.getElementById('reject-reviewed');
		const undo = document.getElementById('undo');
		let assistantMessage;
		function add(className, text) {
			const element = document.createElement('div');
			element.className = className;
			element.textContent = text;
			messages.appendChild(element);
			element.scrollIntoView({ block: 'end' });
			return element;
		}
		function setRunning(running) {
			send.disabled = running;
			cancel.disabled = !running;
			task.disabled = running;
		}
		function setProposalState(state) {
			openReview.disabled = !state.canOpenReview;
			applyReviewed.disabled = !state.canApply;
			rejectReviewed.disabled = !state.canReject;
			undo.disabled = !state.canUndo;
			reviewActions.hidden = !(
				state.canOpenReview || state.canApply || state.canReject || state.canUndo
			);
		}
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			const value = task.value.trim();
			if (!value) return;
			add('message user', value);
			assistantMessage = undefined;
			setRunning(true);
			vscode.postMessage({ type: 'submit', task: value });
		});
		cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
		openReview.addEventListener('click', () => vscode.postMessage({ type: 'openReview' }));
		applyReviewed.addEventListener('click', () => vscode.postMessage({ type: 'applyReviewed' }));
		rejectReviewed.addEventListener('click', () => vscode.postMessage({ type: 'rejectReviewed' }));
		undo.addEventListener('click', () => vscode.postMessage({ type: 'undo' }));
		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'status') add('status', message.message);
			if (message.type === 'proposalState') setProposalState(message.state);
			if (message.type === 'toolActivity') {
				const allowedTools = new Set(['read_file', 'list_files', 'search_code', 'propose_write']);
				const statusLabels = {
					'awaiting-approval': 'awaiting approval',
					completed: 'completed',
					started: 'started',
				};
				const label = statusLabels[message.activity?.status];
				if (allowedTools.has(message.activity?.toolName) && label) {
					add('status', 'Tool ' + message.activity.toolName + ': ' + label + '.');
				}
			}
			if (message.type === 'session') {
				add('card', 'TrueForge session\\nServer: ' + message.info.serverUrl + '\\nModel: ' + message.info.model + (message.info.sessionId ? '\\nSession: ' + message.info.sessionId : ''));
			}
			if (message.type === 'context') {
				const card = add('card', 'Workspace context: ' + message.evidence.byteLength + ' bytes');
				for (const file of message.evidence.files) {
					const row = document.createElement('div');
					row.className = 'context-file';
					const name = document.createElement('strong');
					name.textContent = file.root + '/' + file.path;
					const reason = document.createElement('span');
					reason.textContent = file.reason;
					row.append(name, reason);
					card.appendChild(row);
				}
				if (message.evidence.omittedForBudget > 0) {
					const omitted = document.createElement('div');
					omitted.className = 'status';
					omitted.textContent = message.evidence.omittedForBudget + ' snippet(s) omitted to respect the context budget.';
					card.appendChild(omitted);
				}
			}
			if (message.type === 'text') {
				assistantMessage ??= add('message assistant', '');
				assistantMessage.textContent += message.content;
			}
			if (message.type === 'complete') {
				setRunning(false);
				add('status', 'Proposal ready: ' + message.result.proposalCount + ' file(s), turn ' + message.result.turnStatus + '. Review before applying.');
			}
			if (message.type === 'cancelled') {
				setRunning(false);
				add('status', message.message);
			}
			if (message.type === 'error') {
				setRunning(false);
				add('message card', 'Error: ' + message.message);
			}
		});
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
}

export class AgniAgentPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private activeRun: vscode.CancellationTokenSource | undefined;
	private messageSubscription: vscode.Disposable | undefined;
	private proposalState: AgentPanelProposalState = {
		canApply: false,
		canOpenReview: false,
		canReject: false,
		canUndo: false,
		hasPendingProposal: false,
	};
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly runner: AgentPanelTaskRunner,
		private readonly actions: AgentPanelActions,
	) {}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.messageSubscription?.dispose();
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = panelHtml(view.webview);
		this.messageSubscription = view.webview.onDidReceiveMessage((message: PanelInboundMessage) => {
			void this.handleMessage(message);
		});
	}

	updateProposalState(state: AgentPanelProposalState): void {
		this.proposalState = { ...state };
		this.postProposalState();
	}

	dispose(): void {
		this.activeRun?.cancel();
		this.activeRun?.dispose();
		this.activeRun = undefined;
		this.messageSubscription?.dispose();
		this.messageSubscription = undefined;
		this.view = undefined;
	}

	private async handleMessage(message: PanelInboundMessage): Promise<void> {
		if (message.type === 'ready') {
			this.postProposalState();
			return;
		}
		if (message.type === 'cancel') {
			this.activeRun?.cancel();
			return;
		}
		if (message.type === 'openReview') {
			if (!this.proposalState.canOpenReview) {
				this.rejectUnavailableAction('There is no Agni proposal available to review.');
				return;
			}
			await this.runAction(() => this.actions.openReview());
			return;
		}
		if (message.type === 'applyReviewed') {
			if (!this.proposalState.canApply) {
				this.rejectUnavailableAction('Review every Agni hunk before applying the proposal.');
				return;
			}
			await this.runAction(() => this.actions.applyReviewed());
			return;
		}
		if (message.type === 'rejectReviewed') {
			if (!this.proposalState.canReject) {
				this.rejectUnavailableAction('There is no pending Agni proposal to reject.');
				return;
			}
			await this.runAction(() => this.actions.rejectReviewed());
			return;
		}
		if (message.type === 'undo') {
			if (!this.proposalState.canUndo) {
				this.rejectUnavailableAction('There is no applied Agni edit available to undo.');
				return;
			}
			await this.runAction(() => this.actions.undo());
			return;
		}
		if (message.type !== 'submit' || typeof message.task !== 'string' || !message.task.trim()) {
			return;
		}
		if (this.activeRun) {
			this.post({ message: 'Agni is already running a task.', type: 'error' });
			return;
		}
		if (this.proposalState.hasPendingProposal) {
			this.post({
				message: 'Review or reject the existing Agni proposal before starting another task.',
				type: 'error',
			});
			this.postProposalState();
			return;
		}

		const cancellation = new vscode.CancellationTokenSource();
		this.activeRun = cancellation;
		const postWhileActive = (payload: unknown): void => {
			if (this.activeRun === cancellation && !cancellation.token.isCancellationRequested) {
				this.post(payload);
			}
		};
		try {
			const result = await this.runner(message.task.trim(), cancellation.token, {
				appendText: (content) => postWhileActive({ content, type: 'text' }),
				context: (evidence) => postWhileActive({ evidence, type: 'context' }),
				session: (info) => postWhileActive({ info, type: 'session' }),
				status: (statusMessage) => postWhileActive({ message: statusMessage, type: 'status' }),
				toolActivity: (activity) => postWhileActive({ activity, type: 'toolActivity' }),
			});
			if (cancellation.token.isCancellationRequested || !result) {
				this.post({ message: 'Agni task cancelled. No workspace files were changed.', type: 'cancelled' });
			} else {
				this.post({ result, type: 'complete' });
			}
		} catch (error: unknown) {
			if (cancellation.token.isCancellationRequested) {
				this.post({ message: 'Agni task cancelled. No workspace files were changed.', type: 'cancelled' });
			} else {
				this.post({ message: error instanceof Error ? error.message : String(error), type: 'error' });
			}
		} finally {
			if (this.activeRun === cancellation) {
				this.activeRun = undefined;
			}
			cancellation.dispose();
		}
	}

	private async runAction(action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error: unknown) {
			this.post({ message: error instanceof Error ? error.message : String(error), type: 'error' });
		}
	}

	private post(payload: unknown): void {
		void this.view?.webview.postMessage(payload);
	}

	private rejectUnavailableAction(message: string): void {
		this.post({ message, type: 'error' });
		this.postProposalState();
	}

	private postProposalState(): void {
		this.post({ state: this.proposalState, type: 'proposalState' });
	}
}
