import * as vscode from 'vscode';
import { type AgniPlan } from './planningTypes.js';

export type PlanApprovalDecision = 'approve' | 'reject' | 'cancelled';

export function writePlanToChannel(plan: AgniPlan, outputChannel: vscode.OutputChannel): void {
	outputChannel.appendLine('');
	outputChannel.appendLine('════════════════════════════════════════');
	outputChannel.appendLine('[Planning] Proposed implementation plan');
	outputChannel.appendLine(`Objective: ${plan.objective}`);
	for (const [index, step] of plan.steps.entries()) {
		outputChannel.appendLine(`${index + 1}. ${step.description}`);
		outputChannel.appendLine(`   Files: ${step.affectedFiles.join(', ') || '(none)'}`);
		outputChannel.appendLine(`   Change: ${step.estimatedChanges || '(not specified)'}`);
	}
	outputChannel.appendLine(`Affected files: ${plan.affectedFiles.join(', ') || '(none)'}`);
	outputChannel.appendLine(`Dependencies: ${plan.dependencies.join(', ') || '(none)'}`);
	outputChannel.appendLine(`Risks: ${plan.risks.join('; ') || '(none identified)'}`);
	outputChannel.appendLine('════════════════════════════════════════');
}

export async function presentPlanForApproval(
	plan: AgniPlan,
	outputChannel: vscode.OutputChannel,
): Promise<PlanApprovalDecision> {
	writePlanToChannel(plan, outputChannel);
	const action = await vscode.window.showWarningMessage(
		`Agni generated a ${plan.steps.length}-step plan affecting ${plan.affectedFiles.length} file(s). Review it in the Agni output channel.`,
		{ modal: true },
		'Approve Plan',
		'Reject Plan',
	);
	if (action === 'Approve Plan') {
		return 'approve';
	}
	if (action === 'Reject Plan') {
		return 'reject';
	}
	return 'cancelled';
}
