import * as assert from 'node:assert';
import { Script } from 'node:vm';
import * as vscode from 'vscode';
import {
	AgniAgentPanelProvider,
	buildAgentPanelContextEvidence,
	type AgentPanelActions,
	type AgentPanelProposalState,
	type AgentPanelTaskRunner,
} from '../agentPanel/agniAgentPanel.js';
import { type AssembledContext } from '../context/contextAssembler.js';

class FakeWebview {
	readonly cspSource = 'vscode-webview://agni-panel-test';
	html = '';
	readonly messages: unknown[] = [];
	options: vscode.WebviewOptions = {};
	private readonly receiveEmitter = new vscode.EventEmitter<unknown>();
	readonly onDidReceiveMessage = this.receiveEmitter.event;

	asWebviewUri(uri: vscode.Uri): vscode.Uri {
		return uri;
	}

	fire(message: unknown): void {
		this.receiveEmitter.fire(message);
	}

	postMessage(message: unknown): Thenable<boolean> {
		this.messages.push(message);
		return Promise.resolve(true);
	}

	dispose(): void {
		this.receiveEmitter.dispose();
	}
}

function actions(overrides: Partial<AgentPanelActions> = {}): AgentPanelActions {
	return {
		applyReviewed: async () => undefined,
		openReview: async () => undefined,
		rejectReviewed: async () => undefined,
		undo: async () => undefined,
		...overrides,
	};
}

function resolve(provider: AgniAgentPanelProvider): FakeWebview {
	const webview = new FakeWebview();
	provider.resolveWebviewView({ webview } as unknown as vscode.WebviewView);
	return webview;
}

function browserScript(html: string): string {
	const match = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html);
	assert.ok(match, 'Expected the Agni panel HTML to contain its nonce-protected browser script.');
	return match[1];
}

function proposalState(overrides: Partial<AgentPanelProposalState> = {}): AgentPanelProposalState {
	return {
		canApply: false,
		canOpenReview: false,
		canReject: false,
		canUndo: false,
		hasPendingProposal: false,
		...overrides,
	};
}

async function waitForMessage(webview: FakeWebview, type: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const found = webview.messages.find((message): message is Record<string, unknown> =>
			typeof message === 'object'
			&& message !== null
			&& (message as { type?: unknown }).type === type,
		);
		if (found) {
			return found;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
	}
	assert.fail(`Panel did not post a ${type} message.`);
}

