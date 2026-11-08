import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';
import {
	type WorkspaceSearchFile,
	type WorkspaceSearchMatch,
	WorkspaceTextSearch,
} from '../workspace/workspaceSearch.js';

const maxQueryTerms = 12;
const maxAutomaticMatches = 2_000;
const maxSnippetsPerFile = 2;
const maxRankedSnippets = 24;
const surroundingLines = 5;

const stopWords = new Set([
	'about', 'after', 'again', 'against', 'also', 'and', 'are', 'before', 'being', 'between', 'build',
	'can', 'change', 'code', 'could', 'does', 'existing', 'file', 'files', 'find', 'for', 'from', 'have',
	'implement', 'into', 'its', 'keep', 'make', 'need', 'please', 'project', 'should', 'that', 'the',
	'their', 'then', 'this', 'through', 'use', 'using', 'want', 'what', 'when', 'where', 'which', 'with',
	'workspace', 'would', 'your',
]);

export interface RelevantCodeTerm {
	value: string;
	weight: number;
}

export interface AutomaticCodeSnippet {
	endLine: number;
	path: string;
	root: string;
	score: number;
	section: string;
	startLine: number;
}

export interface AutomaticRetrievalResult {
	candidateCount: number;
	omittedByRanking: number;
	skippedFiles: number;
	snippets: AutomaticCodeSnippet[];
	terms: RelevantCodeTerm[];
	truncatedSearch: boolean;
}

function isCodeLike(value: string): boolean {
	return /[_$]/u.test(value)
		|| /[a-z][A-Z]/u.test(value)
		|| /^[A-Z][A-Za-z0-9]+$/u.test(value)
		|| /\d/u.test(value);
}

export function extractRelevantCodeTerms(prompt: string): RelevantCodeTerm[] {
	const terms = new Map<string, RelevantCodeTerm & { index: number }>();
	let index = 0;
	for (const match of prompt.matchAll(/[A-Za-z_$][A-Za-z0-9_$-]*/gu)) {
		const value = match[0];
		const normalized = value.toLocaleLowerCase();
		if (value.length < 3 || stopWords.has(normalized) || normalized === 'symbol') {
			continue;
		}

		const weight = isCodeLike(value) ? 4 : value.length >= 8 ? 2 : 1;
		const existing = terms.get(normalized);
		if (!existing) {
			terms.set(normalized, { index, value, weight });
			index += 1;
		} else if (weight > existing.weight) {
			existing.value = value;
			existing.weight = weight;
		}
	}

	return [...terms.values()]
		.sort((left, right) => right.weight - left.weight || left.index - right.index)
		.slice(0, maxQueryTerms)
		.map(({ value, weight }) => ({ value, weight }));
}

function exactIdentifierMatch(preview: string, term: string): boolean {
	const escaped = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`, 'iu').test(preview);
}

function scoreFile(file: WorkspaceSearchFile, terms: Map<string, RelevantCodeTerm>): number {
	const counts = new Map<string, number>();
	let exactMatches = 0;
	for (const match of file.matches) {
		const normalized = match.term.toLocaleLowerCase();
		counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
		if (exactIdentifierMatch(match.preview, match.term)) {
			exactMatches += terms.get(normalized)?.weight ?? 1;
		}
	}

	let score = 0;
	for (const [term, count] of counts) {
		const weight = terms.get(term)?.weight ?? 1;
		score += weight * (100 + Math.min(count, 10) * 10);
		if (file.path.toLocaleLowerCase().includes(term)) {
			score += weight * 50;
		}
	}
	return score + exactMatches * 20 - file.path.split('/').length;
}

function scoreLine(matches: WorkspaceSearchMatch[], terms: Map<string, RelevantCodeTerm>): number {
	return matches.reduce((score, match) => {
		const weight = terms.get(match.term.toLocaleLowerCase())?.weight ?? 1;
		return score + weight * (exactIdentifierMatch(match.preview, match.term) ? 20 : 10);
	}, 0);
}

function snippetsForFile(
	file: WorkspaceSearchFile,
	fileScore: number,
	terms: Map<string, RelevantCodeTerm>,
): AutomaticCodeSnippet[] {
	const matchesByLine = new Map<number, WorkspaceSearchMatch[]>();
	for (const match of file.matches) {
		const lineMatches = matchesByLine.get(match.line) ?? [];
		lineMatches.push(match);
		matchesByLine.set(match.line, lineMatches);
	}

	const selectedLines: number[] = [];
	for (const [line] of [...matchesByLine.entries()].sort((left, right) => {
		const scoreDifference = scoreLine(right[1], terms) - scoreLine(left[1], terms);
		return scoreDifference || left[0] - right[0];
	})) {
		if (selectedLines.every((selected) => Math.abs(selected - line) > surroundingLines * 2)) {
			selectedLines.push(line);
		}
		if (selectedLines.length >= maxSnippetsPerFile) {
			break;
		}
	}

	const lines = file.text.split(/\r?\n/u);
	return selectedLines.map((line) => {
		const startLine = Math.max(1, line - surroundingLines);
		const endLine = Math.min(lines.length, line + surroundingLines);
		const text = lines.slice(startLine - 1, endLine).join('\n');
		const lineScore = scoreLine(matchesByLine.get(line) ?? [], terms);
		return {
			endLine,
			path: file.path,
			root: file.root,
			score: fileScore + lineScore,
			section: [
				`===== BEGIN automatic context ${file.root}/${file.path}:${startLine}-${endLine} =====`,
				text,
				`===== END automatic context ${file.root}/${file.path} =====`,
			].join('\n'),
			startLine,
		};
	});
}

export class AutomaticContextRetriever {
	private readonly search: WorkspaceTextSearch;

	constructor(
		boundary = new WorkspaceBoundary(),
		search?: WorkspaceTextSearch,
	) {
		this.search = search ?? new WorkspaceTextSearch(boundary);
	}

	async retrieve(prompt: string, excludedPaths: ReadonlySet<string> = new Set()): Promise<AutomaticRetrievalResult> {
		const terms = extractRelevantCodeTerms(prompt);
		if (terms.length === 0) {
			return {
				candidateCount: 0,
				omittedByRanking: 0,
				skippedFiles: 0,
				snippets: [],
				terms,
				truncatedSearch: false,
			};
		}

		const searchResult = await this.search.search({
			maxMatches: maxAutomaticMatches,
			skipGeneratedContent: true,
			terms: terms.map((term) => term.value),
		});
		const termMap = new Map(terms.map((term) => [term.value.toLocaleLowerCase(), term]));
		const rankedSnippets = searchResult.files
			.filter((file) => !excludedPaths.has(`${file.root}\0${file.path}`))
			.flatMap((file) => {
				const fileScore = scoreFile(file, termMap);
				return snippetsForFile(file, fileScore, termMap);
			})
			.sort((left, right) =>
				right.score - left.score
				|| left.root.localeCompare(right.root)
				|| left.path.localeCompare(right.path)
				|| left.startLine - right.startLine,
			);
		const snippets = rankedSnippets.slice(0, maxRankedSnippets);

		return {
			candidateCount: searchResult.files.length,
			omittedByRanking: Math.max(0, rankedSnippets.length - snippets.length),
			skippedFiles: searchResult.skippedFiles,
			snippets,
			terms,
			truncatedSearch: searchResult.truncated,
		};
	}
}
