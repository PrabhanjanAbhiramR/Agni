# Agni

Agni is a VS Code AI coding agent powered entirely by a local TrueForge runtime. It can inspect the current workspace, assemble relevant code context, prepare inline edits, and propose reviewed multi-file changes without calling model providers directly.

## Features

- Discover and select models configured in TrueForge.
- Read, list, and search workspace files through an authenticated loopback MCP server.
- Resolve explicit `@file` and `@symbol` references and retrieve relevant workspace context.
- Generate Inline Edit proposals and review them in VS Code's diff editor before applying.
- Generate multi-file proposals with per-file and per-hunk review, atomic application, stale-file protection, and guarded undo.

Agni does not write files while TrueForge is generating a proposal. Accepted edits are applied through VS Code `WorkspaceEdit` operations.

## Requirements

- VS Code 1.144 or later.
- A TrueForge server reachable from the Extension Host. The default is `http://localhost:8790`.
- At least one model configured in that TrueForge server.
- A trusted VS Code workspace for workspace tools and editing features.

Agni routes model operations through TrueForge and does not call Gemini or another model provider directly.

## Commands

- `Agni: Test TrueForge Connection`
- `Agni: Test Workspace Tools`
- `Agni: Test TrueForge Workspace Agent`
- `Agni: Inline Edit`
- `Agni: Multi-File Edit`
- `Agni: Apply Reviewed Changes`
- `Agni: Undo Last Multi-File Edit`

The **Agni Review** view in the Explorer contains file and hunk review actions for active multi-file proposals.

## Settings

- `agni.trueForge.serverUrl`: TrueForge server base URL.
- `agni.trueForge.selectedModel`: Preferred configured model FQN.
- `agni.context.maxBytes`: Maximum UTF-8 byte budget for assembled context.

## Development

```sh
npm ci
npm run compile
npm run lint
npm test
```

Press `F5` in VS Code to open an Extension Development Host with the current project loaded.

## Release status

Version `0.1.0` is the first public development release. Autonomous writes, unrestricted terminal execution, and direct model-provider calls are intentionally not supported.
