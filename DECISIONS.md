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
- 2026-11-05 · W1 · `packages/caddyfile` keeps every byte of the source on the tree itself
  (token `raw`, inter-token `leading` whitespace, per-line `layout` with indent, trailing
  comment, newline and brace style, `trivia` for comment and blank lines) instead of
  slicing the original string by span · the tree can be edited and re-printed without
  carrying the source around, and the fuzz test can assert `print(parse(x)) === x` for
  arbitrary strings, invalid ones included · none needed; spans are still present on every
  parsed node and token for editor highlighting.
- 2026-11-05 · W1 · Additions to the §3.2 CST contract (all additive): `Block` gains
  `{ kind: 'import' }` for a top-level `import` line and `{ kind: 'raw' }` for a top-level
  line the parser cannot classify (always with a diagnostic); `SiteBlock.braces` is false
  for the single-site form without braces; `MatcherDef.inline` is a `Directive` that may
  carry a `body` (`@name file { try_files … }`) and whose `name` is the quoted CEL token for
  the `@name \`expr\`` shorthand; `Token.raw`, `Token.span` and `Node.span` are optional so
  that synthesised nodes need only `text`; `Layout.unclosed` marks a block the source never
  closed · the Caddy docs contain all of these forms and the plan's union had no place for
  them; making spans optional lets W5/W8 build nodes with plain values · the coordinator was
  told in the same turn; W5, W6 and W8 read the types from the package.
- 2026-11-05 · W1 · Matcher detection for `/path` and `*` second tokens uses a built-in
  table of the standard directives that take `[<matcher>]`, applied only inside bodies that
  hold directives (site, snippet, named route, `handle`, `route`, `handle_errors`,
  `handle_path`, `handle_response`); `@name` is always a matcher reference; `root` with one
  argument treats `/srv` as the path (Caddy ≥ 2.8). `parse()` accepts `matcherDirectives`
  and `containerDirectives` options so W5/W6 can pass the schema's complete set · the parser
  must work without the schema and must not misread plugin directives · pass different sets.
- 2026-11-05 · W1 · `format()` is "caddy fmt style" produced by the package's own printer
  (tabs, one space between tokens, trailing whitespace trimmed, at most one blank line,
  final newline), not a port of Caddy's formatter · Caddy's formatter is character-based
  and has quirks nobody relies on; the UI only needs a tidy, idempotent output · W3 may
  offer `caddy fmt` through the admin API later if exact parity is wanted.
- 2026-11-05 · W1 · Docs fixtures are the 520 ```caddy and ```caddy-d code blocks from
  caddyserver/website on 5 Nov 2026, committed under `packages/caddyfile/fixtures/docs/`
  with a manifest, regenerated by `pnpm --filter @caddy-ui/caddyfile fixtures:docs` · the
  test must not depend on the network · re-run the script when the docs change.
- 2026-11-05 · W1 · The anonymised copy of David's Caddyfile is the one W2 committed at
  `packages/caddy-schema/test/fixtures/sample-home.Caddyfile`; W1's tests read it from
  there rather than keeping a second copy · one fixture to keep in sync · move it to a
  shared `fixtures/` folder if a third package needs it.
- 2026-11-05 · W1 · The UI installs the parser at boot: `hooks.server.ts` calls
  `installCaddyfileParser()` (`$lib/server/config/caddyfile-parser.ts`), which maps W1
  diagnostics (offset spans) to W3's line/column `Diagnostic` and passes `format()` through,
  so `GET /api/caddyfile` returns the CST and `/api/caddyfile/format` works · W3 left this
  seam (`setParser`) for W1 to fill · `setParser(null)` restores the parser-less behaviour.
- 2026-11-05 · W4 · W3 and W4 share one SQLite module (`apps/ui/src/lib/server/db`, migrations tracked with
  `PRAGMA user_version`); W3 owns migration 1 (`revisions`, `settings`), W4 appends migration 2 · one file, one
  migration history · none.
- 2026-11-05 · W4 · Additive changes to the §3.2 tables: a new `sites(id, addresses_json, first_seen, last_seen,
  removed_at)` table, and `state_changes` gains `target` (`''` is the site itself, otherwise an upstream
  address) · "a down upstream shows as down" needs a per-upstream "since", and stats for a removed site still
  need its addresses · drop the column and table in a later migration if unused. Existing columns unchanged.
