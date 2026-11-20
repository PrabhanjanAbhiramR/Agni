# Official Forge-a-thon Tasks

**Repo for tasks:** pallets/flask, tag 3.1.3 (commit 22d92470). The wording is fixed.

**Task A: Inline edit.** Open `src/flask/helpers.py`, select the function `get_debug_flag`, and instruct: “Treat the values ‘off’ and ’n’ as false as well, case-insensitively, and update the docstring to list every value that is treated as false.” Review and accept the diff.

Verify: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False`.

**Task B: Agent mode (3+ files, none named).** In the agent panel, mention no files, and instruct: “Add a new built-in CLI command flask config that prints the loaded application’s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as “\*\*\*”. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.” Review the hunks and accept. Show the TrueForge session for this run.

Verify: `pytest tests/test_cli.py -q` passes, then run the new command against any Flask app and show the masked JSON. The diff must touch at least 3 files.

**Task C: Resilience.** Configure TrueForge with an unreachable endpoint or an invalid key, then repeat Task A.

Verify: the editor stays responsive, the user sees a clear message (or a second configured model takes over automatically), and `git status` shows no changed files.

**Eligibility (pass or fail):** the agent loop runs on TrueForge. The extension calls no model provider directly. Editor capabilities are MCP tools. The model is configured in TrueForge. The repo contains the agent definition. The video shows the TrueForge session for Task B.

**Scoring (100 points):**

- A1 Inline edit (10): 4 = no diff, 7 = accept-all only, 10 = per-hunk accept/reject.
- A2 Agent mode (10): 4 = single file, 7 = user named the files, 10 = finds and edits 3+ files unprompted.
- A3 Streaming/cancel (10): 4 = no cancel, 7 = can leave half-applied edits, 10 = immediate and consistent.
- B1 Context (15): 5 = @-mentions only, 10 = automatic retrieval, 15 = also size-budgeted and shows which files it chose and why in Task B.
- B2 Diff safety (10): 5 = full-file preview, 10 = per-hunk review plus a working undo shown on screen.
- B3 Resilience (10): 4 = clear error, 7 = retry with backoff then error, 10 = automatic fallback to a second model.
- B4 TrueForge depth (10): 4 = sessions and turns only, 7 = MCP tools with TrueForge approval driving the diff review, 10 = also one context-engineering feature (subagents, deferred tools, Code Mode, compaction) or skills.
- C1 Video (10) and C2 Write-up (15).

Where a submission falls between two anchors, the lower one applies.
