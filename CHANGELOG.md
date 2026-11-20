# Change Log

## Unreleased

- Added a cancellable, read-only Planning Mode before Multi-File Edit implementation.
- Passed the approved objective, steps, files, dependencies, and risks into the TrueForge implementation turn.
- Added `propose_edit` for exact, proposal-only changes to existing files; `propose_write` now creates new files only.
- Required TrueForge approval for both proposal tools while preserving the separate per-file/per-hunk review and explicit apply step.
- Enforced the approved file scope when either proposal tool records a proposal and before reviewed changes are applied.
- Added line-ranged, numbered `read_file` responses and smaller independent review hunks for separated changes.
- Added read-only Git status and diff summaries for all open workspace folders, with deterministic filename/change-type risk indicators.
- Added regression coverage for plan scope, late cancellation responses, proposal approvals, exact multi-replacement edits, symbolic-link rejection, staged and unstaged changes, deletions, untracked files, clean repositories, and non-Git folders.
- Documented local TrueForge setup, named-agent registration, Extension Development Host launch, Agent Panel usage, reviewed application and guarded undo.

## 0.1.0 - 2026-11-08

- Added TrueForge model discovery, inline sessions, and streamed responses.
- Added authenticated read-only workspace tools over loopback MCP.
- Added explicit and automatic workspace context assembly.
- Added reviewed Inline Edit proposals.
- Added reviewed multi-file edits with per-file and per-hunk decisions, atomic apply, and guarded undo.