- 2026-11-05 · W4 · Until `packages/caddyfile` (W1) merges, the collector finds site blocks and upstreams with
  a small scanner in `collector/sites.ts` (comments, quotes, heredocs, snippets and `import` handled) · W4
  must not wait for W1 · swap `scanCaddyfile` for the W1 CST with the same output once it lands.
- 2026-11-05 · W4 · Site id is the first 16 hex chars of SHA-256 over the address list lower-cased, trimmed and
  sorted · §3.2 says "hash of its address list"; sorting means reordering addresses keeps history · none
  without losing history.
- 2026-11-05 · W4 · Sites are probed through Caddy itself: the request goes to the host of
  `CADDY_ADMIN_URL` (`caddy` in compose) with the site's name as Host and SNI, not to the public DNS name ·
  works inside the compose network without hairpin NAT and checks Caddy plus the backend · probe the public
  URL instead if checking DNS and the router matters.
- 2026-11-05 · W4 · A site probe counts as up for any answer except 502, 503 and 504; same-host redirects are
  followed (up to 5), a redirect to another host (a tinyauth sign-in page) counts as up. Certificates are not
  verified by the probe (expiry comes from the cert reader). A failed probe is retried once after 1s before it
  counts · behind forward_auth a 302 is the healthy answer · edit `statusIsUp` in `collector/probe.ts`.
- 2026-11-05 · W4 · A site without a probeable address (only wildcards or placeholders) is judged by its
  upstreams: down only if all are down. Loopback upstreams (`localhost:3000`) are probed on Caddy's host ·
  they are local to Caddy, not to the UI container · none.
- 2026-11-05 · W4 · `forward_auth` and `php_fastcgi` targets count as upstreams alongside `reverse_proxy` · if
  tinyauth is down every site behind it is effectively down, and that should be visible · filter by `via`.
- 2026-11-05 · W4 · `metric_samples` holds per-minute values derived from `/metrics` (`requests`, `errors_4xx`,
  `errors_5xx`, `bytes_out`, `latency_p50_ms`, `latency_p95_ms`, `in_flight` per `{"site":id}` and `{"site":"*"}`,
  plus process gauges), not raw scrapes. Idle sites write no rows; the server row is always written so a gap
  means no scrape. Per (server, host) only the handler with most requests is counted, because Caddy counts a
  request once per handler · raw scrapes of ~35 hosts' histograms would be millions of rows a day · store raw
  series in a new table if PromQL-style queries are ever needed.
- 2026-11-05 · W4 · Retention (`CADDY_UI_RETENTION_DAYS`) prunes `probes` and `metric_samples` hourly;
  `log_minutes`, `state_changes`, `sites` and `certs` are kept · PLAN.md keeps minute rollups forever and
  state history is small · downsample `metric_samples` into hours if 90 days of metrics is too short.
- 2026-11-05 · W4 · When the access log has data in the requested window, traffic series come from it (exact);
  otherwise from metrics. Every series and tile carries its `source` so pages can name it · the log is exact,
  metrics are approximate · none.
- 2026-11-05 · W4 · Latency across a chart bucket is the request-weighted mean of per-minute p50/p95, which is
  an approximation of the true percentile · storing per-minute histograms costs much more · document in
  docs/stats.md.
- 2026-11-05 · W4 · The log tailer starts at the end of a log that already exists when the UI first sees it and
  stores its position in `settings` (`collector.log_position`), so restarts neither replay nor skip lines; a
  log that appears later, or is rotated, is read from the top · none.
- 2026-11-05 · W4 · The Dockerfile build stage installs `python3 make g++` so better-sqlite3 can compile when
  no prebuilt musl binary is available · W9 may drop it if prebuilt binaries are always used.
- 2026-11-05 · W4 · CI gains a `collector` job that runs `caddy:2` and the image in one Docker network with
  `deploy/ci/Caddyfile.collector` (metrics `per_host`, JSON access log) and checks the overview, sites and
  stats APIs · the definition of done is about a real Caddy, which only CI has · none.
