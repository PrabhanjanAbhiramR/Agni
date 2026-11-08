import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	ContextAssembler,
	ContextAssemblyError,
	ContextBudgetExceededError,
	type DocumentSymbolAdapter,
} from '../context/contextAssembler.js';
import type { WorkspaceAdapter } from '../workspace/workspaceAccess.js';
import { WorkspaceBoundary } from '../workspace/workspaceBoundary.js';

interface TestFile {
	openText?: string;
	readError?: Error;
	text: string;
}

class ContextWorkspaceAdapter implements WorkspaceAdapter {
	readonly files = new Map<string, TestFile>();

	constructor(private readonly root: vscode.WorkspaceFolder) {}

	addFile(path: string, text: string, options: { openText?: string; readError?: Error } = {}): vscode.Uri {
		const uri = vscode.Uri.joinPath(this.root.uri, ...path.split('/'));
		this.files.set(uri.toString(), { text, ...options });
		return uri;
	}

	findFiles(
		_include: vscode.GlobPattern,
		_exclude: vscode.GlobPattern | null | undefined,
		maxResults: number,
	): Thenable<vscode.Uri[]> {
		return Promise.resolve(
			[...this.files.keys()].slice(0, maxResults).map((value) => vscode.Uri.parse(value)),
		);
	}

	getOpenDocumentText(uri: vscode.Uri): string | undefined {
		return this.files.get(uri.toString())?.openText;
	}

	getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
		return [this.root];
	}

	readFile(uri: vscode.Uri): Thenable<Uint8Array> {
		const file = this.files.get(uri.toString());
		if (!file) {
			return Promise.reject(new Error(`Missing test file: ${uri.toString()}`));
		}
		if (file.readError) {
			return Promise.reject(file.readError);
		}
		return Promise.resolve(new TextEncoder().encode(file.text));
	}

	stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
		const file = this.files.get(uri.toString());
		if (file) {
			return Promise.resolve({
				ctime: 0,
				mtime: 0,
				size: new TextEncoder().encode(file.text).byteLength,
				type: vscode.FileType.File,
			});
		}

		const prefix = `${uri.toString().replace(/\/$/, '')}/`;
		if ([...this.files.keys()].some((value) => value.startsWith(prefix))) {
			return Promise.resolve({ ctime: 0, mtime: 0, size: 0, type: vscode.FileType.Directory });
		}
		return Promise.reject(new Error(`Missing test path: ${uri.toString()}`));
	}
}

class TestDocumentSymbolAdapter implements DocumentSymbolAdapter {
	readonly errors = new Map<string, Error>();
	readonly symbols = new Map<string, readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]>();

	getDocumentSymbols(
		uri: vscode.Uri,
	): Thenable<readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined> {
		const error = this.errors.get(uri.toString());
		if (error) {
			return Promise.reject(error);
		}
		return Promise.resolve(this.symbols.get(uri.toString()));
	}
}

function createAssembler(): {
	assembler: ContextAssembler;
	files: ContextWorkspaceAdapter;
	symbols: TestDocumentSymbolAdapter;
} {
	const root: vscode.WorkspaceFolder = {
		index: 0,
		name: 'project',
		uri: vscode.Uri.file('C:\\agni-context-test\\project'),
	};
	const files = new ContextWorkspaceAdapter(root);
	const symbols = new TestDocumentSymbolAdapter();
	return {
		assembler: new ContextAssembler(new WorkspaceBoundary(files), symbols),
		files,
		symbols,
	};
}

