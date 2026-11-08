import * as vscode from 'vscode';
import {
	type InlineEditDiffViewer,
	type InlineEditProposal,
	InlineEditProposalStore,
} from './inlineEditProposal.js';

const inlineEditDiffScheme = 'agni-inline-edit';

type CommandExecutor = (command: string, ...rest: unknown[]) => Thenable<unknown>;

export class InlineEditDiffProvider implements vscode.TextDocumentContentProvider, InlineEditDiffViewer {
	constructor(
		private readonly store: InlineEditProposalStore,
		private readonly executeCommand: CommandExecutor = vscode.commands.executeCommand,
	) {}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const proposalId = new URLSearchParams(uri.query).get('proposal');
		if (!proposalId) {
			throw new Error('Agni inline edit diff URI is missing its proposal id.');
		}
		return this.store.require(proposalId).proposedDocumentText;
	}

	async showProposal(proposal: InlineEditProposal): Promise<void> {
		const proposedUri = this.proposalUri(proposal);
		await this.executeCommand(
			'vscode.diff',
			proposal.uri,
			proposedUri,
			`Agni Inline Edit: ${proposal.filePath}`,
			{ preview: true },
		);
	}

	proposalUri(proposal: InlineEditProposal): vscode.Uri {
		const fileName = proposal.filePath.slice(proposal.filePath.lastIndexOf('/') + 1) || 'proposal.txt';
		return vscode.Uri.from({
			path: `/${proposal.id}/${fileName}`,
			query: new URLSearchParams({ proposal: proposal.id }).toString(),
			scheme: inlineEditDiffScheme,
		});
	}
}

export function registerInlineEditDiffProvider(
	context: vscode.ExtensionContext,
	provider: InlineEditDiffProvider,
): void {
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(inlineEditDiffScheme, provider),
	);
}
