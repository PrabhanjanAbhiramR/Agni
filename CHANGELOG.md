# Change Log

## Unreleased

- Added a cancellable, read-only Planning Mode before Multi-File Edit implementation.
- Passed the approved objective, steps, files, dependencies, and risks into the TrueForge implementation turn.
- Enforced the approved file scope both when `propose_write` records a proposal and before reviewed changes are applied.
- Added read-only Git status and diff summaries for all open workspace folders, with deterministic filename/change-type risk indicators.
- Added regression coverage for plan scope, late cancellation responses, staged and unstaged changes, deletions, untracked files, clean repositories, and non-Git folders.

## 0.1.0 - 2026-11-08

- Added TrueForge model discovery, inline sessions, and streamed responses.
- Added authenticated read-only workspace tools over loopback MCP.
- Added explicit and automatic workspace context assembly.
- Added reviewed Inline Edit proposals.
- Added reviewed multi-file edits with per-file and per-hunk decisions, atomic apply, and guarded undo.
