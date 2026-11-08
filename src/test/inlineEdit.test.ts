import * as assert from 'assert';
import { type TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { type ContextAssembler } from '../context/contextAssembler.js';
import { InlineEditDiffProvider } from '../inlineEdit/inlineEditDiff.js';
import {
	InlineEditController,
	type InlineEditDiffViewer,
	type InlineEditDocumentState,
	type InlineEditGenerator,
	type InlineEditProposal,
	InlineEditProposalError,
	InlineEditProposalStore,
	InlineEditStaleProposalError,
	type InlineEditTarget,
	type InlineEditWorkspace,
} from '../inlineEdit/inlineEditProposal.js';
import {
	InlineEditCancelledError,
	parseInlineEditResponse,
	TrueForgeInlineEditGenerator,
} from '../trueforge/inlineEditAgent.js';

function offsetAt(text: string, position: vscode.Position): number {
	const lines = text.split('\n');
	let offset = 0;
	for (let line = 0; line < position.line; line += 1) {
		offset += lines[line].length + 1;
	}
	return offset + position.character;
}

class MemoryInlineEditWorkspace implements InlineEditWorkspace {
	applyCount = 0;
	selectedText: string;
	text: string;
	version: number;

	constructor(private readonly target: InlineEditTarget) {
		this.text = target.documentText;
		this.version = target.version;
		this.selectedText = target.originalText;
	}

	getDocumentState(): Promise<InlineEditDocumentState> {
		return Promise.resolve({ selectedText: this.selectedText, version: this.version });
	}

	applyReplacement(_uri: vscode.Uri, range: vscode.Range, replacementText: string): Promise<boolean> {
		const start = offsetAt(this.text, range.start);
		const end = offsetAt(this.text, range.end);
		this.text = this.text.slice(0, start) + replacementText + this.text.slice(end);
		this.selectedText = replacementText;
		this.version += 1;
		this.applyCount += 1;
		return Promise.resolve(true);
	}
}

class StaticGenerator implements InlineEditGenerator {
	callCount = 0;

	constructor(
		private readonly replacement: string,
		private readonly onGenerate: () => void = () => undefined,
	) {}

	generateReplacement(): Promise<string> {
		this.callCount += 1;
		this.onGenerate();
		return Promise.resolve(this.replacement);
	}
}

class RecordingDiffViewer implements InlineEditDiffViewer {
	proposals: InlineEditProposal[] = [];

	showProposal(proposal: InlineEditProposal): Promise<void> {
		this.proposals.push(proposal);
		return Promise.resolve();
	}
}

class CancellableGenerator implements InlineEditGenerator {
	generateReplacement(
		_target: InlineEditTarget,
		cancellationToken: vscode.CancellationToken,
	): Promise<string> {
		return new Promise((_resolve, reject) => {
			if (cancellationToken.isCancellationRequested) {
				reject(new InlineEditCancelledError());
				return;
			}
			const subscription = cancellationToken.onCancellationRequested(() => {
				subscription.dispose();
				reject(new InlineEditCancelledError());
			});
		});
	}
}

function target(): InlineEditTarget {
	const documentText = 'const before = 1;\nlet value = oldValue;\nconst after = 2;';
	const originalText = 'let value = oldValue;';
	const startOffset = documentText.indexOf(originalText);
	return {
		documentText,
		endOffset: startOffset + originalText.length,
		filePath: 'src/example.ts',
		instruction: 'Use the new value.',
		languageId: 'typescript',
		originalText,
		range: new vscode.Range(1, 0, 1, originalText.length),
		root: 'project',
		startOffset,
		uri: vscode.Uri.file('C:\\agni-inline-test\\src\\example.ts'),
		version: 4,
	};
}

function setup(replacement = 'let value = newValue;'): {
	controller: InlineEditController;
	diff: RecordingDiffViewer;
	generator: StaticGenerator;
	store: InlineEditProposalStore;
	target: InlineEditTarget;
	workspace: MemoryInlineEditWorkspace;
} {
	const editTarget = target();
	const workspace = new MemoryInlineEditWorkspace(editTarget);
	const diff = new RecordingDiffViewer();
	const store = new InlineEditProposalStore();
	return {
		controller: new InlineEditController(workspace, diff, store, () => 'proposal-1'),
		diff,
		generator: new StaticGenerator(replacement),
		store,
		target: editTarget,
		workspace,
	};
}

suite('Inline edit workflow', () => {
	test('generates and stores a proposal without changing the document', async () => {
		const fixture = setup();
		const proposal = await fixture.controller.generateProposal(
			fixture.target,
			fixture.generator,
			new vscode.CancellationTokenSource().token,
		);

		assert.strictEqual(fixture.workspace.applyCount, 0);
		assert.strictEqual(fixture.workspace.text, fixture.target.documentText);
		assert.strictEqual(proposal.status, 'pending');
		assert.strictEqual(fixture.store.get(proposal.id), proposal);
		assert.match(proposal.proposedDocumentText, /let value = newValue;/u);
		assert.doesNotMatch(proposal.proposedDocumentText, /let value = oldValue;/u);
		assert.deepStrictEqual(fixture.diff.proposals, [proposal]);
	});

	test('rejects empty selections and instructions before generation', async () => {
		const fixture = setup();
		const noInstruction = { ...fixture.target, instruction: '   ' };
		await assert.rejects(
			fixture.controller.generateProposal(
				noInstruction,
				fixture.generator,
				new vscode.CancellationTokenSource().token,
			),
			(error: unknown) => error instanceof InlineEditProposalError && /instruction is required/iu.test(error.message),
		);

		const emptySelection = {
			...fixture.target,
			endOffset: fixture.target.startOffset,
			originalText: '',
			range: new vscode.Range(1, 0, 1, 0),
		};
		await assert.rejects(
			fixture.controller.generateProposal(
				emptySelection,
				fixture.generator,
				new vscode.CancellationTokenSource().token,
			),
			(error: unknown) => error instanceof InlineEditProposalError && /non-empty code/iu.test(error.message),
		);
		assert.strictEqual(fixture.generator.callCount, 0);
	});

	test('opens the proposal with VS Code built-in diff and serves virtual content', async () => {
		const fixture = setup();
		const proposal = await fixture.controller.generateProposal(
			fixture.target,
			fixture.generator,
			new vscode.CancellationTokenSource().token,
		);
		const calls: Array<{ command: string; rest: unknown[] }> = [];
		const provider = new InlineEditDiffProvider(fixture.store, (command, ...rest) => {
			calls.push({ command, rest });
			return Promise.resolve(undefined);
		});

		await provider.showProposal(proposal);

		assert.strictEqual(calls[0].command, 'vscode.diff');
		assert.strictEqual(calls[0].rest[0], proposal.uri);
		const proposedUri = calls[0].rest[1] as vscode.Uri;
		assert.strictEqual(proposedUri.scheme, 'agni-inline-edit');
		assert.strictEqual(provider.provideTextDocumentContent(proposedUri), proposal.proposedDocumentText);
	});

	test('accepts a current proposal through the workspace edit adapter', async () => {
		const fixture = setup();
		const proposal = await fixture.controller.generateProposal(
			fixture.target,
			fixture.generator,
			new vscode.CancellationTokenSource().token,
		);

		const accepted = await fixture.controller.accept(proposal.id);

		assert.strictEqual(accepted.status, 'accepted');
		assert.strictEqual(fixture.workspace.applyCount, 1);
		assert.match(fixture.workspace.text, /let value = newValue;/u);
	});

	test('rejects a proposal without editing the document', async () => {
		const fixture = setup();
		const proposal = await fixture.controller.generateProposal(
			fixture.target,
			fixture.generator,
			new vscode.CancellationTokenSource().token,
		);

		const rejected = fixture.controller.reject(proposal.id);

		assert.strictEqual(rejected.status, 'rejected');
		assert.strictEqual(fixture.workspace.applyCount, 0);
		assert.strictEqual(fixture.workspace.text, fixture.target.documentText);
	});

	test('rejects stale proposals when the document version changed', async () => {
		const fixture = setup();
		const proposal = await fixture.controller.generateProposal(
			fixture.target,
			fixture.generator,
			new vscode.CancellationTokenSource().token,
		);
		fixture.workspace.version += 1;

		await assert.rejects(
			fixture.controller.accept(proposal.id),
			(error: unknown) => error instanceof InlineEditStaleProposalError,
		);
		assert.strictEqual(proposal.status, 'stale');
		assert.strictEqual(fixture.workspace.applyCount, 0);
	});

	test('does not create a proposal if the document changes during generation', async () => {
		const fixture = setup();
		const generator = new StaticGenerator('let value = newValue;', () => {
			fixture.workspace.version += 1;
		});

		await assert.rejects(
			fixture.controller.generateProposal(
				fixture.target,
				generator,
				new vscode.CancellationTokenSource().token,
			),
			(error: unknown) => error instanceof InlineEditStaleProposalError,
		);
		assert.strictEqual(fixture.store.get('proposal-1'), undefined);
		assert.strictEqual(fixture.diff.proposals.length, 0);
	});

	test('cancels generation without creating or applying a proposal', async () => {
		const fixture = setup();
		const cancellation = new vscode.CancellationTokenSource();
		const generation = fixture.controller.generateProposal(
			fixture.target,
			new CancellableGenerator(),
			cancellation.token,
		);

		cancellation.cancel();
		await assert.rejects(
			generation,
			(error: unknown) => error instanceof InlineEditCancelledError,
		);
		cancellation.dispose();

		assert.strictEqual(fixture.store.get('proposal-1'), undefined);
		assert.strictEqual(fixture.diff.proposals.length, 0);
		assert.strictEqual(fixture.workspace.applyCount, 0);
	});

	test('cancels the active TrueForge session when streaming is cancelled', async () => {
		let cancelCount = 0;
		let releaseStream: (() => void) | undefined;
		let markStreamStarted: (() => void) | undefined;
		const streamStarted = new Promise<void>((resolve) => {
			markStreamStarted = resolve;
		});
		const fakeClient = {
			sessions: {
				cancel: async () => {
					cancelCount += 1;
					releaseStream?.();
				},
				create: async () => ({ data: { id: 'inline-session' } }),
				createTurnStream: async () => ({
					async *[Symbol.asyncIterator]() {
						markStreamStarted?.();
						await new Promise<void>((resolve) => {
							releaseStream = resolve;
						});
						yield { state: { status: 'cancelled' }, type: 'turn.done' };
					},
				}),
			},
		} as unknown as TrueForge;
		const contextAssembler = {
			assemble: () => Promise.resolve({ content: '' }),
		} as unknown as ContextAssembler;
		const generator = new TrueForgeInlineEditGenerator(
			fakeClient,
			'configured/model',
			1024,
			contextAssembler,
		);
		const cancellation = new vscode.CancellationTokenSource();
		const generation = generator.generateReplacement(target(), cancellation.token);

		await streamStarted;
		cancellation.cancel();
		await assert.rejects(
			generation,
			(error: unknown) => error instanceof InlineEditCancelledError,
		);
		cancellation.dispose();
		assert.strictEqual(cancelCount, 1);
	});

	test('validates structured TrueForge responses', () => {
		assert.strictEqual(
			parseInlineEditResponse('{"replacement":"const answer = 42;"}'),
			'const answer = 42;',
		);
		assert.throws(
			() => parseInlineEditResponse('Here is your replacement: const answer = 42;'),
			(error: unknown) => error instanceof InlineEditProposalError && /invalid inline edit response/iu.test(error.message),
		);
	});
});
