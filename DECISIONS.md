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
- 2026-11-05 · W0 · Toolchain pinned to SvelteKit 2.70, Svelte 5, Vite 7, TypeScript 5.9, ESLint 9,
  Vitest 3 and adapter-node 5, not the newest majors (Kit 3, Vite 8, TypeScript 7, ESLint 10) · the newer
  majors are weeks old and every workstream builds on this base · bump in one PR once they settle.
- 2026-11-05 · W0 · Sessions are stateless HMAC-signed cookies (`caddy_ui_session`, 7 days, HttpOnly,
  SameSite=Lax) with no database; changing `CADDY_UI_USER` or the secret signs everyone out · W4 owns
  SQLite and W0 should not depend on it · move sessions into SQLite if revocation is ever needed.
- 2026-11-05 · W0 · Local mode with exactly one of `CADDY_UI_USER` / `CADDY_UI_PASSWORD` set fails closed:
  every request is refused and the sign-in page names the missing variable. Both unset means open, with a
  warning banner on every page, as PLAN.md §3.2 says · a half-set config is almost always a typo, and
  guessing would either lock David out or leave the UI open · none.
- 2026-11-05 · W0 · `forward` mode trusts the `Remote-User` header from any client, like tinyauth's other
  services · the UI cannot tell Caddy from another LAN client without extra config; TODO-USER says not to
  publish the port in that mode · add a trusted-proxy list if that ever matters.
- 2026-11-05 · W0 · SvelteKit's own CSRF origin check is replaced by one in `hooks.server.ts` that compares
  the `Origin` host with `Host` / `X-Forwarded-Host` and ignores the scheme; it covers every unsafe method,
  JSON included. Session cookies are `Secure` only when `X-Forwarded-Proto` or `CADDY_UI_PUBLIC_URL` says
  https · adapter-node assumes https without an `ORIGIN`, which broke sign-in on a plain http port such as
  the old `9876` mapping · set `ORIGIN` and turn Kit's check back on if the UI is only ever used via Caddy.
- 2026-11-05 · W0 · `CADDY_UI_PORT` is mapped to adapter-node's `PORT` in `apps/ui/server.js` instead of
  adapter-node's `envPrefix` · `envPrefix: 'CADDY_UI_'` makes the server refuse to start when any other
  `CADDY_UI_*` variable is set · none. adapter-node's own variables (`ORIGIN`, `ADDRESS_HEADER`,
  `XFF_DEPTH`, ...) still work unprefixed.
- 2026-11-05 · W0 · Theme values: dark accent `#5fd3b4` as proposed; light `acc-ink` is `#1a7560` rather
  than `#1f8a70` so links and the focus ring keep 4.5:1 on the light ground (`#1f8a70` is the light chart
  colour). `success` moves from Fishnet's teal to a leaf green (`#9ccf86` dark, ink `#3f6f22` light) so "up"
  never reads as "selected" next to a teal accent. Both are colour-only changes in `theme-caddy.css` · the
  one-accent rule and status contrast · edit `theme-caddy.css`, then `pnpm --filter @caddy-ui/ui gen:theme`.
- 2026-11-05 · W0 · "System" theme is a generated `theme-system.css` (light tokens under
  `prefers-color-scheme: light` for `<html>` without `data-theme`); a unit test fails if it drifts from
  `tokens.css` + `theme-caddy.css`, and another fails if the theme file touches non-colour tokens · Fishnet's
  `tokens.css` only ships dark on `:root` · none.
- 2026-11-05 · W0 · The brand mark is a new one-colour Lucide-style glyph (a page with a padlock) on
  Fishnet's 24px grid; the fish stays Fishnet's · the fish is the Minecraft site's mark, not part of the
  system's rules · replace `Brand.svelte` and `static/favicon.svg`.
- 2026-11-05 · W0 · The image runs as root · the UI must rewrite the bind-mounted Caddyfile, which is
  root-owned on the host, as the zackwag backend did · W9 may add a PUID/PGID switch.
- 2026-11-05 · W0 · A baseline `Dockerfile` lives at the repo root and CI builds it and checks
  `/api/health`; W9 owns it from here (multi-stage tuning, GHCR publishing) · W0's definition includes a
  Dockerfile and the image must exist for W3/W4 to test against · W9 may move it under `deploy/`.
