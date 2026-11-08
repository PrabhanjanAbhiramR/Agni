import { createHash } from 'node:crypto';
import { diffLines } from 'diff';

export type MultiFileHunkDecision = 'pending' | 'accepted' | 'rejected';

export interface MultiFileHunk {
	decision: MultiFileHunkDecision;
	id: string;
	originalEnd: number;
	originalStart: number;
	originalText: string;
	replacementText: string;
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
	const parts = diffLines(originalContent, proposedContent);
	const hunks: MultiFileHunk[] = [];
	let originalOffset = 0;
	let currentStart: number | undefined;
	let replacementText = '';

	const flush = (): void => {
		if (currentStart === undefined) {
			return;
		}
		const originalEnd = originalOffset;
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
			originalOffset += part.value.length;
			continue;
		}
		currentStart ??= originalOffset;
		if (part.removed) {
			originalOffset += part.value.length;
		} else if (part.added) {
			replacementText += part.value;
		}
	}
	flush();

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
