export interface NormalizedGeneratedSource {
	content: string;
	normalizedPythonTripleQuotes: boolean;
}

type PythonScanState =
	| 'code'
	| 'comment'
	| 'single'
	| 'double'
	| 'triple-single'
	| 'triple-double'
	| 'normalized-triple-single'
	| 'normalized-triple-double';

const escapedTripleDouble = '\\"\\"\\"';
const escapedTripleSingle = "\\'\\'\\'";

function normalizePythonTripleQuotes(content: string): NormalizedGeneratedSource {
	let state: PythonScanState = 'code';
	let output = '';
	let normalized = false;
	let normalizedStringOpen = false;

	for (let index = 0; index < content.length;) {
		const remaining = content.slice(index);
		if (state === 'code') {
			if (remaining.startsWith(escapedTripleDouble)) {
				output += '"""';
				index += escapedTripleDouble.length;
				state = 'normalized-triple-double';
				normalized = true;
				normalizedStringOpen = true;
				continue;
			}
			if (remaining.startsWith(escapedTripleSingle)) {
				output += "'''";
				index += escapedTripleSingle.length;
				state = 'normalized-triple-single';
				normalized = true;
				normalizedStringOpen = true;
				continue;
			}
			if (remaining.startsWith('"""')) {
				output += '"""';
				index += 3;
				state = 'triple-double';
				continue;
			}
			if (remaining.startsWith("'''")) {
				output += "'''";
				index += 3;
				state = 'triple-single';
				continue;
			}
			const character = content[index] ?? '';
			output += character;
			index += 1;
			if (character === '#') {
				state = 'comment';
			} else if (character === "'") {
				state = 'single';
			} else if (character === '"') {
				state = 'double';
			}
			continue;
		}

		if (state === 'comment') {
			const character = content[index] ?? '';
			output += character;
			index += 1;
			if (character === '\n' || character === '\r') {
				state = 'code';
			}
			continue;
		}

		if (state === 'single' || state === 'double') {
			const character = content[index] ?? '';
			output += character;
			index += 1;
			if (character === '\\' && index < content.length) {
				output += content[index];
				index += 1;
				continue;
			}
			if ((state === 'single' && character === "'")
				|| (state === 'double' && character === '"')) {
				state = 'code';
			}
			continue;
		}

		const quote = state.endsWith('double') ? '"' : "'";
		const rawDelimiter = quote.repeat(3);
		const normalizedDelimiter = quote === '"' ? escapedTripleDouble : escapedTripleSingle;
		if (state.startsWith('normalized-') && remaining.startsWith(normalizedDelimiter)) {
			output += rawDelimiter;
			index += normalizedDelimiter.length;
			state = 'code';
			normalizedStringOpen = false;
			continue;
		}
		if (remaining.startsWith(rawDelimiter)) {
			output += rawDelimiter;
			index += rawDelimiter.length;
			state = 'code';
			if (normalizedStringOpen) {
				normalizedStringOpen = false;
			}
			continue;
		}
		const character = content[index] ?? '';
		output += character;
		index += 1;
		if (character === '\\' && index < content.length) {
			output += content[index];
			index += 1;
		}
	}

	// Never partially rewrite an unterminated candidate. Returning the exact model
	// output is safer than guessing which escaped quotes were intended as delimiters.
	if (normalizedStringOpen) {
		return { content, normalizedPythonTripleQuotes: false };
	}
	return { content: output, normalizedPythonTripleQuotes: normalized };
}

export function normalizeGeneratedSourceContent(
	path: string,
	content: string,
): NormalizedGeneratedSource {
	return /\.py$/iu.test(path)
		? normalizePythonTripleQuotes(content)
		: { content, normalizedPythonTripleQuotes: false };
}
