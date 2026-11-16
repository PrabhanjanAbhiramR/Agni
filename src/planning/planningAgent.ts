import { TrueForge } from '@truefoundry/trueforge-sdk';
import * as vscode from 'vscode';
import {
	type WorkspaceAgentProgress,
	runWorkspaceAgentTurn,
	WorkspaceAgentCancelledError,
} from '../trueforge/workspaceAgent.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { ContextAssembler } from '../context/contextAssembler.js';
import { PlanningError } from './planningStore.js';
import { type AgniPlan, type AgniPlanStep } from './planningTypes.js';

interface RawPlan {
	affectedFiles?: unknown;
	dependencies?: unknown;
	objective?: unknown;
	risks?: unknown;
	steps?: unknown;
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
		: [];
}

function parseStep(value: unknown): AgniPlanStep | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.description !== 'string' || !record.description.trim()) {
		return undefined;
	}
	return {
		affectedFiles: strings(record.affectedFiles),
		description: record.description.trim(),
		estimatedChanges: typeof record.estimatedChanges === 'string' ? record.estimatedChanges.trim() : '',
	};
}

export function parsePlanResponse(response: string, task: string): AgniPlan {
	const trimmed = response.trim();
	if (!trimmed) {
		throw new PlanningError('The planning turn returned an empty response.');
	}
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
	const candidate = /\{[\s\S]*\}/u.exec(fenced?.[1] ?? trimmed)?.[0] ?? trimmed;
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		throw new PlanningError('The planning turn did not return valid structured JSON.');
	}
	if (typeof parsed !== 'object' || parsed === null) {
		throw new PlanningError('The planning response was not a JSON object.');
	}
	const raw = parsed as RawPlan;
	const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
	const steps = Array.isArray(raw.steps)
		? raw.steps.map(parseStep).filter((step): step is AgniPlanStep => step !== undefined)
		: [];
	if (!objective || steps.length === 0) {
		throw new PlanningError('The planning response requires an objective and at least one valid step.');
	}
	const affectedFiles = [...new Set([
		...strings(raw.affectedFiles),
		...steps.flatMap((step) => step.affectedFiles),
	])];
	return {
		affectedFiles,
		dependencies: strings(raw.dependencies),
		objective,
		risks: strings(raw.risks),
		steps,
		task,
	};
}

function planningPrompt(task: string): string {
	const roots = new WorkspaceBoundary().listRoots();
	const scopeRule = roots.length > 1
		? `Every affected file must be written as <root-id>/<path>. Available root ids: ${roots.map((root) => root.id).join(', ')}.`
		: 'Every affected file must be workspace-relative.';
	return [
		'You are Agni\'s read-only planning engine.',
		'Inspect the workspace using only read_file, list_files, and search_code.',
		'Do not propose or apply file changes during planning.',
		scopeRule,
		'Return only JSON with this shape:',
		'{"objective":"...","steps":[{"description":"...","affectedFiles":["..."],"estimatedChanges":"..."}],"affectedFiles":["..."],"dependencies":["..."],"risks":["..."]}',
		`User task: ${task}`,
	].join('\n');
}

export interface PlanningAgentProgress extends WorkspaceAgentProgress {
	onCancellationError?: (error: unknown) => void;
	onPlanText?: (content: string) => void;
}

export async function generateAgniPlan(
	client: TrueForge,
	modelName: string,
	task: string,
	cancellationToken: vscode.CancellationToken,
	contextBudgetBytes?: number,
	progress: PlanningAgentProgress = {},
	contextAssembler = new ContextAssembler(),
): Promise<AgniPlan> {
	if (cancellationToken.isCancellationRequested) {
		throw new PlanningError('Planning was cancelled before it started.');
	}
	try {
		const result = await runWorkspaceAgentTurn(client, modelName, planningPrompt(task), {
			...progress,
			onText: (content) => {
				if (!cancellationToken.isCancellationRequested) {
					progress.onPlanText?.(content);
					progress.onText?.(content);
				}
			},
		}, {
			cancellationToken,
			contextAssembler,
			contextBudgetBytes,
			onCancellationError: progress.onCancellationError,
		});
		if (cancellationToken.isCancellationRequested) {
			throw new WorkspaceAgentCancelledError();
		}
		return parsePlanResponse(result.answer, task);
	} catch (error: unknown) {
		if (error instanceof WorkspaceAgentCancelledError || cancellationToken.isCancellationRequested) {
			throw new PlanningError('Planning was cancelled.');
		}
		throw error;
	}
}
