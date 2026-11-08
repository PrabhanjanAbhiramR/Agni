import { type AgniToolResult, errorToolResult } from './toolResult.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { readWorkspaceText } from '../workspace/workspaceText.js';

export const maxReadBytes = 256 * 1024;
export const maxReadLines = 2_000;

export interface ReadFileInput {
	endLine?: number;
	path: string;
	root?: string;
	startLine?: number;
}

function validateLine(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
		throw new Error(`${name} must be a positive integer.`);
	}
}

export class ReadFileTool {
	constructor(private readonly boundary = new WorkspaceBoundary()) {}

	async run(input: ReadFileInput): Promise<AgniToolResult> {
		try {
			validateLine(input.startLine, 'startLine');
			validateLine(input.endLine, 'endLine');
			const resolved = this.boundary.resolve(input.root, input.path);
			if (!resolved.relativePath) {
				throw new Error('A file path is required.');
			}

			const file = await readWorkspaceText(this.boundary, resolved, maxReadBytes);
			const lines = file.text.split(/\r?\n/);
			const startLine = input.startLine ?? 1;
			if (startLine > lines.length) {
				throw new Error(`startLine ${startLine} exceeds the file's ${lines.length} lines.`);
			}

			if (input.endLine !== undefined && input.endLine < startLine) {
				throw new Error('endLine must be greater than or equal to startLine.');
			}

			const requestedEnd = Math.min(input.endLine ?? lines.length, lines.length);
			const endLine = Math.min(requestedEnd, startLine + maxReadLines - 1);
			const truncated = endLine < requestedEnd;
			const text = lines.slice(startLine - 1, endLine).join('\n');
			const displayPath = `${resolved.root.id}/${resolved.relativePath}`;

			return {
				content: [{
					type: 'text',
					text: `File: ${displayPath}\nLines: ${startLine}-${endLine} of ${lines.length}${truncated ? ' (truncated)' : ''}\n\n${text}`,
				}],
				structuredContent: {
					byteLength: file.byteLength,
					content: text,
					endLine,
					fromOpenDocument: file.fromOpenDocument,
					path: resolved.relativePath,
					root: resolved.root.id,
					startLine,
					totalLines: lines.length,
					truncated,
				},
			};
		} catch (error: unknown) {
			return errorToolResult(error);
		}
	}
}