- 2026-11-05 · W8 · Block edits (add, duplicate, delete, disable, reorder) are text splices in
  `apps/ui/src/lib/server/sites/blocks.ts`, built on a small brace/quote/heredoc scanner like W4's, not on W1's
  CST · W1 has not merged and W8 must not wait for it; the splices leave every byte outside the block alone, and
  after each edit the set of site ids is checked against what the edit should produce · when W1 merges,
  reimplement `scanBlocks` on its CST with the same `Block` output; the tests stay.
- 2026-11-05 · W8 · Disable comments the block out under a marker line, `# caddy-ui:disabled lines=N`, then N
  lines each prefixed `# `; enable strips exactly that. Caddy and the W4 scanner see a comment, and enable
  restores the original bytes, including blank lines, heredocs and CRLF · a block cannot be "disabled" any
  other way in a Caddyfile · a hand-edited marker whose count no longer matches is treated as a plain comment.
- 2026-11-05 · W8 · A block carries the comment lines directly above it (no blank line between) when it is
  deleted, disabled or moved. Duplicate copies the block but not those comments · a "# Jellyfin" note above a
  site is almost always about that site · a comment separated by a blank line is left where it is.
- 2026-11-05 · W8 · Reorder swaps a site with its neighbour in the site list; snippets, the global block and
  all text between blocks stay in place. It is off while a search or status filter is active · Caddy does not
  care about site order, so this is only for the person reading the file · none.
- 2026-11-05 · W8 · The Sites page has its own starters (blank, reverse proxy, static files, redirect) for "Add
  site", because W5's recipe picker does not exist yet · W5 should replace the starter select with its recipe
  picker, keeping the `add` form action · the list's edit link is `/editor?site=<id>&line=<line>`, which W5/W6
  should honour; the Globals and Snippets cards link to `/globals` and `/globals#snippets`.
- 2026-11-05 · W8 · Edits are `POST /sites?/add|duplicate|delete|toggle|move` form actions, not new `/api`
  routes, so the §3.2 contracts are unchanged. Each reads the file, edits it, and calls the config service's
  `apply` with the `baseHash` the page was loaded with, so an edit made elsewhere gives the service's 409
  instead of being overwritten · the page then tells the person to reload.
- 2026-11-05 · W8 · Brace-less single-site Caddyfiles (a site without `{ }`) are not editable from the list;
  the page says so and the Editor remains · they cannot be moved or duplicated safely without a real parser ·
  lift once W1 is wired in.
- 2026-11-05 · W8 · Added `Dialog` (native `<dialog>`) to `$lib/design/components` · Fishnet's ported set had no
  modal and three flows need one · W5 can reuse it.
- 2026-11-05 · W1 · The collector's stand-in Caddyfile scanner
  (`apps/ui/src/lib/server/collector/sites.ts`) now runs on the parser's CST; its output
  (`scanCaddyfile`, `siteId`) is unchanged and its tests still pass · one parser in the
  codebase · the persisted site id stays W4's sha256 of the comma-joined normalised address
  list; `packages/caddyfile` exports that key as `siteKey()` and no hash of its own.
- 2026-11-05 · W7 · Chart components live in `apps/ui/src/lib/design/charts` (LineChart, Sparkline, UptimeStrip,
  StripPlot, BarList, DataTable, ChartCard, RangeSwitch, ViewSwitch), written from Fishnet's chart previews and
  `index.d.ts` because the Fishnet Svelte sources are not in this repo · same markup and `fp-plot` classes W0
  ported · swap for the Fishnet components if they are ever vendored.
- 2026-11-05 · W7 · All time-series charts are LineCharts (no ColumnChart): 24h has 288 buckets, too many for
  columns at Fishnet's widths. Errors draw 5xx with 4xx as the shadow series; latency draws p95 with p50 as the
  shadow · one hue per chart, per Fishnet · add ColumnChart for daily totals if a page needs them.
- 2026-11-05 · W7 · Stats pages read the collector in-process in `+page.server.ts` (same functions as
  `/api/overview`, `/api/sites`, `/api/sites/:id/stats`) and re-run every 30 s while the tab is visible
  (`invalidate('app:stats')`). The range is `?range=` (default 24h) and the one Charts | Tables switch is
  `?view=tables` · server-rendered SVG, no client fetch layer · none.
