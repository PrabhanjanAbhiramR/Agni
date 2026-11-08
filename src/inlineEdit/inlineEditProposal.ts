import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export type InlineEditProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface InlineEditTarget {
	documentText: string;
	endOffset: number;
	filePath: string;
	instruction: string;
	languageId: string;
	originalText: string;
	range: vscode.Range;
	root: string;
	startOffset: number;
	uri: vscode.Uri;
	version: number;
}

export interface InlineEditProposal extends InlineEditTarget {
	createdAt: string;
	id: string;
	proposedDocumentText: string;
	replacementText: string;
	status: InlineEditProposalStatus;
}

export interface InlineEditDocumentState {
	selectedText: string;
	version: number;
}

export interface InlineEditWorkspace {
	applyReplacement(uri: vscode.Uri, range: vscode.Range, replacementText: string): Promise<boolean>;
	getDocumentState(uri: vscode.Uri, range: vscode.Range): Promise<InlineEditDocumentState>;
}

export interface InlineEditGenerator {
	generateReplacement(target: InlineEditTarget, cancellationToken: vscode.CancellationToken): Promise<string>;
}

export interface InlineEditDiffViewer {
	showProposal(proposal: InlineEditProposal): Promise<void>;
}

export class InlineEditProposalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InlineEditProposalError';
	}
}

export class InlineEditStaleProposalError extends InlineEditProposalError {
	constructor(message: string) {
		super(message);
		this.name = 'InlineEditStaleProposalError';
	}
}

export class InlineEditProposalStore implements vscode.Disposable {
	private readonly proposals = new Map<string, InlineEditProposal>();

	add(proposal: InlineEditProposal): void {
		if (this.proposals.has(proposal.id)) {
			throw new InlineEditProposalError(`Inline edit proposal "${proposal.id}" already exists.`);
		}
		this.proposals.set(proposal.id, proposal);
	}

	get(id: string): InlineEditProposal | undefined {
		return this.proposals.get(id);
	}

	delete(id: string): boolean {
		return this.proposals.delete(id);
	}

	require(id: string): InlineEditProposal {
		const proposal = this.get(id);
		if (!proposal) {
			throw new InlineEditProposalError(`Inline edit proposal "${id}" was not found.`);
		}
		return proposal;
	}

	setStatus(id: string, status: InlineEditProposalStatus): InlineEditProposal {
		const proposal = this.require(id);
		proposal.status = status;
		return proposal;
	}

	dispose(): void {
		this.proposals.clear();
	}
}

export class VsCodeInlineEditWorkspace implements InlineEditWorkspace {
	async getDocumentState(uri: vscode.Uri, range: vscode.Range): Promise<InlineEditDocumentState> {
		const document = await vscode.workspace.openTextDocument(uri);
		return { selectedText: document.getText(range), version: document.version };
	}

	async applyReplacement(uri: vscode.Uri, range: vscode.Range, replacementText: string): Promise<boolean> {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, range, replacementText, {
			label: 'Apply Agni inline edit',
			needsConfirmation: false,
		});
		return vscode.workspace.applyEdit(edit, { isRefactoring: true });
	}
}

export class InlineEditController {
	constructor(
		private readonly workspace: InlineEditWorkspace,
		private readonly diffViewer: InlineEditDiffViewer,
		readonly store = new InlineEditProposalStore(),
		private readonly idFactory: () => string = randomUUID,
	) {}

	async generateProposal(
		target: InlineEditTarget,
		generator: InlineEditGenerator,
		cancellationToken: vscode.CancellationToken,
	): Promise<InlineEditProposal> {
		this.validateTarget(target);
		const replacementText = await generator.generateReplacement(target, cancellationToken);
		if (cancellationToken.isCancellationRequested) {
			throw new InlineEditProposalError('Inline edit generation was cancelled.');
		}
		if (replacementText.includes('\0')) {
			throw new InlineEditProposalError('TrueForge returned a replacement containing a NUL character.');
		}
		if (replacementText === target.originalText) {
			throw new InlineEditProposalError('TrueForge returned the selected code unchanged.');
		}

		await this.assertCurrent(target);
		const proposal: InlineEditProposal = {
			...target,
			createdAt: new Date().toISOString(),
			id: this.idFactory(),
			proposedDocumentText: target.documentText.slice(0, target.startOffset)
				+ replacementText
				+ target.documentText.slice(target.endOffset),
			replacementText,
			status: 'pending',
		};
		this.store.add(proposal);
		try {
			await this.diffViewer.showProposal(proposal);
		} catch (error: unknown) {
			this.store.delete(proposal.id);
			const details = error instanceof Error ? error.message : String(error);
			throw new InlineEditProposalError(`Could not open the inline edit diff: ${details}`);
		}
		return proposal;
	}

	async accept(id: string): Promise<InlineEditProposal> {
		const proposal = this.requirePending(id);
		try {
			await this.assertCurrent(proposal);
		} catch (error: unknown) {
			this.store.setStatus(id, 'stale');
			throw error;
		}

		const applied = await this.workspace.applyReplacement(
			proposal.uri,
			proposal.range,
			proposal.replacementText,
		);
		if (!applied) {
			throw new InlineEditProposalError('VS Code did not apply the accepted inline edit.');
		}
		return this.store.setStatus(id, 'accepted');
	}

	reject(id: string): InlineEditProposal {
		this.requirePending(id);
		return this.store.setStatus(id, 'rejected');
	}

	private requirePending(id: string): InlineEditProposal {
		const proposal = this.store.require(id);
		if (proposal.status !== 'pending') {
			throw new InlineEditProposalError(
				`Inline edit proposal "${id}" is ${proposal.status} and cannot be reviewed again.`,
			);
		}
		return proposal;
	}

	private validateTarget(target: InlineEditTarget): void {
		if (!target.instruction.trim()) {
			throw new InlineEditProposalError('An inline edit instruction is required.');
		}
		if (target.range.isEmpty || target.startOffset === target.endOffset || target.originalText.length === 0) {
			throw new InlineEditProposalError('Select non-empty code before running Agni: Inline Edit.');
		}
		if (target.startOffset < 0
			|| target.endOffset > target.documentText.length
			|| target.startOffset >= target.endOffset
			|| target.documentText.slice(target.startOffset, target.endOffset) !== target.originalText) {
			throw new InlineEditProposalError('The selected range is invalid for the captured document.');
		}
	}

	private async assertCurrent(target: InlineEditTarget): Promise<void> {
		const current = await this.workspace.getDocumentState(target.uri, target.range);
		if (current.version !== target.version || current.selectedText !== target.originalText) {
			throw new InlineEditStaleProposalError(
				'The target document changed after inline edit generation started. Generate a new proposal.',
			);
		}
	}
}
