import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import {
	localhostHostValidation,
	localhostOriginValidation,
	toNodeHandler,
} from '@modelcontextprotocol/node';
import { createAgniMcpServer } from './agniMcpServer.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import { type MultiFileProposalStore } from '../multiFileEdit/multiFileProposal.js';
import { maxMultiFileBytes } from '../multiFileEdit/multiFileProposal.js';

const bindHost = '127.0.0.1';
const endpointPath = '/mcp';
const maxRequestBodySize = maxMultiFileBytes + 64 * 1024;

export interface AgniMcpEndpoint {
	port: number;
	url: string;
}

/** Sensitive connection details intended only for registering the host with TrueForge. */
export interface AgniMcpConnectionDetails {
	headers: Readonly<Record<string, string>>;
	url: string;
}

interface JsonRpcResponse {
	error?: { code: number; message: string };
	id?: number | string | null;
	jsonrpc: '2.0';
	result?: unknown;
}

interface ToolsListResult {
	tools?: Array<{ name?: unknown }>;
}

function jsonError(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, {
		'Content-Type': 'application/json',
		'Cache-Control': 'no-store',
	});
	response.end(JSON.stringify({
		error: { code: -32000, message },
		id: null,
		jsonrpc: '2.0',
	}));
}

function tokenMatches(header: string | string[] | undefined, expectedToken: string): boolean {
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
		return false;
	}

	const actual = Buffer.from(header.slice('Bearer '.length), 'utf8');
	const expected = Buffer.from(expectedToken, 'utf8');
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function closeHttpServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	});
}

function parseJsonRpcResponse(body: string, contentType: string | null, id: number): JsonRpcResponse {
	const candidates: unknown[] = [];
	if (contentType?.includes('text/event-stream')) {
		for (const line of body.split(/\r?\n/)) {
			if (!line.startsWith('data:')) {
				continue;
			}

			const data = line.slice('data:'.length).trim();
			if (!data) {
				continue;
			}

			try {
				candidates.push(JSON.parse(data));
			} catch {
				// Ignore SSE comments or non-JSON event data and continue to the RPC response.
			}
		}
	} else if (body) {
		const parsed: unknown = JSON.parse(body);
		candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
	}

	const response = candidates.find((candidate): candidate is JsonRpcResponse =>
		typeof candidate === 'object'
		&& candidate !== null
		&& 'id' in candidate
		&& candidate.id === id,
	);
	if (!response) {
		throw new Error(`MCP endpoint returned no JSON-RPC response for request ${id}.`);
	}

	return response;
}

export class AgniMcpHttpHost {
	private disposed = false;
	private endpoint: AgniMcpEndpoint | undefined;
	private handler: McpHttpHandler | undefined;
	private httpServer: Server | undefined;
	private startPromise: Promise<AgniMcpEndpoint> | undefined;
	private stopPromise: Promise<void> | undefined;
	private token: string | undefined;

	constructor(
		private readonly boundary = new WorkspaceBoundary(),
		private readonly onError: (error: Error) => void = () => undefined,
		private readonly multiFileProposals?: MultiFileProposalStore,
	) {}

	async start(): Promise<AgniMcpEndpoint> {
		if (this.disposed) {
			throw new Error('Agni MCP server host has been disposed.');
		}

		if (this.endpoint) {
			return this.endpoint;
		}

		if (!this.startPromise) {
			this.startPromise = this.startInternal().finally(() => {
				this.startPromise = undefined;
			});
		}

		return this.startPromise;
	}

	async listToolNames(): Promise<string[]> {
		const endpoint = await this.start();
		if (!this.token) {
			throw new Error('Agni MCP authentication token is unavailable.');
		}

		await this.sendRpc(endpoint.url, this.token, 1, 'initialize', {
			capabilities: {},
			clientInfo: { name: 'agni-vscode-verifier', version: '0.0.1' },
			protocolVersion: '2025-06-18',
		});
		const response = await this.sendRpc(endpoint.url, this.token, 2, 'tools/list', {});
		const result = response.result as ToolsListResult | undefined;
		if (!result || !Array.isArray(result.tools)) {
			throw new Error('MCP tools/list returned an invalid result.');
		}

		return result.tools
			.map((tool) => tool.name)
			.filter((name): name is string => typeof name === 'string')
			.sort();
	}

