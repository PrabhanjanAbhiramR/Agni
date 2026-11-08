export interface AgniToolResult {
	[key: string]: unknown;
	content: Array<{ type: 'text'; text: string }>;
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
}

export function errorToolResult(error: unknown): AgniToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: 'text', text: `Error: ${message}` }],
		isError: true,
	};
}

export function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) {
		return fallback;
	}

	if (!Number.isInteger(value) || value < 1) {
		throw new Error('Result limits must be positive integers.');
	}

	return Math.min(value, maximum);
}
