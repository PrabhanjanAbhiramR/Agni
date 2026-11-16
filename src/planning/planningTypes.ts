export interface AgniPlanStep {
	affectedFiles: string[];
	description: string;
	estimatedChanges: string;
}

export interface AgniPlan {
	affectedFiles: string[];
	dependencies: string[];
	objective: string;
	risks: string[];
	steps: AgniPlanStep[];
	task: string;
}

export interface ApprovedPlanFile {
	path: string;
	root: string;
}

export interface ApprovedPlanScope {
	files: readonly ApprovedPlanFile[];
}

export type PlanningStatus =
	| 'idle'
	| 'planning'
	| 'awaiting_approval'
	| 'approved'
	| 'rejected'
	| 'cancelled'
	| 'error';

export interface PlanningState {
	error?: string;
	plan?: AgniPlan;
	status: PlanningStatus;
	task?: string;
}