	async getConnectionDetails(): Promise<AgniMcpConnectionDetails> {
		const endpoint = await this.start();
		if (!this.token) {
			throw new Error('Agni MCP authentication token is unavailable.');
		}

		return {
			headers: { Authorization: `Bearer ${this.token}` },
			url: endpoint.url,
		};
	}

	async stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}

		this.stopPromise = this.stopInternal().finally(() => {
			this.stopPromise = undefined;
		});
		return this.stopPromise;
	}

	dispose(): void {
		this.disposed = true;
		void this.stop();
	}

	private async startInternal(): Promise<AgniMcpEndpoint> {
		if (this.stopPromise) {
			await this.stopPromise;
		}

		const token = randomBytes(32).toString('base64url');
		const handler = createMcpHandler(
			() => createAgniMcpServer(this.boundary, this.multiFileProposals),
			{
				legacy: 'stateless',
				maxRequestBodySize,
				onerror: this.onError,
			},
		);
		const nodeHandler = toNodeHandler(handler, {
			maxRequestBodySize,
			onerror: this.onError,
		});
		const validateHost = localhostHostValidation();
		const validateOrigin = localhostOriginValidation();
		const httpServer = createServer((request, response) => {
			if (!validateHost(request, response) || !validateOrigin(request, response)) {
				return;
			}

			let path: string;
			try {
				path = new URL(request.url ?? '/', `http://${request.headers.host ?? bindHost}`).pathname;
			} catch {
				jsonError(response, 400, 'Invalid request URL.');
				return;
			}

			if (path !== endpointPath) {
				jsonError(response, 404, 'Not found.');
				return;
			}

			if (!tokenMatches(request.headers.authorization, token)) {
				response.setHeader('WWW-Authenticate', 'Bearer');
				jsonError(response, 401, 'Unauthorized.');
				return;
			}

			void nodeHandler(request, response).catch((error: unknown) => {
				this.onError(error instanceof Error ? error : new Error(String(error)));
			});
		});

		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					httpServer.off('listening', onListening);
					reject(error);
				};
				const onListening = (): void => {
					httpServer.off('error', onError);
					resolve();
				};
				httpServer.once('error', onError);
				httpServer.once('listening', onListening);
				httpServer.listen({ exclusive: true, host: bindHost, port: 0 });
			});

			const address = httpServer.address();
			if (!address || typeof address === 'string') {
				throw new Error('Agni MCP server did not receive a TCP address.');
			}
			if (this.disposed) {
				throw new Error('Agni MCP server host was disposed while starting.');
			}

			const port = (address as AddressInfo).port;
			this.handler = handler;
			this.httpServer = httpServer;
			this.token = token;
			this.endpoint = { port, url: `http://${bindHost}:${port}${endpointPath}` };
			return this.endpoint;
		} catch (error: unknown) {
			await Promise.allSettled([handler.close(), closeHttpServer(httpServer)]);
			throw error;
		}
	}

	private async stopInternal(): Promise<void> {
		const handler = this.handler;
		const httpServer = this.httpServer;
		this.endpoint = undefined;
		this.handler = undefined;
		this.httpServer = undefined;
		this.token = undefined;

		const results = await Promise.allSettled([
			handler?.close(),
			httpServer ? closeHttpServer(httpServer) : undefined,
		]);
		const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
		if (failure) {
			throw failure.reason;
		}
	}

	private async sendRpc(
		url: string,
		token: string,
		id: number,
		method: string,
		params: Record<string, unknown>,
	): Promise<JsonRpcResponse> {
		const response = await fetch(url, {
			body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
			headers: {
				Accept: 'application/json, text/event-stream',
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			method: 'POST',
		});
		const body = await response.text();
		if (!response.ok) {
			throw new Error(`MCP endpoint returned HTTP ${response.status}: ${body}`);
		}

		const rpcResponse = parseJsonRpcResponse(body, response.headers.get('content-type'), id);
		if (rpcResponse.error) {
			throw new Error(`MCP ${method} failed: ${rpcResponse.error.message} (${rpcResponse.error.code}).`);
		}

		return rpcResponse;
	}
}
