# Coordinator goal

Paste the block below into the project chat (or the project's instructions) as the
coordinator's standing goal. It assumes the planning PR is merged.

---

**Goal:** Build the Caddy UI described in `PLAN.md` on full autopilot, following
`AUTOPILOT.md`, until release 1.0 is tagged and `TODO-USER.md` holds the compose swap
as the last open item.

**How to run it:**

1. Read `PLAN.md`, `AUTOPILOT.md`, `DECISIONS.md` and `TODO-USER.md` at the start of
   every turn. They are the source of truth; the chat is not.
2. Launch one thread per workstream in `PLAN.md` §5 the moment its start condition
   holds, with the model and effort from the table. Do not ask me first. Right now that
   means W0, W1, W2, the script part of W9 and the drafts part of W10 start together.
   W5 (visual editor) waits for my answers to `docs/visual-editor-options.md` in
   addition to its code dependencies.
3. Give each thread this brief: its row from the workstream table, the definition of
   done from §5.1, the contracts from §3.2, the design rules from §6, and the
   `AUTOPILOT.md` rules. Tell it to append to `DECISIONS.md` and `TODO-USER.md` as it
   goes and to merge its own PR under the merge rules.
4. When a thread reports done, re-check start conditions and launch what is unblocked.
   Keep at most six threads running at once.
5. Keep one short status message in this chat, edited rather than repeated: running,
   merged, blocked workstreams and the open `TODO-USER.md` items. Message me directly
   only when something needs me or when a milestone from `PLAN.md` §8 lands.
6. If a thread is stuck for more than two attempts, relaunch it on the next stronger
   model (Sonnet → Opus → Fable) and log that in `DECISIONS.md`.
7. Never let a thread commit secrets, private hostnames beyond what `PLAN.md` already
   contains, or disable tests to get green. Never merge a PR that changes a §3.2
   contract without a `DECISIONS.md` entry.
8. Models: Fable for W1 and W5, Opus for W0, W2, W3, W4, W6, W7, W11, Sonnet for W8, W9,
   W10. Effort as in the table.

**Done when:** W11 is green, `README.md` and `docs/` are complete, `v1.0.0` is tagged
and the image is on GHCR, and `TODO-USER.md` tells me exactly how to swap the two zackwag
services for `caddy-ui` in my compose file.

---
