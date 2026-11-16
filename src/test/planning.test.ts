import * as assert from 'node:assert';
import { type TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import { type ContextAssembler } from '../context/contextAssembler.js';
import {
	contentHash,
	MultiFilePlanScopeError,
	MultiFileProposalStore,
} from '../multiFileEdit/multiFileProposal.js';
import { generateAgniPlan, parsePlanResponse } from '../planning/planningAgent.js';
import { createApprovedPlanScope, formatApprovedPlanForImplementation } from '../planning/planningScope.js';
import { PlanningError, PlanningStore } from '../planning/planningStore.js';
import { type AgniPlan } from '../planning/planningTypes.js';
import { type WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

function plan(): AgniPlan {
	return {
		affectedFiles: ['src/a.ts'],
		dependencies: ['existing-module'],
		objective: 'Update the approved module',
		risks: ['Public API compatibility'],
		steps: [{
			affectedFiles: ['src/a.ts'],
			description: 'Update the implementation',
			estimatedChanges: 'change one exported function',
		}],
		task: 'Update the module safely',
	};
}

function boundaryWithRoots(names: string[]): WorkspaceBoundary {
	const folders = names.map((name, index): vscode.WorkspaceFolder => ({
		index,
		name,
		uri: vscode.Uri.file(`C:\\agni-planning\\${name}`),
	}));
	return new WorkspaceBoundary({
		getWorkspaceFolders: () => folders,
	} as unknown as WorkspaceAdapter);
}

function emptyAssembler(): ContextAssembler {
	return {
		assemble: async () => ({
			automatic: {
				candidateCount: 0,
				included: [],
				omittedByRanking: 0,
				omittedForBudget: 0,
				skippedFiles: 0,
				terms: [],
				truncatedSearch: false,
			},
			byteLength: 0,
			content: '',
			references: [],
		}),
	} as unknown as ContextAssembler;
}

suite('Agni Planning Mode', () => {
	test('parses a structured plan and includes step files in the approved union', () => {
		const parsed = parsePlanResponse(JSON.stringify({
			affectedFiles: ['src/a.ts'],
			dependencies: ['dep'],
			objective: 'Update two files',
			risks: ['risk'],
			steps: [{
				affectedFiles: ['src/b.ts'],
				description: 'Update B',
				estimatedChanges: 'modify B',
			}],
		}), 'Original task');
		assert.deepStrictEqual(parsed.affectedFiles, ['src/a.ts', 'src/b.ts']);
		assert.strictEqual(parsed.task, 'Original task');
	});

	test('rejects unstructured planning output instead of silently widening scope', () => {
		assert.throws(
			() => parsePlanResponse('change anything you need', 'Unsafe task'),
			(error: unknown) => error instanceof PlanningError,
		);
	});

	test('serializes objective, steps, files, dependencies, and risks for implementation', () => {
		const approvedPlan = plan();
		const scope = createApprovedPlanScope(approvedPlan, boundaryWithRoots(['project']));
		const prompt = formatApprovedPlanForImplementation(approvedPlan, scope);
		for (const expected of [
			approvedPlan.task,
			approvedPlan.objective,
			approvedPlan.steps[0].description,
			'project/src/a.ts',
			'existing-module',
			'Public API compatibility',
		]) {
			assert.ok(prompt.includes(expected));
		}
	});

	test('requires root-qualified approved paths in a multi-root workspace', () => {
		const approvedPlan = plan();
		assert.throws(
			() => createApprovedPlanScope(approvedPlan, boundaryWithRoots(['frontend', 'backend'])),
			/root id/iu,
		);
		approvedPlan.affectedFiles = ['backend/src/a.ts'];
		approvedPlan.steps[0].affectedFiles = ['backend/src/a.ts'];
		const scope = createApprovedPlanScope(approvedPlan, boundaryWithRoots(['frontend', 'backend']));
		assert.deepStrictEqual(scope.files, [{ path: 'src/a.ts', root: 'backend' }]);
	});

	test('rejects traversal while constructing the approved file scope', () => {
		const approvedPlan = plan();
		approvedPlan.affectedFiles = ['../outside.ts'];
		approvedPlan.steps[0].affectedFiles = [];
		assert.throws(
			() => createApprovedPlanScope(approvedPlan, boundaryWithRoots(['project'])),
			/traversal/iu,
		);
	});

	test('proposal storage rejects files outside the approved plan', () => {
		const store = new MultiFileProposalStore();
		const transaction = store.begin('Scoped task', 'scoped-task', [{ path: 'src/a.ts', root: 'project' }]);
		store.propose({
			content: 'old',
			exists: true,
			hash: contentHash('old'),
			path: 'src/a.ts',
			root: 'project',
			uri: vscode.Uri.file('C:\\project\\src\\a.ts'),
		}, 'new');
		assert.throws(() => store.propose({
			content: 'old',
			exists: true,
			hash: contentHash('old'),
			path: 'src/outside.ts',
			root: 'project',
			uri: vscode.Uri.file('C:\\project\\src\\outside.ts'),
		}, 'new'), (error: unknown) => error instanceof MultiFilePlanScopeError);
		assert.deepStrictEqual(transaction.scopeViolation, { path: 'src/outside.ts', root: 'project' });
		assert.strictEqual(transaction.changes.size, 1);
	});

	test('planning store records cancellation without approving a late plan', () => {
		const store = new PlanningStore();
		store.startPlanning('Task');
		store.cancel();
		assert.strictEqual(store.getState().status, 'cancelled');
		assert.throws(() => store.setPlan(plan()), (error: unknown) => error instanceof PlanningError);
		store.dispose();
	});

	test('cancels the TrueForge planning session once and ignores a late stream response', async () => {
		let cancelCount = 0;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => { markStarted = resolve; });
		let resolveNext: ((value: IteratorResult<TrueForgeApi.TurnStreamingEvent>) => void) | undefined;
		const nextEvent = new Promise<IteratorResult<TrueForgeApi.TurnStreamingEvent>>((resolve) => {
			resolveNext = resolve;
		});
		const client = {
			sessions: {
				cancel: async () => { cancelCount += 1; },
				create: async () => ({ data: { id: 'planning-session' } }),
				createTurnStream: async () => {
					markStarted?.();
					return {
						[Symbol.asyncIterator]: () => ({ next: () => nextEvent }),
					};
				},
			},
		} as unknown as TrueForge;
		const cancellation = new vscode.CancellationTokenSource();
		const text: string[] = [];
		const generation = generateAgniPlan(
			client,
			'model/fqn',
			'Plan safely',
			cancellation.token,
			undefined,
			{ onPlanText: (content) => text.push(content) },
			emptyAssembler(),
		);
		await started;
		cancellation.cancel();
		await assert.rejects(generation, /cancelled/iu);
		resolveNext?.({
			done: false,
			value: {
				content: '{"objective":"late"}',
				id: 'late-delta',
				threadId: 'main',
				type: 'model.message.delta',
			},
		});
		await Promise.resolve();
		assert.strictEqual(cancelCount, 1);
		assert.deepStrictEqual(text, []);
		cancellation.dispose();
	});
});
