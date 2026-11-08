import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ListFilesTool } from '../tools/listFiles.js';
import { ReadFileTool } from '../tools/readFile.js';
import { SearchCodeTool } from '../tools/searchCode.js';
import { ProposeWriteTool } from '../tools/proposeWrite.js';
import { type MultiFileProposalStore } from '../multiFileEdit/multiFileProposal.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

export const agniWorkspaceToolNames = ['read_file', 'list_files', 'search_code'] as const;
export const agniMultiFileToolNames = [...agniWorkspaceToolNames, 'propose_write'] as const;

const readOnlyAnnotations = {
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
	readOnlyHint: true,
} as const;

export function createAgniMcpServer(
	boundary = new WorkspaceBoundary(),
	proposals?: MultiFileProposalStore,
): McpServer {
	const server = new McpServer({
		name: 'agni-vscode',
		version: '0.0.1',
	});
	const readFile = new ReadFileTool(boundary);
	const listFiles = new ListFilesTool(boundary);
	const searchCode = new SearchCodeTool(boundary);

	server.registerTool(
		'read_file',
		{
			annotations: readOnlyAnnotations,
			description: 'Read UTF-8 text from a file inside an open VS Code workspace root. Unsaved editor contents are returned when available.',
			inputSchema: z.object({
				endLine: z.number().int().positive().optional().describe('Optional inclusive 1-based ending line.'),
				path: z.string().min(1).describe('Workspace-relative file path.'),
				root: z.string().optional().describe('Workspace root id. Required when multiple workspace folders are open.'),
				startLine: z.number().int().positive().optional().describe('Optional inclusive 1-based starting line.'),
			}),
			title: 'Read workspace file',
		},
		async (input) => readFile.run(input),
	);

	server.registerTool(
		'list_files',
		{
			annotations: readOnlyAnnotations,
			description: 'List files inside an open VS Code workspace root using VS Code file search.',
			inputSchema: z.object({
				glob: z.string().optional().describe('Workspace-relative glob pattern. Defaults to **/*.'),
				maxResults: z.number().int().positive().max(500).optional().describe('Maximum number of files to return.'),
				path: z.string().optional().describe('Optional workspace-relative directory path.'),
				root: z.string().optional().describe('Workspace root id. Required when multiple workspace folders are open.'),
			}),
			title: 'List workspace files',
		},
		async (input) => listFiles.run(input),
	);

	server.registerTool(
		'search_code',
		{
			annotations: readOnlyAnnotations,
			description: 'Search workspace text files for a literal string. Unsaved editor contents are searched when available.',
			inputSchema: z.object({
				caseSensitive: z.boolean().optional().describe('Whether matching is case-sensitive. Defaults to false.'),
				include: z.string().optional().describe('Workspace-relative file glob. Defaults to **/*.'),
				maxResults: z.number().int().positive().max(200).optional().describe('Maximum number of matches to return.'),
				query: z.string().min(1).describe('Literal text to search for.'),
				root: z.string().optional().describe('Workspace root id. Required when multiple workspace folders are open.'),
			}),
			title: 'Search workspace code',
		},
		async (input) => searchCode.run(input),
	);

	if (proposals) {
		const proposeWrite = new ProposeWriteTool(proposals, boundary);
		server.registerTool(
			'propose_write',
			{
				annotations: {
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
					readOnlyHint: true,
				},
				description: 'Record a complete proposed UTF-8 file replacement for user review. This tool never writes to the workspace.',
				inputSchema: z.object({
					content: z.string().describe('Complete proposed UTF-8 content for the file.'),
					path: z.string().min(1).describe('Workspace-relative file path.'),
					root: z.string().optional().describe('Workspace root id. Required when multiple workspace folders are open.'),
				}),
				title: 'Propose workspace file replacement',
			},
			async (input) => proposeWrite.run(input),
		);
	}

	return server;
}
