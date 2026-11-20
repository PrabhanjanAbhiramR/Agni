# Agni

Agni is a VS Code AI coding agent powered entirely by a local TrueForge runtime. It can inspect the current workspace, assemble relevant code context, prepare inline edits, and propose reviewed multi-file changes without calling model providers directly.

## Features

- Discover and select models configured in TrueForge.
- Read, list, and search workspace files through an authenticated loopback MCP server.
- Resolve explicit `@file` and `@symbol` references and retrieve relevant workspace context.
- Generate Inline Edit proposals and review them in VS Code's diff editor before applying.
- Generate multi-file proposals with per-file and per-hunk review, atomic application, stale-file protection, and guarded undo.
- Plan multi-file edits in a read-only TrueForge turn, review the structured plan, and approve its exact file scope before implementation begins.
- Inspect staged, unstaged, deleted, and untracked Git changes across every open workspace folder without modifying Git state.

Agni does not write files while TrueForge is generating a proposal. Accepted edits are applied through VS Code `WorkspaceEdit` operations.

## Requirements

- Node.js 22.14 or later and npm.
- VS Code 1.144 or later.
- A running TrueForge server reachable from the Extension Host. The default is `http://localhost:8790`.
- At least one model configured in that TrueForge server.
- A trusted VS Code workspace for workspace tools and editing features.

Agni routes model operations through TrueForge and does not call Gemini or another model provider directly.

## Local TrueForge setup

Follow the [TrueForge quickstart](https://trueforge.dev/quickstart) and start the
local runtime from PowerShell:

```powershell
npx @truefoundry/trueforge@latest
```

Open the UI at the URL printed by TrueForge (typically
`http://localhost:8790`) and configure a model there. Provider credentials stay
in TrueForge and are not stored by Agni. The repository contains no API keys.

The credential-free [`trueforge/model.example.json`](trueforge/model.example.json)
shows the server URL and model-FQN values used by the registration workflow.
Use the exact model FQN returned by TrueForge; do not guess or substitute a
provider model identifier.

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

To register or update [`trueforge/agni-agent.json`](trueforge/agni-agent.json)
as the named agent:

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
- `Agni: Show Git Status and Risk Indicators`

The **Agni Review** view in the Explorer contains file and hunk review actions for active multi-file proposals.

## Launch and configure Agni

Install dependencies and compile the extension:

```powershell
npm ci
npm run compile
```

Open the repository in VS Code and press `F5`. The checked-in **Run Extension**
configuration compiles Agni and opens a separate Extension Development Host.
Open and trust the workspace that Agni should inspect in that Development Host.

Configure these exact VS Code settings when their defaults are not suitable:

- `agni.trueForge.serverUrl`: the TrueForge server base URL; defaults to
  `http://localhost:8790`.
- `agni.trueForge.selectedModel`: an exact configured TrueForge model FQN to
  preselect in model pickers.
- `agni.context.maxBytes`: the assembled-context byte budget.

Run **Agni: Test TrueForge Connection** to list the models configured in the
server and select one. Run **Agni: Test Workspace Tools** if you want to verify
the authenticated workspace MCP connector before an agent task.

## Agent Panel and reviewed edits

Open the Explorer and expand **Agni Agent**. Enter a natural-language task in
the chat input; Agni assembles relevant workspace context, displays the selected
files and reasons, and sends the task through TrueForge. The model may use the
authenticated `read_file`, `list_files`, and `search_code` MCP tools to discover
additional code.

For an existing file, the agent must use `propose_edit` with exact text
replacements. For a new file, it must use `propose_write` with the complete new
file content. `propose_write` rejects existing files. Both tools create only
in-memory proposals and never write directly to the workspace.

TrueForge tool approval and final edit application are separate safety gates:

1. **Allow Proposal** permits TrueForge to execute `propose_edit` or
   `propose_write` and record an in-memory proposal. **Deny** prevents that tool
   execution. Allowing a tool does not modify a workspace file.
2. Review each proposed file and hunk under **Agni Review**. Use the file and
   hunk Accept/Reject actions or the CodeLens actions above proposed hunks.
3. Run **Agni: Apply Reviewed Changes** to apply only accepted hunks through one
   guarded VS Code `WorkspaceEdit`. Stale files are rejected rather than
   overwritten.
4. Run **Agni: Reject Multi-File Edit** to discard the active proposal without
   writing files.
5. After an application, run **Agni: Undo Last Multi-File Edit** for the guarded,
   stale-aware rollback.

## Planning Mode

Run **Agni: Multi-File Edit** and enter the task normally. Agni first uses the
authenticated read-only MCP tools to inspect the workspace and asks TrueForge
for a structured plan containing an objective, ordered steps, affected files,
dependencies, and risks. Review that plan in the **Agni** output channel and
approve it in the modal confirmation before implementation starts.

The approved plan—not only the original task—is sent to the implementation
agent. Both `propose_edit` and `propose_write` are restricted to the approved
workspace-root/file pairs, and Agni validates the same scope again before
applying reviewed edits. If the
implementation discovers that another file is required, the run stops without
recording that out-of-scope proposal; start Multi-File Edit again to review and
approve a revised plan. Cancelling either model-execution phase cancels its
TrueForge session, and late stream responses cannot create proposals.

In a multi-root workspace, planned paths are displayed as
`<workspace-root-id>/<relative-path>` so approval remains unambiguous.

## Git-aware status

Run **Agni: Show Git Status and Risk Indicators** to inspect every open
workspace folder. Agni uses fixed, read-only Git commands to report the branch,
staged and unstaged files, deletions, untracked files, and available line-count
summaries. It never stages, resets, checks out, commits, pushes, or runs a Git
command supplied by a model.

Risk indicators are deterministic filename and change-type heuristics. They
help prioritize review, but they are explicitly not verified vulnerabilities or
evidence that a file contains a secret.

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

## Project origin and licensing

Agni was built from scratch and is not an upstream fork. Agni's original code
is licensed under Apache License 2.0; see [`LICENSE`](LICENSE). Required
third-party attributions are listed in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Release status

Version `0.1.0` is the first public development release. Autonomous writes, unrestricted terminal execution, and direct model-provider calls are intentionally not supported.
