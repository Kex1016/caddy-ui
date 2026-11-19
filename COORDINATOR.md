# Coordinator goal

Paste the block below into the project's instructions as the coordinator's standing goal,
in place of the previous one. It assumes the plan PR for
`docs/settings-and-perf-plan.md` is merged. Pasting it is the "build it" that plan waits
for. The goals that built v1.0.0 and the Porkbun integration are in this file's git
history.

---

**Goal:** Build what `docs/settings-and-perf-plan.md` describes on full autopilot,
following `AUTOPILOT.md`: Overview and Sites that load at once, and the Settings page with
its extras, until workstreams S0 to S6 are merged, the docs are complete and
`TODO-USER.md` tells me exactly what to do on my side, with releasing `v1.2.0` as the last
open item.

**How to run it:**

1. Read `docs/settings-and-perf-plan.md`, `PLAN.md`, `AUTOPILOT.md`, `DECISIONS.md` and
   `TODO-USER.md` at the start of every turn. They are the source of truth; the chat is
   not.
2. Launch one thread per workstream in `docs/settings-and-perf-plan.md` §6 the moment its
   start condition holds, with the model and effort from the table. Do not ask me first.
   S0 and S1 start together; S1 rebases onto S0 before it merges, because both touch the
   collector. S2 starts when S1 is merged. S3, S4 and S5 start when S2 is merged. S6 starts
   with them, and its export and import part merges last so it covers their settings.
3. Give each thread this brief: its row from the workstream table, the sections of the
   plan it builds (§1.3 for S0, §2 for S1 and S2, §3 and §3.1 for S3 to S6), my answers in
   §4, the decisions in §5, the design rules from `PLAN.md` §6, and the `AUTOPILOT.md`
   rules. Tell it to append to `DECISIONS.md` and `TODO-USER.md` as it goes and to merge
   its own PR under the merge rules.
4. S0 ships first and on its own. As soon as it is merged, tell me, so I can deploy it and
   check the `Server-Timing` numbers on my server. If the pages are still slow there, that
   comes before any Settings work.
5. When a thread reports done, re-check start conditions and launch what is unblocked.
   Keep at most six threads running at once.
6. Do not involve me unless an important design or code decision needs me. Every decision
   a thread makes goes in `DECISIONS.md` with a confidence score from 1 to 100. A decision
   scored below 70 is put to me as a question with a recommended option, and the thread
   keeps building on that option while it waits, unless the step cannot be undone. Collect
   such questions and ask them together where you can.
7. Keep one short status message in this chat, edited rather than repeated: running,
   merged and blocked workstreams, decisions waiting for me, and the open `TODO-USER.md`
   items. Message me directly only for rule 4, a question under rule 6, or when everything
   is merged.
8. If a thread is stuck for more than two attempts, relaunch it on the next stronger
   model (Sonnet → Opus → Fable) and log that in `DECISIONS.md`.
9. What I decided and threads must not reopen: the UI wins over the environment for
   editable settings; sign-in, paths, the admin URL and the port stay environment-only;
   Porkbun keys are never entered, stored or shown in the UI, only "set" or "not set"; raw
   probe results are kept for the full retention; no editor preferences.
10. Never let a thread commit secrets (Porkbun keys, a Discord webhook URL), real domain
    names or private hostnames beyond what `PLAN.md` already contains, or disable tests to
    get green. No test may call the real Porkbun API or a real Discord webhook; tests use
    fakes. Every call to Caddy's admin API goes through `adminFetch`. Never merge a PR
    that changes a `PLAN.md` §3.2 contract or adds an API route without a `DECISIONS.md`
    entry. Database migrations are append-only and must be instant on a database with
    millions of probe rows.
11. Renewals, WHOIS contacts, email forwarding and dynamic DNS stay out. Do not launch work
    on them.
12. Bugs I report in chat get their own thread right away, outside the workstream table,
    and do not wait for a workstream.
13. Models: Opus for S0, S1, S3 and S5, Sonnet for S2, S4 and S6. Effort as in the table.

**Done when:** S0 to S6 are merged with CI green, Overview and Sites show their shell at
once on my server, `docs/configuration.md` and the README describe the Settings page, and
`TODO-USER.md` lists what I do on my side (the Discord webhook, any compose change, and
running the release workflow for `v1.2.0`).

---
