import * as vscode from 'vscode';
import { analyzeGitRisks, riskLevelLabel, statusLabel } from './gitRiskAnalyzer.js';
import {
	gitChangeSummary,
	isGitReportPathExcluded,
	type GitFileChange,
	type GitWorkspaceStatus,
} from './gitStatusReader.js';

function writeChanges(
	outputChannel: vscode.OutputChannel,
	changes: readonly GitFileChange[],
	stage: 'staged' | 'unstaged',
): void {
	const relevant = changes.filter((change) => stage === 'staged'
		? change.stage === 'staged' || change.stage === 'both'
		: change.stage === 'unstaged' || change.stage === 'both');
	outputChannel.appendLine(`${stage === 'staged' ? 'Staged' : 'Unstaged / untracked'} changes (${relevant.length}):`);
	if (relevant.length === 0) {
		outputChannel.appendLine('  (none)');
	}
	for (const change of relevant) {
		const status = stage === 'staged' ? change.stagedStatus : change.unstagedStatus;
		outputChannel.appendLine(`  ${statusLabel(status)} ${change.path} — ${gitChangeSummary(change, stage)}`);
	}
}

export function writeGitStatus(status: GitWorkspaceStatus, outputChannel: vscode.OutputChannel): void {
	outputChannel.appendLine('');
	outputChannel.appendLine(`════════ Git: ${status.workspaceName ?? 'workspace'} ════════`);
	if (!status.hasGit) {
		outputChannel.appendLine(`Not available: ${status.error ?? 'Git inspection failed.'}`);
		return;
	}
	outputChannel.appendLine(`Branch: ${status.branch ?? '(detached HEAD or unborn branch)'}`);
	const visibleChanges = status.changes.filter((change) => !isGitReportPathExcluded(change.path));
	const excludedChangeCount = status.excludedChangeCount
		?? status.changes.length - visibleChanges.length;
	if (visibleChanges.length === 0) {
		outputChannel.appendLine(excludedChangeCount > 0
			? `No reportable changes (${excludedChangeCount} generated/dependency path(s) omitted).`
			: 'Working tree is clean.');
		return;
	}
	if (excludedChangeCount > 0) {
		outputChannel.appendLine(`${excludedChangeCount} generated/dependency path(s) omitted from this report.`);
	}
	writeChanges(outputChannel, visibleChanges, 'staged');
	writeChanges(outputChannel, visibleChanges, 'unstaged');
	const findings = analyzeGitRisks(visibleChanges);
	outputChannel.appendLine('Potential risk indicators:');
	if (findings.length === 0) {
		outputChannel.appendLine('  (no filename or change-type indicators matched)');
	}
	for (const finding of findings) {
		outputChannel.appendLine(
			`  ${riskLevelLabel(finding.level)} ${finding.path} — ${finding.reason} [${finding.source}]`,
		);
	}
	outputChannel.appendLine(
		'Risk indicators are deterministic filename/change-type heuristics, not verified security issues.',
	);
}

export async function presentGitStatuses(
	statuses: readonly GitWorkspaceStatus[],
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	outputChannel.show(true);
	for (const status of statuses) {
		writeGitStatus(status, outputChannel);
	}
	const repositories = statuses.filter((status) => status.hasGit);
	const changes = repositories.reduce(
		(total, status) => total + status.changes.filter((change) => !isGitReportPathExcluded(change.path)).length,
		0,
	);
	await vscode.window.showInformationMessage(
		`Agni inspected ${statuses.length} workspace folder(s): ${repositories.length} Git repository/repositories, ${changes} changed file(s).`,
	);
}
