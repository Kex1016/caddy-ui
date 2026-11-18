# AUTOPILOT

David runs this project on full autopilot. These rules apply to the coordinator and to
every thread. They stay in force until David edits this file.

## What autopilot means here

1. The coordinator launches implementation threads from [PLAN.md](PLAN.md) as soon as
   each workstream's start condition holds. It does not ask David before launching.
2. A thread owns its workstream end to end: branch, implement, test, open the PR, fix CI,
   answer review comments, and merge when the merge rules below are met. It does not
   wait for David.
3. A thread that hits a choice makes the call, writes it to [DECISIONS.md](DECISIONS.md)
   in the same PR, and moves on. It asks David only when the choice cannot be undone or
   changes the goal (for example dropping a feature from PLAN.md). Even then it keeps
   working on its recommended option while waiting.
   Every DECISIONS.md entry made from 18 Nov 2026 on carries a confidence score from 1
   to 100 (`confidence 85`): how sure the thread is that David would make the same call.
   Below 70, the thread also asks David, once, with its recommended option, and keeps
   working on that option while it waits unless the step cannot be undone. At 70 or above
   it does not ask. David asked for this on 18 Nov 2026.
4. Anything David must do himself goes in [TODO-USER.md](TODO-USER.md) with the date,
   the workstream, what to do, and why. Threads never block on those items.
5. No real secrets, hostnames of private services, or credentials are ever committed.
   Examples use placeholders. David's Caddyfile is used as a test fixture only after
   the internal IPs are rewritten to `10.0.0.x` examples that are already public in this
   plan, and the commented-out `X-Idp-Key` line is removed.

## Merge rules

A thread merges its own PR when all of these hold:

- CI is green (lint, typecheck, unit tests, and e2e once W11 exists).
- The PR stays inside its workstream's scope in PLAN.md, or any scope change is logged
  in DECISIONS.md.
- The contracts in PLAN.md §3.2 are unchanged, or the change is logged in DECISIONS.md
  and the coordinator was told in the same turn so dependent threads can adapt.
- The PR description lists what was verified by running it, not only by reading.
- The PR carries the attribution block the project requires.

A thread never force-pushes to a branch it does not own, never rewrites `main`, and
never skips or disables a failing test to get green.

## Models and effort

Use the model and effort in the PLAN.md workstream table. A thread may ask the
coordinator for a stronger model when it is stuck for more than two attempts on the
same problem; it logs that in DECISIONS.md.

## Communication

- David is not involved unless an important design or code decision needs him (rule 3).
- One reply to David when a PR is up, one when it is merged, one when the thread needs
  him. Everything else goes on the thread checklist.
- When a thread finishes, it tells the coordinator which start conditions in PLAN.md are
  now met.
- The coordinator keeps a short status in the project chat: which workstreams are
  running, merged, or blocked, and the open items in TODO-USER.md.

## Stopping

David stops autopilot by editing this file or by saying so in the project chat. Threads
then finish their current PR and wait.
