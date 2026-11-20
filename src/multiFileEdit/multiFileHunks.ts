import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';

export type MultiFileHunkDecision = 'pending' | 'accepted' | 'rejected';

export interface MultiFileHunk {
	decision: MultiFileHunkDecision;
	id: string;
	originalEnd: number;
	originalStart: number;
	originalText: string;
	replacementText: string;
}

interface TextLine {
	canonical: string;
	end: number;
	start: number;
}

function textLines(content: string): TextLine[] {
	const lines: TextLine[] = [];
	let start = 0;
	for (let index = 0; index < content.length; index += 1) {
		if (content[index] !== '\n' && content[index] !== '\r') {
			continue;
		}
		const terminatorLength = content[index] === '\r' && content[index + 1] === '\n' ? 2 : 1;
		const end = index + terminatorLength;
		lines.push({
			canonical: `${content.slice(start, index)}\n`,
			end,
			start,
		});
		start = end;
		index = end - 1;
	}
	if (start < content.length) {
		lines.push({ canonical: content.slice(start), end: content.length, start });
	}
	return lines;
}

function lineOffset(lines: readonly TextLine[], index: number, contentLength: number): number {
	return lines[index]?.start ?? contentLength;
}

function preferredEol(content: string, fallback: string): string {
	const match = content.match(/\r\n|\n|\r/u) ?? fallback.match(/\r\n|\n|\r/u);
	return match?.[0] ?? '\n';
}

function withEol(content: string, eol: string): string {
	return content.replace(/\r\n|\n|\r/gu, eol);
}

function hunkId(
	identity: string,
	originalStart: number,
	originalEnd: number,
	originalText: string,
	replacementText: string,
): string {
	return createHash('sha256')
		.update(identity, 'utf8')
		.update('\0')
		.update(String(originalStart))
		.update(':')
		.update(String(originalEnd))
		.update('\0')
		.update(originalText, 'utf8')
		.update('\0')
		.update(replacementText, 'utf8')
		.digest('hex')
		.slice(0, 20);
}

export function createMultiFileHunks(
	originalContent: string,
	proposedContent: string,
	identity: string,
): MultiFileHunk[] {
	const originalLines = textLines(originalContent);
	const proposedLines = textLines(proposedContent);
	const parts = diffArrays(
		originalLines.map((line) => line.canonical),
		proposedLines.map((line) => line.canonical),
	);
	const hunks: MultiFileHunk[] = [];
	const replacementEol = preferredEol(originalContent, proposedContent);
	let originalLine = 0;
	let proposedLine = 0;
	let currentStart: number | undefined;
	let replacementText = '';

	const flush = (): void => {
		if (currentStart === undefined) {
			return;
		}
		const originalEnd = lineOffset(originalLines, originalLine, originalContent.length);
		const originalText = originalContent.slice(currentStart, originalEnd);
		hunks.push({
			decision: 'pending',
			id: hunkId(identity, currentStart, originalEnd, originalText, replacementText),
			originalEnd,
			originalStart: currentStart,
			originalText,
			replacementText,
		});
		currentStart = undefined;
		replacementText = '';
	};

	for (const part of parts) {
		if (!part.added && !part.removed) {
			flush();
			originalLine += part.value.length;
			proposedLine += part.value.length;
			continue;
		}
		currentStart ??= lineOffset(originalLines, originalLine, originalContent.length);
		if (part.removed) {
			originalLine += part.value.length;
		} else if (part.added) {
			const proposedStart = lineOffset(proposedLines, proposedLine, proposedContent.length);
			proposedLine += part.value.length;
			const proposedEnd = lineOffset(proposedLines, proposedLine, proposedContent.length);
			replacementText += withEol(
				proposedContent.slice(proposedStart, proposedEnd),
				replacementEol,
			);
		}
	}
	flush();

	// A proposal that changes only line endings is still a real proposal. Keep it
	// reviewable as one hunk; ordinary source edits use the EOL-equivalent line diff above.
	if (hunks.length === 0 && originalContent !== proposedContent) {
		return [{
			decision: 'pending',
			id: hunkId(identity, 0, originalContent.length, originalContent, proposedContent),
			originalEnd: originalContent.length,
			originalStart: 0,
			originalText: originalContent,
			replacementText: proposedContent,
		}];
	}

	if (hunks.length === 0 && originalContent === proposedContent && originalContent.length === 0) {
		return [{
			decision: 'pending',
			id: hunkId(identity, 0, 0, '', ''),
			originalEnd: 0,
			originalStart: 0,
			originalText: '',
			replacementText: '',
		}];
	}
	return hunks;
}

export function materializeHunkDecisions(
	originalContent: string,
	hunks: readonly MultiFileHunk[],
	includePending: boolean,
): string {
	let cursor = 0;
	let content = '';
	for (const hunk of [...hunks].sort((left, right) => left.originalStart - right.originalStart)) {
		if (hunk.originalStart < cursor
			|| hunk.originalEnd < hunk.originalStart
			|| originalContent.slice(hunk.originalStart, hunk.originalEnd) !== hunk.originalText) {
			throw new Error(`Invalid or overlapping multi-file hunk: ${hunk.id}.`);
		}
		content += originalContent.slice(cursor, hunk.originalStart);
		content += hunk.decision === 'accepted' || (includePending && hunk.decision === 'pending')
			? hunk.replacementText
			: hunk.originalText;
		cursor = hunk.originalEnd;
	}
	return content + originalContent.slice(cursor);
}

export function hunkLineNumber(content: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < Math.min(offset, content.length); index += 1) {
		if (content[index] === '\n') {
			line += 1;
		}
	}
	return line;
}