suite('Agni Agent Panel', () => {
	test('resolves non-empty HTML with a syntactically valid browser script', () => {
		const provider = new AgniAgentPanelProvider(async () => undefined, actions());
		const first = resolve(provider);
		const firstScript = browserScript(first.html);

		assert.match(first.html, /Ask Agni to change the workspace/u);
		assert.match(firstScript, /TrueForge session\\nServer:/u);
		assert.match(firstScript, /message\.type === 'proposalState'/u);
		assert.doesNotMatch(firstScript, /reviewActions\.hidden = true/u);
		assert.doesNotThrow(() => new Script(firstScript));

		const second = resolve(provider);
		assert.match(second.html, /Ask Agni to change the workspace/u);
		assert.doesNotThrow(() => new Script(browserScript(second.html)));

		provider.dispose();
		first.dispose();
		second.dispose();
	});

	test('explains explicit and automatic context selections within the byte budget', () => {
		const context: AssembledContext = {
			automatic: {
				candidateCount: 4,
				included: [{
					endLine: 20,
					matchedTerms: ['debug', 'flag'],
					path: 'src/flask/helpers.py',
					root: 'flask',
					score: 420,
					startLine: 10,
				}],
				omittedByRanking: 0,
				omittedForBudget: 2,
				skippedFiles: 3,
				terms: ['debug', 'flag'],
				truncatedSearch: false,
			},
			byteLength: 4096,
			content: 'context',
			references: [{ kind: 'symbol', path: 'src/flask/app.py', root: 'flask', symbol: 'Flask' }],
		};

		const evidence = buildAgentPanelContextEvidence(context);

		assert.strictEqual(evidence.byteLength, 4096);
		assert.strictEqual(evidence.omittedForBudget, 2);
		assert.deepStrictEqual(evidence.files.map((file) => `${file.root}/${file.path}`), [
			'flask/src/flask/app.py',
			'flask/src/flask/helpers.py',
		]);
		assert.match(evidence.files[0].reason, /Explicit @symbol reference to Flask/u);
		assert.match(evidence.files[1].reason, /debug, flag/u);
		assert.match(evidence.files[1].reason, /relevance score 420/u);
	});

	test('submits a chat task, streams run evidence, and reuses review commands', async () => {
		let receivedTask = '';
		const invoked: string[] = [];
		const runner: AgentPanelTaskRunner = async (task, _token, events) => {
			receivedTask = task;
			events.status('Connecting');
			events.session({ model: 'provider/model', serverUrl: 'http://localhost:8790', sessionId: 'session-1' });
			events.context({ byteLength: 10, files: [], omittedForBudget: 0 });
			events.toolActivity({ status: 'started', toolName: 'read_file' });
			events.toolActivity({ status: 'completed', toolName: 'read_file' });
			events.toolActivity({ status: 'awaiting-approval', toolName: 'propose_write' });
			events.appendText('Streaming response');
			return { proposalCount: 3, transactionId: 'transaction-1', turnStatus: 'done' };
		};
		const provider = new AgniAgentPanelProvider(runner, actions({
			applyReviewed: async () => { invoked.push('apply'); },
			openReview: async () => { invoked.push('review'); },
			rejectReviewed: async () => { invoked.push('reject'); },
			undo: async () => { invoked.push('undo'); },
		}));
		const webview = resolve(provider);

		assert.strictEqual(webview.options.enableScripts, true);
		assert.match(webview.html, /Content-Security-Policy/u);
		assert.match(webview.html, /Ask Agni to change the workspace/u);
		webview.fire({ task: 'Update the relevant behavior without naming files.', type: 'submit' });
		const completion = await waitForMessage(webview, 'complete');

		assert.strictEqual(receivedTask, 'Update the relevant behavior without naming files.');
		assert.deepStrictEqual(completion.result, {
			proposalCount: 3,
			transactionId: 'transaction-1',
			turnStatus: 'done',
		});
		assert.ok(webview.messages.some((message) => (message as { type?: string }).type === 'session'));
		assert.ok(webview.messages.some((message) => (message as { type?: string }).type === 'context'));
		assert.ok(webview.messages.some((message) => (message as { type?: string }).type === 'text'));
		assert.deepStrictEqual(
			webview.messages.filter((message) => (message as { type?: string }).type === 'toolActivity'),
			[
				{ activity: { status: 'started', toolName: 'read_file' }, type: 'toolActivity' },
				{ activity: { status: 'completed', toolName: 'read_file' }, type: 'toolActivity' },
				{ activity: { status: 'awaiting-approval', toolName: 'propose_write' }, type: 'toolActivity' },
			],
		);
		provider.updateProposalState(proposalState({
			canApply: true,
			canOpenReview: true,
			canReject: true,
			canUndo: true,
			hasPendingProposal: true,
			transactionId: 'transaction-1',
		}));

		for (const type of ['openReview', 'applyReviewed', 'rejectReviewed', 'undo']) {
			webview.fire({ type });
		}
		for (let attempt = 0; attempt < 100 && invoked.length < 4; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		}
		assert.deepStrictEqual(invoked.sort(), ['apply', 'reject', 'review', 'undo']);

		provider.dispose();
		webview.dispose();
	});

	test('synchronizes review actions after apply and reject', async () => {
		let provider: AgniAgentPanelProvider;
		const appliedState = proposalState({ canUndo: true });
		const rejectedState = proposalState();
		provider = new AgniAgentPanelProvider(async () => undefined, actions({
			applyReviewed: async () => { provider.updateProposalState(appliedState); },
			rejectReviewed: async () => { provider.updateProposalState(rejectedState); },
		}));
		const webview = resolve(provider);
		const pending = proposalState({
			canApply: true,
			canOpenReview: true,
			canReject: true,
			hasPendingProposal: true,
			transactionId: 'transaction-review',
		});

		provider.updateProposalState(pending);
		webview.fire({ type: 'applyReviewed' });
		for (let attempt = 0; attempt < 100 && webview.messages.length < 2; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		}
		assert.deepStrictEqual(webview.messages.at(-1), { state: appliedState, type: 'proposalState' });

		provider.updateProposalState(pending);
		const messageCountBeforeReject = webview.messages.length;
		webview.fire({ type: 'rejectReviewed' });
		for (let attempt = 0; attempt < 100 && webview.messages.length === messageCountBeforeReject; attempt += 1) {
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		}
		assert.deepStrictEqual(webview.messages.at(-1), { state: rejectedState, type: 'proposalState' });

		provider.dispose();
		webview.dispose();
	});

	test('tracks external review decisions and ignores updates after disposal', () => {
		const provider = new AgniAgentPanelProvider(async () => undefined, actions());
		const webview = resolve(provider);
		const pending = proposalState({
			canOpenReview: true,
			canReject: true,
			hasPendingProposal: true,
			transactionId: 'transaction-external',
		});
		const reviewed = { ...pending, canApply: true };

		provider.updateProposalState(pending);
		provider.updateProposalState(reviewed);

		assert.deepStrictEqual(webview.messages.slice(-2), [
			{ state: pending, type: 'proposalState' },
			{ state: reviewed, type: 'proposalState' },
		]);

		provider.dispose();
		const messageCount = webview.messages.length;
		assert.doesNotThrow(() => provider.updateProposalState(proposalState()));
		assert.strictEqual(webview.messages.length, messageCount);
		webview.dispose();
	});

	test('preserves pending review actions when a new task is rejected', async () => {
		let runCount = 0;
		const provider = new AgniAgentPanelProvider(async () => {
			runCount += 1;
			return undefined;
		}, actions());
		const webview = resolve(provider);
		const pending = proposalState({
			canOpenReview: true,
			canReject: true,
			hasPendingProposal: true,
			transactionId: 'transaction-pending',
		});
		provider.updateProposalState(pending);

		webview.fire({ task: 'Start another task too early.', type: 'submit' });
		const error = await waitForMessage(webview, 'error');

		assert.strictEqual(runCount, 0);
		assert.strictEqual(
			error.message,
			'Review or reject the existing Agni proposal before starting another task.',
		);
		assert.deepStrictEqual(webview.messages.at(-1), { state: pending, type: 'proposalState' });

		provider.dispose();
		webview.dispose();
	});

	test('reports task failures to the panel without clearing its HTML', async () => {
		const provider = new AgniAgentPanelProvider(
			async () => { throw new Error('TrueForge test failure'); },
			actions(),
		);
		const webview = resolve(provider);
		const initialHtml = webview.html;

		webview.fire({ task: 'Trigger a visible error.', type: 'submit' });
		const error = await waitForMessage(webview, 'error');

		assert.strictEqual(error.message, 'TrueForge test failure');
		assert.strictEqual(webview.html, initialHtml);
		assert.ok(!webview.messages.some((message) =>
			(message as { type?: string }).type === 'complete',
		));

		provider.dispose();
		webview.dispose();
	});

	test('cancels the active run and suppresses late streaming updates', async () => {
		let cancellationObserved = false;
		const runner: AgentPanelTaskRunner = async (_task, token, events) => {
			await new Promise<void>((resolveRun) => {
				let subscription: vscode.Disposable | undefined;
				subscription = token.onCancellationRequested(() => {
					cancellationObserved = true;
					events.appendText('late text');
					subscription?.dispose();
					resolveRun();
				});
			});
			return undefined;
		};
		const provider = new AgniAgentPanelProvider(runner, actions());
		const webview = resolve(provider);

		webview.fire({ task: 'Cancel this task.', type: 'submit' });
		webview.fire({ type: 'cancel' });
		await waitForMessage(webview, 'cancelled');

		assert.strictEqual(cancellationObserved, true);
		assert.ok(!webview.messages.some((message) =>
			(message as { content?: string }).content === 'late text',
		));

		provider.dispose();
		webview.dispose();
	});
});
