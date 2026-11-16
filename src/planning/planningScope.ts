import { multiFileChangeKey, MultiFileProposalError } from '../multiFileEdit/multiFileProposal.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { type AgniPlan, type ApprovedPlanFile, type ApprovedPlanScope } from './planningTypes.js';

function splitRootQualifiedPath(
	value: string,
	boundary: WorkspaceBoundary,
): { path: string; root: string | undefined } {
	const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '');
	const roots = boundary.listRoots();
	const match = roots
		.map((root) => ({ prefix: `${root.id}/`, root }))
		.sort((left, right) => right.prefix.length - left.prefix.length)
		.find(({ prefix }) => normalized.startsWith(prefix));
	if (match) {
		return { path: normalized.slice(match.prefix.length), root: match.root.id };
	}
	if (roots.length === 1) {
		return { path: normalized, root: roots[0].id };
	}
	throw new MultiFileProposalError(
		`Approved plan path "${value}" must start with a workspace root id. Available roots: `
		+ `${roots.map((root) => root.id).join(', ')}.`,
	);
}

export function createApprovedPlanScope(
	plan: AgniPlan,
	boundary = new WorkspaceBoundary(),
): ApprovedPlanScope {
	const candidates = [
		...plan.affectedFiles,
		...plan.steps.flatMap((step) => step.affectedFiles),
	];
	const files = new Map<string, ApprovedPlanFile>();
	for (const candidate of candidates) {
		if (!candidate.trim()) {
			continue;
		}
		const parsed = splitRootQualifiedPath(candidate.trim(), boundary);
		const resolved = boundary.resolve(parsed.root, parsed.path);
		if (!resolved.relativePath) {
			throw new MultiFileProposalError('The approved plan cannot target a workspace root directory.');
		}
		const file = { path: resolved.relativePath, root: resolved.root.id };
		files.set(multiFileChangeKey(file.root, file.path), file);
	}
	if (files.size === 0) {
		throw new MultiFileProposalError(
			'The generated plan has no approved file scope. Generate and approve a plan that names every target file.',
		);
	}
	return { files: Object.freeze([...files.values()].map((file) => Object.freeze(file))) };
}

export function formatApprovedPlanForImplementation(
	plan: AgniPlan,
	scope: ApprovedPlanScope,
): string {
	const lines = [
		'Implement the following user-approved Agni plan.',
		'Do not propose changes outside the approved file scope. If another file is required, stop and explain that renewed user approval is required.',
		'',
		`Original task: ${plan.task}`,
		`Approved objective: ${plan.objective}`,
		'',
		'Approved steps:',
	];
	for (const [index, step] of plan.steps.entries()) {
		lines.push(`${index + 1}. ${step.description}`);
		lines.push(`   Files: ${step.affectedFiles.length > 0 ? step.affectedFiles.join(', ') : '(none)'}`);
		lines.push(`   Expected change: ${step.estimatedChanges || '(not specified)'}`);
	}
	lines.push('', 'Approved file scope:');
	for (const file of scope.files) {
		lines.push(`- ${file.root}/${file.path}`);
	}
	lines.push('', `Dependencies: ${plan.dependencies.length > 0 ? plan.dependencies.join(', ') : '(none)'}`);
	lines.push(`Risks: ${plan.risks.length > 0 ? plan.risks.join('; ') : '(none identified)'}`);
	return lines.join('\n');
}
