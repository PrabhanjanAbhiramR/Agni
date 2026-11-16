import * as vscode from 'vscode';
import { type AgniPlan, type PlanningState } from './planningTypes.js';

export class PlanningError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlanningError';
	}
}

export class PlanningStore implements vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<PlanningState>();
	private state: PlanningState = { status: 'idle' };
	readonly onDidChange = this.changeEmitter.event;

	getState(): Readonly<PlanningState> {
		return this.state;
	}

	startPlanning(task: string): void {
		if (this.isActive()) {
			throw new PlanningError('An Agni plan is already being generated or awaiting approval.');
		}
		this.transition({ status: 'planning', task });
	}

	setPlan(plan: AgniPlan): void {
		this.requireStatus('planning');
		this.transition({ plan, status: 'awaiting_approval', task: this.state.task });
	}

	approve(): void {
		this.requireStatus('awaiting_approval');
		this.transition({ plan: this.state.plan, status: 'approved', task: this.state.task });
	}

	reject(): void {
		this.requireStatus('awaiting_approval');
		this.transition({ plan: this.state.plan, status: 'rejected', task: this.state.task });
	}

	cancel(): void {
		if (this.state.status !== 'planning' && this.state.status !== 'awaiting_approval') {
			return;
		}
		this.transition({ plan: this.state.plan, status: 'cancelled', task: this.state.task });
	}

	setError(error: string): void {
		this.transition({ error, status: 'error', task: this.state.task });
	}

	reset(): void {
		this.transition({ status: 'idle' });
	}

	isActive(): boolean {
		return this.state.status === 'planning' || this.state.status === 'awaiting_approval';
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	private requireStatus(status: PlanningState['status']): void {
		if (this.state.status !== status) {
			throw new PlanningError(`Planning state is ${this.state.status}, not ${status}.`);
		}
	}

	private transition(state: PlanningState): void {
		this.state = state;
		this.changeEmitter.fire(state);
	}
}