- 2026-11-05 · W7 · A chart is "stale" when its source is failing now (metrics or log error, probes more than three
  intervals late); its as-of time becomes the source's last good time with "last good data". Fewer than two known
  points shows the frame with an EmptyState that names the fix (`metrics { per_host }`, a `log` directive,
  `CADDY_DATA_PATH`) · Fishnet's empty and stale rules · none.
- 2026-11-05 · W7 · The per-site page is `/sites/[id]` (W8 owns the `/sites` index). Its "open in the editor"
  link is `/editor?site=<id>`; W5/W6 can honour `site` to open that block · none.
- 2026-11-05 · W7 (fix in W3/W4 code) · Calls to Caddy's admin API now go through `adminFetch`
  (`lib/server/caddy/admin-fetch.ts`, node:http) instead of Node's fetch, in the W3 admin client and the W4 metrics
  scrape and upstream lookup. Node's fetch always sends `Sec-Fetch-Mode: cors`, and Caddy 2.11 (`caddy:latest`)
  then enforces the admin origin list and answers 403, so metrics, upstream counts and apply all failed against
  2.11; CI pinned 2.10 for W3 and the W4 check only looked at log data · the collector CI check now also fails when
  `/metrics` cannot be read · none needed; the test fakes 2.11's rule.
- 2026-11-05 · W8 · W1 merged while this PR was open. `scanBlocks` stays text-based for now (it is covered by 31
  tests, including the fixture's every-site disable/enable round trip) · moving it onto `packages/caddyfile`
  is a follow-up that changes no behaviour · whoever wires W1 into the editor can swap it and keep the tests.
- 2026-11-05 · W6 · The CodeMirror language is a stream tokenizer (`apps/ui/src/lib/editor/language.ts`)
  rather than a Lezer grammar. It follows Caddy's lexer rules and is tested against W1's `lex()` on all 520
  docs fixtures, the package fixtures and David's anonymised Caddyfile: every token boundary, brace, quote,
  heredoc and comment agrees · a second grammar would be a second parser to keep in sync, and the stream
  tokenizer is incremental · write a Lezer grammar if the visual editor ever needs a syntax tree in the browser.
- 2026-11-05 · W6 · Lint runs W1's `parse()` and W2's `validateBlocks()` in the browser 150 ms after the last
  keystroke (measured 191 ms from keystroke to underline in Chromium, inside the 300 ms budget). Caddy's
  `/adapt` runs only on "Check with Caddy" and on apply, never per keystroke · `/adapt` is a network round
  trip to Caddy · none.
- 2026-11-05 · W6 · Schema findings are warnings at most on the server (`GET /api/caddyfile`,
  `PUT`/`validate` diagnostics, source `schema`), so only the parser and Caddy's `/adapt` can refuse an apply;
  the editor shows them with the schema's own severity · the schema is generated from docs and may lag Caddy
  or miss a plugin · make them blocking if the schema proves exact.
- 2026-11-05 · W6 · `GET /api/schema` (in the §3.2 table, no owner) is served by W6 with an ETag of
  `schemaVersion` and a one-hour private cache. The browser fetches it once and imports only
  `@caddy-ui/caddy-schema/validate` and `/types`, two new additive subpath exports of the schema package ·
  keeps the 480 KB bundle out of the JS chunks · none. `apps/ui/tsconfig.json` gains
  `allowImportingTsExtensions` because the schema package's sources import with `.ts` extensions.
- 2026-11-05 · W6 · Editor page behaviour: "Review and apply" (also Ctrl+S) shows a line diff against the
  file as loaded and applies with `baseHash`; on a 409 the page offers "compare my edits with the file on
  disk now" (new base, edits kept, diff shown again) or "drop my edits and load it". Unapplied edits are kept
  in the browser's localStorage, tied to the base hash, and restored on the next visit · losing a long edit
  to a closed tab is the worst outcome · none.
- 2026-11-05 · W6 · Syntax colours use only Fishnet tokens (directives `acc-ink`, matchers `warning-ink`,
  placeholders and env vars `success-ink`, addresses bold `text`, comments `faint`) · PLAN.md §6 allows only
  colour and font tokens · change the classes in `TextEditor.svelte`.
- 2026-11-05 · W6 · `/editor?at=<address>` scrolls to the site block with that address, `/editor?line=N`
  (the sites list's link, which also sends `site=<id>`) scrolls to that line, and a "Jump to block"
  list covers sites, global options, snippets and named routes. Whole-file editing only; per-block text
  editing is left to W5's inspector · W8 can link a site to its text with `?at=` · none.
- 2026-11-06 · Plan · Text editing is a Visual | Text mode switch, with an optional
  side-by-side split toggle · David chose it on the decision card in the planning
  thread · a layout change in W5.
- 2026-11-06 · Plan · Saving normalises the Caddyfile to `caddy fmt` style on every save;
  comments are kept, indentation and spacing are rewritten · David chose it on the
  decision card, over the byte-exact recommendation · W1 keeps the byte-exact printer
  for in-editor round trips and diffs; W3 runs `format()` before writing. Reversible by
  a setting if David changes his mind.
- 2026-11-06 · Plan · The first release ships bespoke forms for all 41 directives, not
  only the ones David uses · David chose it on the decision card · W5 is split: W5a
  (Fable) builds the editor core, the matcher builder and the 12 directives in David's
  Caddyfile; W5b (Opus, parallel, starts when W5a's form API lands) builds the other
  29 bespoke forms in batches by category. Generic schema forms remain as the fallback
  for plugin directives.
- 2026-11-06 · Plan · "Disable a site" comments the block out · David confirmed the
  recommendation on the decision card · none needed.
- 2026-11-06 · W3 · Format on save, following David's choice above. `ConfigService.apply` (and therefore restore)
  validates the text as sent, so error lines match the editor, then writes `format()` of it. The formatted text is
  adapted again and must give exactly the same JSON config. If it does not, or if the formatter throws, the text is
  saved as sent with a warning. A save that only changes layout is written but does not reload Caddy.
  `ApplyResult` gains `text` (what is on disk now) and `formatted`, and the text editor takes `text` as its new
  base · a formatter bug must never change what Caddy runs · switch it off with the `formatOnSave: false` option
  in `lib/server/config/index.ts`.
- 2026-11-06 · W5a · The visual editor treats the text as the document: every edit mutates W1's syntax tree,
  prints it and parses the result again, so spans stay fresh and the outline always shows exactly what the text
  says. Nodes are addressed by path (`block:index.index`), not by object identity, so a selection survives the
  re-parse · one source of truth keeps Visual, Text and Split modes in step without a second model · W5b and
  W11 can rely on `print(parse(text)) === text` for every edit that changes nothing.
- 2026-11-06 · W5a · The inspector form API is declarative: a form is a list of fields, each with `get`/`set`
  over the directive node (`lib/visual/forms/types.ts`), built with helpers (`arg`, `subText`, `flag`,
  `subList`, `rows`, `group`, `variant`, `section`). Bespoke forms register by name; the schema-generated form
  is the fallback and raw text the last resort. A form is testable without a DOM by reading every field and
  writing the value back · W5b writes 29 forms against this API in parallel · adding a field kind means one
  type, one helper and one input component.
- 2026-11-06 · W5a · Recipes (`lib/visual/recipes.ts`) replace W8's Add-site starters. The same pure function
  renders the block for the Sites page (server side, form post) and for the editor's Add block dialog, so
  the two never drift. The recipes are the shapes in David's Caddyfile: reverse proxy, redirect, static, PHP,
  protected by tinyauth (inline or via a snippet), proxy with a custom error page, snippet, blank · one list
  to extend · `starterBlock` and `STARTERS` are gone from `lib/server/sites/blocks.ts`.
- 2026-11-06 · W5a · The Globals page is the visual editor scoped to the non-site blocks (global options,
  snippets, named routes); its text mode shows the whole file. The editor and Globals share one workbench
  component with the Visual | Text switch, an optional Split view, review, apply, drafts and conflict handling ·
  one place to fix save and conflict behaviour · `?mode=text` opens text mode; `?site=`, `?at=`, `?line=` and
  `?block=global|snippets` select the matching node.
- 2026-11-06 · W5a · The review diff compares the file on disk with the formatted text (what the save will
  write), not with the text as typed. The first save of a hand-indented file therefore shows the whole file
  re-indented; the panel says why · the diff must show what lands on disk · none needed.
- 2026-11-06 · W5a · Placeholder suggestions for regexp captures use the matcher's name when the regexp has
  none (`@user path_regexp …` offers `{re.user.1}`), as Caddy ≥ 2.8 does; `{re.1}` is offered too for older
  servers · David's Caddyfile relies on this form · the catalogue entries stay for files without captures.
- 2026-11-06 · W5b · Every directive and matcher module in the schema now has a bespoke form: the 29 directives
  W5a left (one file per category under `lib/visual/forms/directives/`: `logging`, `headers`, `responses`,
  `static`, `tls`) and the 13 matcher modules (`forms/matchers/more.ts`). The schema has 17 matcher modules;
  with the matcher slot's named, path-token and wildcard forms that covers the 19+ matcher forms PLAN.md
  counts. A test fails if the schema gains a directive or matcher without a bespoke form · PLAN.md §5.1 W5b ·
  the generic schema form stays as the fallback for plugin directives.
- 2026-11-06 · W5b · Two additive form API extensions (not §3.2 contracts): `RowsField.columnsFor(node)` for
  columns that depend on the node (`map` has one output column per destination), and
  `FormSpec.claimsAllLines` for forms whose rows field models every body line (`header`, `map`, `vars`,
  `basic_auth`, `push`, and W5a's `uri query { … }`), so those lines are no longer listed twice under "Other
  lines". Shared helpers for W5b's shapes live in `forms/directives/helpers.ts` (`subArg`, `subArgList`,
  `lineRows`, `optionalNameFields`) · the existing helpers could not edit one argument of a multi-argument
  line or rows that exclude some names · none.
- 2026-11-06 · W5b · Rows fields write a row to the file only once every required column has a value; until
  then the row lives in the inspector. "Add" used to write a line with no arguments (`header_up` alone, which
  Caddy rejects) or nothing at all for free-form bodies, and clearing a cell to retype it deleted the line and
  the comment above it. The rows grid also sizes to its real column count · applies to W5a's rows too ·
  `components/fields/RowsInput.svelte`.
- 2026-11-06 · W5b · Modelling choices: `respond` and `error` read a lone three-digit argument as the status
  and anything else as the body or message, as Caddy does; `tls` shows one "Certificate" choice (automatic,
  with an email, internal CA, files, force_automate) derived from its arguments; setting a gzip or zstd level
  moves that format from the `encode` line into its block, where a level can go; `php_fastcgi` reuses the
  `reverse_proxy` sections except Transport, which php_fastcgi sets itself; `query` matcher pairs are
  key/value rows and `query ""` is a toggle; `log_append`'s `<` prefix is a toggle · each mirrors the
  directive's syntax without making the user learn it · change the form file of that category.
- 2026-11-06 · W10 · Final docs pass: removed every draft marker, wrote docs from the code and the
  W0–W8 DECISIONS entries instead of the plan. Two corrections to the drafts: the Settings page has
  no "enable metrics / access log" helpers yet (it is a placeholder), so the docs show the Caddyfile
  snippets to add by hand or in the editor; the UI does not use the Docker socket at all, only the
  updater sidecar does · docs must match what ships · if the helpers are built later, update
  docs/install.md, docs/stats.md and docs/faq.md.
- 2026-11-06 · W10 · The compose swap in TODO-USER.md pins `caddy-ui:1.0.0` rather than `latest` and
  leaves the updater optional · a pinned tag makes the first swap reproducible, and the updater
  needs root-equivalent socket access · switch the tag to `latest` for rolling updates.
- 2026-11-06 · W11 · The e2e suite (`e2e/`, Playwright + Chromium) runs the built UI as a Node process against a
  real Caddy: in CI the official `caddy` image started with `docker run`, matrixed over `caddy:2.10` and `caddy:2`
  (latest); locally a `caddy` binary from `CADDY_BIN`. The image itself is covered by the existing image and
  collector jobs and the new install job · one stack script for CI and laptops, and a failing test points at UI
  code rather than container plumbing · none.
- 2026-11-06 · W11 · The W3 "Config service against a real Caddy" job is now matrixed over `caddy:2.10` and
  `caddy:2` as well, since David runs `caddy:latest` (2.11+) · the note from W3/W7 that CI only pinned 2.10 · none.
- 2026-11-06 · W11 (fix in W1 code) · `format()` now matches `caddy fmt` byte for byte on every docs example and
  David's file, checked against a real binary (`test/caddy-differential.test.ts`, CI job "Formatter against caddy
  fmt"). Three differences fixed: blank lines right after `{` and right before `}` are dropped, and comments keep
  their trailing spaces (caddy fmt does not trim comments). W1's and W3's tests that expected trimmed comments now
  put the trailing spaces after a directive instead. Known differences left on purpose, listed in the test:
  `\` line continuations (format() joins them, caddy fmt keeps them; same config) and a Caddy 2.10 fmt bug after
  `{blocks.*}` placeholder lines · the UI promises caddy fmt style on save · none.
- 2026-11-06 · W11 · Accessibility (axe, WCAG 2.1 A/AA, serious and critical): Fishnet's faint text colour failed
  4.5:1 at 11-12 px on the sidebar, chips, tags and diff rows, and light `acc-ink` failed on accent-soft tags. Fixed
  in `theme-caddy.css` only (colour tokens, as PLAN.md §6 allows): `--faint` #78716a → #5f5850 (light), #867d71 →
  #a0978a (dark); light `--acc-ink` #1a7560 → #166a57. Scroll containers that can hold no focusable content
  (`main`, the diff views) get `tabindex="0"` so keyboard users can scroll them; the "sites are down" links on
  Overview are underlined. CodeMirror's scroller is excluded from the scan (its contenteditable is focusable; axe
  does not count it) · PLAN.md §5.1 W11 · if David vetoes the darker faint text, the axe test fails, so pick
  another value that keeps 4.5:1.
- 2026-11-06 · W11 · Performance budget set in `e2e/tests/perf.spec.ts` and `docs/testing.md`: first byte 500 ms,
  load 1.5 s (editor 2 s), JavaScript 120 KB (editor 450 KB), everything 600 KB (editor 1.4 MB), editor ready in
  2 s on David's file, one form keystroke to the outline in 300 ms · about twice what was measured, so it catches
  regressions and not runner noise · none.
- 2026-11-06 · W11 · docs/install.md and the W5a item in TODO-USER.md said to press "Review and apply" without
  changing anything; that button is disabled until the text differs from the file. Both now say "Format", then
  "Review and apply" · found by the e2e round trip · none.
- 2026-11-06 · W11 · `deploy/ci/install-smoke.sh` (CI job "Install docs and compose swap") follows the compose
  swap in TODO-USER.md on a runner: David-shaped compose with stand-ins for the two zackwag services, the
  `caddy-ui` service block copied verbatim from TODO-USER.md (image swapped for the CI build), `docker compose
  config`, `up -d --remove-orphans`, health, sign-in on 9876, Sites, a save that reaches the bind-mounted file and
  Caddy, and the rollback in step 9 · the coordinator asked for the swap steps to be proven, and a doc change
  that breaks them now fails CI · none.
- 2026-11-06 · W9 · The UI image is built per architecture on native runners (`ubuntu-latest`,
  `ubuntu-24.04-arm`) and merged into one multi-arch tag; the updater image still builds under QEMU ·
  the first publish run hung for 30 minutes building `better-sqlite3` for arm64 under QEMU · switch back
  to one `build-push-action` with both platforms if the native module stops needing a compile.
- 2026-11-06 · README screenshots · Taken with Playwright against a demo stack (`e2e/screenshots/`) rather than
  by hand, so they can be retaken after UI changes: the anonymised sample Caddyfile, stub upstreams on loopback
  aliases, a made-up 24 hour access log and Caddy's internal CA. Light and dark PNGs at 1x (about 100–200 KB
  each), shown with `<picture>` so GitHub picks the one matching the reader's theme. The demo's extra global
  options (`metrics`, `cert_issuer internal`, `pki`, `http_port 18080`) show in the editor shots; they are real
  Caddy options, and hiding them would mean faking the page · David asked for screenshots in the README · none.
- 2026-11-06 · README screenshots · The Sites table showed "expired" for a certificate with less than a day left
  (`certDays <= 0`), while Overview already used `< 0`. Sites now uses `< 0` too, so a certificate expiring later
  today reads "0 d" with the warning tag · found while taking the screenshots · none.
