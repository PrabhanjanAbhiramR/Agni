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

## Standalone TrueForge agent definition

[`trueforge/agni-agent.json`](trueforge/agni-agent.json) is a standalone,
serializable `CreateAgentRequest` for the named agent
`agni-vscode-workspace-agent`. It contains no provider credentials, MCP bearer
token, or ephemeral MCP URL. Its connector reference is the stable
`agni-vscode-workspace` name registered by the running extension.

The checked-in model value is deliberately the non-runnable placeholder
`<configured-model-fqn>`. [`trueforge/model.example.json`](trueforge/model.example.json)
shows the credential-free server URL and model-FQN inputs used for registration.
Configure provider credentials in the local TrueForge server, never in this
repository.

To register or update the named agent:

1. Start the local TrueForge server and configure a model in it.
2. Run **Agni: Test TrueForge Connection** and copy the exact model FQN shown by
   `client.models.list()`; do not substitute a provider model ID or guess an
   identifier.
3. In PowerShell, set the model FQN and, if necessary, the server URL for the
   current terminal process:

   ```powershell
   $env:AGNI_TRUEFORGE_MODEL = '<exact-configured-model-fqn>'
   $env:AGNI_TRUEFORGE_SERVER_URL = 'http://localhost:8790'
   npm run register:agent
   ```

   `AGNI_TRUEFORGE_SERVER_URL` is optional and defaults to
   `http://localhost:8790`. `AGNI_TRUEFORGE_MODEL` is required. The registration
   utility uses the public `client.agents.create()` or `client.agents.update()`
   SDK APIs and never configures a model provider.

4. Launch the Agni Extension Development Host before using workspace tools.
   On activation, the extension starts an authenticated loopback MCP endpoint
   and replaces the TrueForge connector named `agni-vscode-workspace` with that
   process's ephemeral URL and bearer credential. The endpoint remains alive
   until that Extension Host stops. Running **Agni: Test Workspace Tools** also
   refreshes the connector registration if TrueForge became available later.

A separately created session may reference the registered definition with:

```ts
await client.sessions.create({
  agent: { name: 'agni-vscode-workspace-agent' },
});
```

Agni's existing extension commands continue to create their current inline
agent specifications. Registering the standalone definition does not switch or
modify those runtime flows.

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
