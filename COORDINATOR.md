# Coordinator goal

Paste the block below into the project's instructions as the coordinator's standing goal,
in place of the previous one. It assumes the Porkbun planning PR is merged. The goal that
built v1.0.0 is in this file's git history.

---

**Goal:** Build the Porkbun integration described in `docs/porkbun-plan.md` on full
autopilot, following `AUTOPILOT.md`, until workstreams P0 to P7 are merged, the docs are
complete and `TODO-USER.md` tells me exactly what to change in my compose file and at
Porkbun, with tagging `v1.1.0` as the last open item.

**How to run it:**

1. Read `docs/porkbun-plan.md`, `PLAN.md`, `AUTOPILOT.md`, `DECISIONS.md` and
   `TODO-USER.md` at the start of every turn. They are the source of truth; the chat is
   not.
2. Launch one thread per workstream in `docs/porkbun-plan.md` §5 the moment its start
   condition holds, with the model and effort from the table. Do not ask me first. Right
   now that means P0 and the drafts part of P6 start together. When P0 merges, start P1,
   P2, P3, P4 and P5 together. P7 starts when P1 to P5 are merged.
3. Give each thread this brief: its row from the workstream table, its definition of done
   from §5.1, the contracts and the file ownership table from §3.2, the safety rules from
   §3.1, the design rules from §6, and the `AUTOPILOT.md` rules. Tell it to stay inside
   the folders it owns, to append to `DECISIONS.md` and `TODO-USER.md` as it goes, and to
   merge its own PR under the merge rules. A thread may use subagents for independent
   pieces as long as each one owns separate files.
4. When a thread reports done, re-check start conditions and launch what is unblocked.
   Keep at most six threads running at once.
5. Do not involve me unless an important design or code decision needs me. Every decision
   a thread makes goes in `DECISIONS.md` with a confidence score from 1 to 100. A decision
   scored below 70 is put to me as a question with a recommended option, and the thread
   keeps building on that option while it waits, unless the step cannot be undone. Collect
   such questions and ask them together where you can.
6. Keep one short status message in this chat, edited rather than repeated: running,
   merged and blocked workstreams, decisions waiting for me, and the open `TODO-USER.md`
   items. Message me directly only for a question under rule 5 or when a milestone from
   `docs/porkbun-plan.md` §9 lands.
7. If a thread is stuck for more than two attempts, relaunch it on the next stronger
   model (Sonnet → Opus → Fable) and log that in `DECISIONS.md`.
8. Never let a thread commit secrets (Porkbun keys above all), real domain names or
   private hostnames beyond what `PLAN.md` already contains, or disable tests to get
   green. No test may call the real Porkbun API; tests use the fake, and the sandbox job
   runs only with sandbox keys. Every call to Caddy's admin API goes through `adminFetch`.
   Never merge a PR that changes a §3.2 contract without a `DECISIONS.md` entry.
9. If I answer an open question in `docs/porkbun-plan.md` §8 with a yes, add the matching
   workstream (P8a, P8b, P8c or P9) to the table in a small PR and launch it once P0 is
   merged.
10. Models: Fable for P0, P2 and P5, Opus for P1, P3 and P7, Sonnet for P4 and P6. Effort
    as in the table.

**Done when:** P0 to P7 are merged with CI green, `README.md` and `docs/porkbun.md` are
complete, and `TODO-USER.md` lists the compose and Porkbun account steps and the `v1.1.0`
tag for me to make.

---
