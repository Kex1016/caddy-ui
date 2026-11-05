# DECISIONS

Choices made on David's behalf. Threads append here in the PR that makes the choice.
Format: date · workstream · decision · why · how to reverse.

- 2026-11-05 · Plan · One SvelteKit (Node adapter) app is both UI and API, in one
  container · Fishnet is a Svelte design system built from a SvelteKit site, so
  components port directly; one process means one compose service replaces two · reverse
  by splitting `apps/ui/src/lib/server` into its own service behind the same `/api`
  contract.
- 2026-11-05 · Plan · TypeScript Caddyfile parser with a byte-exact printer, instead of
  round-tripping through Caddy JSON · Caddy's `/adapt` loses comments, formatting and
  snippets, which the visual editor must preserve · none needed; `/adapt` is still used
  for validation.
- 2026-11-05 · Plan · SQLite (`better-sqlite3`) for history and stats · one file in the
  existing `./caddy-ui` volume, no extra service, fast enough for one Caddy instance ·
  the data layer is behind a small repository interface so Postgres could replace it.
- 2026-11-05 · Plan · Stats come from Caddy's admin API, `/metrics`, the JSON access log,
  certificate files and the UI's own probes; nothing is installed in the Caddy container ·
  David asked for "as much as we can get out of just a caddy frontend" · a Docker socket
  mount is an opt-in extra (TODO-USER).
- 2026-11-05 · Plan · Visual editor shape recommended as tree + inspector with recipes
  and a Visual | Text mode switch · see docs/visual-editor-options.md · David's answers
  override this before W5 starts.
- 2026-11-05 · Plan · "Disable a site" comments the block out rather than deleting it ·
  reversible, visible in the file, needs no extra files · open question 5 in the editor
  doc can change it.
- 2026-11-05 · Plan · Keep `CADDY_UI_USER` and `CADDY_UI_PASSWORD` env names from the
  zackwag backend; drop `JWT_SECRET` for `CADDY_UI_SESSION_SECRET`; UI listens on
  `CADDY_UI_PORT` (default 3001 so the existing `9876:3001` mapping keeps working) · the
  compose swap should be a delete and a rename, not a rewrite · none.
- 2026-11-05 · Plan · Updater is a separate small sidecar (`deploy/updater`) that runs
  `docker compose pull && up -d caddy-ui` on an interval or webhook, not code inside the
  UI container · a container cannot safely replace itself; the sidecar is the standard
  pattern (same idea as Watchtower, scoped to one service) · run Watchtower instead.
- 2026-11-05 · Plan · Image published to `ghcr.io/kex1016/caddy-ui` by GitHub Actions on
  push to `main` (tag `edge`) and on version tags (`vX.Y.Z`, `latest`) · the updater
  needs somewhere to pull from and the repo already lives on GitHub · Docker Hub or a
  git-based build (`CADDY_UI_UPDATE_SOURCE=git`) are supported alternatives.
- 2026-11-05 · Plan · Accent colour proposed as teal-green, fonts unchanged · the one
  allowed deviation from Fishnet; teal reads as "Caddy" and keeps the one-accent rule ·
  David can veto in TODO-USER.
- 2026-11-05 · Plan · Fixture copy of David's Caddyfile keeps the `10.0.0.x` addresses
  (already in this plan) but drops the commented `X-Idp-Key` line and any secret-looking
  value · a realistic fixture matters for round-trip tests; secrets never enter the repo ·
  none.
- 2026-11-05 · Plan · Visual editor shape is B, tree outline + inspector, with recipes
  (E) for adding sites · David chose it on the decision card in the planning thread ·
  David can change it in the thread before W5 starts; after that it is a rewrite.
- 2026-11-05 · W9 · Updater is bash + socat in an Alpine `docker:cli` image
  (`deploy/updater`), not Node · it only shells out to `docker compose`, so a shell script
  is the smallest thing that works and is testable with a fake `docker` · rewrite in Go
  or Node if it grows.
- 2026-11-05 · W9 · New env names beyond PLAN §3.2: `CADDY_UI_UPDATE_WEBHOOK_SECRET`,
  `CADDY_UI_UPDATE_SERVICE`, `CADDY_UI_UPDATE_HEALTH_TIMEOUT`, `CADDY_UI_UPDATE_GIT_URL`,
  `CADDY_UI_UPDATE_GIT_BRANCH`, `CADDY_UI_UPDATE_GIT_DIR`, and compose-only
  `CADDY_UI_COMPOSE_DIR`, `CADDY_UI_TAG`, `CADDY_UI_HOST_PORT` · needed for webhook
  auth, rollback and the git source; the contract names are unchanged · remove the extras.
- 2026-11-05 · W9 · Updater rolls back automatically: if the container is not healthy
  within 90s it retags the previous image and recreates the service · a bad release
  should not take the proxy UI down unattended · set a huge timeout to effectively
  disable.
- 2026-11-05 · W9 · Minimum update interval is 30s · stops a typo from hammering GHCR ·
  edit `updater.sh`.
- 2026-11-05 · W10 · Documentation drafts are written from PLAN.md and marked `Draft` at
  the top of each page, with `(draft)` on unconfirmed details · the code does not exist
  yet, so claims must not look final · the final W10 pass removes the markers after
  W5–W9 land.
- 2026-11-05 · W10 · Docs file set follows the PLAN.md W10 row exactly, plus the two
  existing companion docs; the migration page keeps the planned name
  `migration-from-caddy-ui.md` · matches the plan's contract · rename and fix links.