- 2026-11-05 · W0 · Prettier and ESLint run over the whole repo from the root (`pnpm lint`); Markdown is not
  prettier-formatted, and the two Fishnet files ported verbatim (`tokens.css`, `fishnet.css`) are excluded
  so a design-system update diffs cleanly · plan and docs threads own their prose layout · none.
- 2026-11-05 · W0 · Failed sign-ins are limited to 10 per 15 minutes per client address. Behind Caddy all
  clients share Caddy's address unless adapter-node's `ADDRESS_HEADER=x-forwarded-for` is set · acceptable
  for a single-admin UI · documented for W10.
- 2026-11-05 · W3 · One shared SQLite module, `apps/ui/src/lib/server/db` (`openDb`, `getDb`, `migrate`), with an
  append-only `migrations` array tracked by `PRAGMA user_version`; W3 owns migration 1 (`revisions`, `settings`,
  columns exactly as PLAN.md §3.2), W4 appends its tables as migration 2. Agreed with W4 before either merged ·
  two threads were about to write two database modules · none.
- 2026-11-05 · W3 · The Caddyfile parser (W1) and schema (W2) plug into the config service through
  `$lib/server/config/parser.ts` (`setParser({ parse, format })`). Until W1 merges, `GET /api/caddyfile` returns
  `cst: null` and `parser: "unavailable"`, every apply is still validated by Caddy's `/adapt`, and
  `POST /api/caddyfile/format` answers 501 · W3 started before W1 and must not block on it · whoever merges after
  W1 (W1 itself, W5 or W6) calls `setParser` in `hooks.server.ts`.
- 2026-11-05 · W3 · Parser errors block an apply just like `/adapt` errors · a file the parser cannot read would
  break the visual editor's round trip even if Caddy accepts it · drop the parser check in `ConfigService.validate`.
- 2026-11-05 · W3 · Applying is a no-op (no write, no backup, no `/load`, no revision) when the text equals the file
  and its adapted JSON equals Caddy's running config, compared with object keys sorted. A comment-only edit is
  written and recorded but does not reload Caddy · PLAN.md §5.1: applying the file unchanged must change nothing ·
  none.
- 2026-11-05 · W3 · The Caddyfile is rewritten in place (truncate and write the same inode), never written to a temp
  file and renamed. If `/load` fails after the write, the old text is written back · the file is normally a
  single-file bind mount; a rename fails with EBUSY or detaches the file from the Caddy container · none.
- 2026-11-05 · W3 · Before each write the old file is copied to `$CADDY_UI_DATA/backups/Caddyfile-<UTC stamp>.bak`
  (mode 600, newest 50 kept); SQLite keeps the newest 200 revisions · backups survive a lost or corrupt database ·
  change `keepBackups` / `keepRevisions` in `ConfigService`.
- 2026-11-05 · W3 · Outside edits are found by polling the file's stat every 2 s (`fs.watchFile`), not inotify.
  Each one is stored as a revision by "outside the UI" and flagged as `externalChange`; it is never applied to
  Caddy automatically. `PUT /api/caddyfile` takes an optional `baseHash` (the `hash` from `GET`) and answers 409
  when the file changed since, which is how the editors "ask before overwriting" · inotify does not cross bind
  mounts reliably; applying someone's half-finished hand edit could take sites down · none.
- 2026-11-05 · W3 · Additions to the §3.2 API (nothing removed or renamed): `GET /api/caddyfile/revisions/:id`
  returns one revision with its text; response shapes for all W3 routes are typed in `$lib/api/config.ts`; error
  bodies are `{ message, code, diagnostics }` with 400/409/422 (invalid)/502 (Caddy refused the load)/503 (admin
  unreachable) · the History page and the editors need the text and a stable error shape · none.
- 2026-11-05 · W3 · `GET /api/caddy/status` reads Caddy's start time and last reload from its own `/metrics`;
  `version` is filled only if Caddy exports a `*_build_info` metric with a `version` label, and is otherwise null ·
  the admin API has no version endpoint · W4's scraper may fill it another way.
- 2026-11-05 · W3 · The History page (revision list, diff against the previous revision or the file on disk,
  restore) ships with W3 · rollback is in W3's definition of done and no other workstream owns that page · none.