suite('Context assembler', () => {
	test('includes a valid @file reference and unsaved contents', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/example.ts', 'const state = "saved";', {
			openText: 'const state = "unsaved";',
		});

		const result = await assembler.assemble('Explain @file:src/example.ts', 4096);

		assert.match(result.content, /BEGIN @file project\/src\/example\.ts/u);
		assert.match(result.content, /const state = "unsaved";/u);
		assert.deepStrictEqual(result.references, [{
			kind: 'file',
			path: 'src/example.ts',
			root: 'project',
		}]);
	});

	test('locates and includes a document @symbol', async () => {
		const { assembler, files, symbols } = createAssembler();
		const source = 'export function target() {\n\treturn 1;\n}\n\nconst other = 2;';
		const uri = files.addFile('src/example.ts', source);
		symbols.symbols.set(uri.toString(), [new vscode.DocumentSymbol(
			'target',
			'',
			vscode.SymbolKind.Function,
			new vscode.Range(0, 0, 3, 0),
			new vscode.Range(0, 16, 0, 22),
		)]);

		const result = await assembler.assemble('Review @symbol:target', 4096);

		assert.match(result.content, /BEGIN @symbol function target/u);
		assert.match(result.content, /export function target\(\)/u);
		assert.doesNotMatch(result.content, /const other/u);
	});

	test('reports missing file and symbol references clearly', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/example.ts', 'const present = true;');

		await assert.rejects(
			assembler.assemble('Use @file:missing.ts', 4096),
			(error: unknown) => error instanceof ContextAssemblyError
				&& /Unable to resolve @file:missing\.ts/u.test(error.message),
		);
		await assert.rejects(
			assembler.assemble('Use @symbol:missing', 4096),
			(error: unknown) => error instanceof ContextAssemblyError
				&& /no supported document symbol named "missing"/u.test(error.message),
		);
	});

	test('reports ambiguous symbols with candidate locations', async () => {
		const { assembler, files, symbols } = createAssembler();
		for (const path of ['src/one.ts', 'src/two.ts']) {
			const uri = files.addFile(path, 'function duplicate() {}');
			symbols.symbols.set(uri.toString(), [new vscode.DocumentSymbol(
				'duplicate',
				'',
				vscode.SymbolKind.Function,
				new vscode.Range(0, 0, 0, 23),
				new vscode.Range(0, 9, 0, 18),
			)]);
		}

		await assert.rejects(
			assembler.assemble('Compare @symbol:duplicate', 4096),
			(error: unknown) => error instanceof ContextAssemblyError
				&& /ambiguous/u.test(error.message)
				&& /src\/one\.ts:1/u.test(error.message)
				&& /src\/two\.ts:1/u.test(error.message),
		);
	});

	test('rejects path traversal in explicit references', async () => {
		const { assembler } = createAssembler();

		await assert.rejects(
			assembler.assemble('Read @file:../secret.txt', 4096),
			(error: unknown) => error instanceof ContextAssemblyError && /traversal/u.test(error.message),
		);
	});

	test('fails instead of truncating when the context budget is exceeded', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('large.txt', 'important-content'.repeat(20));

		await assert.rejects(
			assembler.assemble('Read @file:large.txt', 128),
			(error: unknown) => error instanceof ContextBudgetExceededError
				&& /Nothing was truncated or sent/u.test(error.message),
		);
	});

	test('reports inaccessible files', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('private.ts', 'secret', { readError: new Error('Access denied by test filesystem.') });

		await assert.rejects(
			assembler.assemble('Read @file:private.ts', 4096),
			(error: unknown) => error instanceof ContextAssemblyError
				&& /Access denied by test filesystem/u.test(error.message),
		);
	});

	test('reports document-symbol provider failures without returning incomplete matches', async () => {
		const { assembler, files, symbols } = createAssembler();
		const uri = files.addFile('private.ts', 'function hidden() {}');
		symbols.errors.set(uri.toString(), new Error('Language service denied access.'));

		await assert.rejects(
			assembler.assemble('Read @symbol:private.ts#hidden', 4096),
			(error: unknown) => error instanceof ContextAssemblyError
				&& /lookup was incomplete/u.test(error.message)
				&& /Language service denied access/u.test(error.message),
		);
	});

	test('ranks relevant files deterministically and includes surrounding code', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/authService.ts', [
			'export function authenticateUser(token: string) {',
			'\tconst normalized = token.trim();',
			'\tif (!validateToken(normalized)) {',
			'\t\tthrow new Error("invalid token");',
			'\t}',
			'\treturn loadUser(normalized);',
			'}',
		].join('\n'));
		files.addFile('src/userLabel.ts', 'export const userLabel = (user: string) => user;');
		files.addFile('src/tokenStyles.ts', 'export const tokenColor = "blue";');

		const result = await assembler.assemble('Fix authenticateUser token validation failure', 8192);

		assert.strictEqual(result.automatic.included[0]?.path, 'src/authService.ts');
		assert.match(result.content, /const normalized = token\.trim\(\)/u);
		assert.match(result.content, /return loadUser\(normalized\)/u);
	});

	test('excludes dependencies, generated output, generated files and binaries', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/auth.ts', 'export function authenticateUser(token: string) { return token; }');
		files.addFile('node_modules/pkg/auth.ts', 'authenticateUser token token token');
		files.addFile('dist/auth.js', 'authenticateUser token token token');
		files.addFile('src/generated.ts', '// DO NOT EDIT - automatically generated\nauthenticateUser token');
		files.addFile('assets/auth.png', 'authenticateUser token');

		const result = await assembler.assemble('Investigate authenticateUser token', 8192);
		const includedPaths = result.automatic.included.map((entry) => entry.path);

		assert.deepStrictEqual(includedPaths, ['src/auth.ts']);
		assert.doesNotMatch(result.content, /node_modules|DO NOT EDIT|assets\/auth\.png/u);
	});

	test('uses remaining budget for automatic retrieval without truncating snippets', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/auth.ts', 'export function authenticateUser(token: string) { return token; }');

		const result = await assembler.assemble('Investigate authenticateUser token', 128);

		assert.strictEqual(result.content, '');
		assert.strictEqual(result.automatic.included.length, 0);
		assert.ok(result.automatic.omittedForBudget > 0);
	});

	test('gives explicit references priority over automatic retrieval', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('explicit.ts', 'export const explicitContext = "must be retained";');
		files.addFile('src/auth.ts', 'export function authenticateUser(token: string) { return token; }');
		const explicitOnly = await assembler.assemble('Use @file:explicit.ts', 8192);

		const result = await assembler.assemble(
			'Use @file:explicit.ts to diagnose authenticateUser token handling',
			explicitOnly.byteLength,
		);

		assert.match(result.content, /must be retained/u);
		assert.strictEqual(result.references.length, 1);
		assert.strictEqual(result.automatic.included.length, 0);
		assert.ok(result.automatic.omittedForBudget > 0);
	});

	test('returns an explicit empty retrieval summary when no code matches', async () => {
		const { assembler, files } = createAssembler();
		files.addFile('src/example.ts', 'export const present = true;');

		const result = await assembler.assemble('Diagnose ZzzzNoSuchIdentifier', 8192);

		assert.strictEqual(result.content, '');
		assert.strictEqual(result.automatic.candidateCount, 0);
		assert.deepStrictEqual(result.automatic.included, []);
		assert.strictEqual(result.automatic.omittedForBudget, 0);
	});
});