- 2026-11-05 · W3 · CI gains a "Config service against a real Caddy" job: it runs `caddy:2.10` with only its admin
  API exposed and runs `pnpm --filter @caddy-ui/ui test:caddy` (the §5.1 W3 checks) against it, using
  `src/lib/server/config/fixtures/sample.Caddyfile`, a file shaped like David's with `.localhost` hosts · there is
  no sanitised copy of David's file yet; W1's fixture can replace it · none.
- 2026-11-05 · W9 · UI `Dockerfile` stays at the repo root (CI and the updater's git source
  build it there); W9 only adds OCI labels and the `CADDY_UI_VERSION` build arg · moving it
  would break W0's CI for no gain · move it and update `publish.yml`, `ci.yml`.
- 2026-11-05 · W9 · `publish.yml` pushes `caddy-ui` and `caddy-ui-updater` for
  linux/amd64 and linux/arm64 with the GITHUB_TOKEN · one workflow, same tags for both ·
  drop arm64 from the `platforms` line if builds get slow.
- 2026-11-05 · W9 · PUID/PGID switch not added · the root default matches the old backend
  and works with root-owned bind mounts; revisit if David asks · none.
- 2026-11-05 · W2 · The schema is generated from a pinned commit of `caddyserver/website`
  (`packages/caddy-schema/docs-source.json`) and the output `src/generated/schema.json` is committed. Tests fetch
  the pinned docs at test time; a weekly workflow (`caddy-docs-drift.yml`) checks coverage against the docs'
  `master` · PR CI stays reproducible while new Caddy directives still surface within a week · move the pin
  with `CADDY_DOCS_REF=master pnpm --filter @caddy-ui/caddy-schema generate -- --pin`.
- 2026-11-05 · W2 · Additive extensions to the §3.2 schema contract, all optional: on `DirectiveSchema`
  `syntax`, `forms`, `variants` (module picked by the first argument: `transport http`, `lb_policy cookie`,
  `issuer acme`, `uri strip_prefix` …), `freeformBody`, `rows`, `allowsResponseMatchers`, `onlyIn`,
  `experimental`, `block`; on `ArgSchema` `literals` and `prefixes`; on `MatcherSchema` `summary`, `syntax`,
  `examples`, `merges`, `subdirectives`, `forms`. `category` gains `'global'` (the contract already implied it
  for global options) and `order` is `-1` for directives outside Caddy's handler order · W5 needs module
  variants and free-form rows to build forms for `reverse_proxy`, `tls`, `log` and `header`; nothing in the
  contract changed shape · drop the extension fields; consumers of the contract fields are unaffected.
- 2026-11-05 · W2 · Matchers: the schema has the 17 standard request matchers in `matchers.md` plus the three
  token forms (`*`, `/path`, `@name`) in `matcherTokenForms` and the two response matchers; PLAN.md's "19" was
  a miscount · the docs are the source of truth · none.
- 2026-11-05 · W2 · Schema validation (`validateBlocks`, `validateSiteBody`, …) lives in `caddy-schema` and
  takes a minimal `{ name, args, body, line }` node shape instead of W1's CST, so W2 does not depend on W1; W5
  and W6 map CST nodes onto it in a few lines. Unknown directives and global options are warnings (plugins);
  values containing placeholders or `{$ENV}` always pass · `/adapt` stays the final word, this is the instant
  in-editor check · move it into the editor packages if it grows editor-specific.
- 2026-11-05 · W2 · `php_fastcgi` and `forward_auth` accept every `reverse_proxy` subdirective (both are
  `reverse_proxy` with presets; the docs examples use `header_up` inside `forward_auth`) · otherwise valid
  configs would be flagged · none.
- 2026-11-05 · W2 · The W2 test fixture of David's Caddyfile anonymises hostnames too (`*.example.com`,
  `example.net`, …), not only the secret line, and replaces the email and the personal path segment ·
  AUTOPILOT forbids private hostnames beyond PLAN.md; IPs stay `10.0.0.x` as planned · W1 owns the
  round-trip fixture and can make its own call.
- 2026-11-05 · W2 · `src/generated/` is excluded from prettier · the generator owns its formatting so the
  "re-run produces no diff" check is byte-exact · none.
