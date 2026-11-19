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
- 2026-11-18 · Porkbun plan · From this entry on, each decision ends with `confidence N` (1–100: how sure the
  thread is that David would make the same call). Below 70 the thread also asks David, with its recommendation,
  and keeps building on it (AUTOPILOT.md rule 3) · David asked for it on 18 Nov · none · confidence 95.
- 2026-11-18 · Porkbun plan · The UI server calls Porkbun's API v3 directly with header auth, using the same
  `PORKBUN_API_KEY` / `PORKBUN_API_SECRET_KEY` names the `caddy` service already has; keys come from env only and
  are never stored · one `.env` entry serves both containers, and header auth keeps keys out of request bodies
  so those can be audited · to use a separate key for the UI, set different values on the `caddy-ui` service ·
  confidence 90.
- 2026-11-18 · Porkbun plan · Not built on Porkbun's MCP server or webhooks; a small typed client instead · the
  UI needs a server-side API, not agent tools, and webhooks need a public HTTPS endpoint · none · confidence 88.
- 2026-11-18 · Porkbun plan · Scope is everything changeable on an existing domain that does not spend money:
  DNS records, restore points, preflight, import, DNSSEC, nameservers, glue, URL forwarding, auto-renew, SSL
  bundle, read-only pricing and balance. Registration, transfers, hosting, mailboxes, Link in Bio, the Cloudflare
  move, agent naming, top-ups and API key management are out · "manage my existing domains" · add a workstream
  to docs/porkbun-plan.md §5 · confidence 80.
- 2026-11-18 · Porkbun plan · Renewals (spend credit), WHOIS contacts (personal data) and email forwarding are
  left out by default and put to David as one question · they are arguably part of "fully manage", but each has
  a cost or privacy edge · a yes adds P8a/P8b/P8c (docs/porkbun-plan.md §8) · confidence 60, asked.
- 2026-11-18 · Porkbun plan · No dynamic DNS (keeping A/AAAA on the server's public IP) by default; asked ·
  not requested, and it writes DNS without a person reviewing it · a yes adds P9 · confidence 62, asked.
- 2026-11-18 · Porkbun plan · Every write goes through a review step with Porkbun's dry run where it exists;
  typed confirmation for nameserver changes, DNSSEC deletes, bulk deletes, restore with prune and glue deletes;
  nameserver changes are refused while preflight reports blockers · a wrong DNS write takes sites and mail down,
  and the editor already taught "Review and apply" · relax per action in docs/porkbun-plan.md §3.1 · confidence 85.
- 2026-11-18 · Porkbun plan · Reads are cached in SQLite for 60 s (`CADDY_UI_PORKBUN_CACHE_TTL`) and every write
  is recorded in `porkbun_audit` with the state before · fast pages, survives rate limits, and gives an undo
  trail where Porkbun has none · change the TTL by env · confidence 82.
- 2026-11-18 · Porkbun plan · Read-only is the default when `CADDY_UI_AUTH_MODE=none`; otherwise writes are on ·
  an unauthenticated UI should not be able to change DNS by accident · set `CADDY_UI_PORKBUN_READONLY=false` ·
  confidence 75.
- 2026-11-18 · Porkbun plan · The SSL tab shows the Porkbun-issued certificate and lets the chain be downloaded;
  the private key download needs `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD=true` · Caddy issues its own certificates,
  so the key is rarely needed and is the most sensitive thing the API returns · set the env switch · confidence 75.
- 2026-11-18 · Porkbun plan · The plugin Caddy image is shipped as `deploy/caddy/Dockerfile` for David to build
  (as he does today), not published to GHCR · he already builds it, and publishing a Caddy image means tracking
  Caddy releases · P6 can add a publish job later · confidence 72.
- 2026-11-18 · Porkbun plan · Tests never call the real API: unit and e2e tests use an in-repo fake seeded from
  Porkbun's `/mock` responses; a job against Porkbun's sandbox runs only if sandbox keys are added as secrets ·
  CI must not depend on an account or touch real DNS · none · confidence 85.
- 2026-11-18 · Porkbun plan · P0 alone edits shared files (env, migrations, nav, hooks, the route layout) and
  creates placeholders, so P1–P5 run in parallel in folders of their own; models are Fable for P0, P2, P5, Opus
  for P1, P3, P7, Sonnet for P4, P6 · David asked for as many parallel agents as do not collide, and Fable where
  needed · change the table in docs/porkbun-plan.md §5 · confidence 80.
- 2026-11-18 · Porkbun plan · The `caddy-dns/porkbun` Caddyfile syntax in docs/porkbun-plan.md §4 was written
  from memory because this session could not open that repository; P5 verifies it first · flagged rather than
  assumed · none · confidence 85 that the syntax is right.
- 2026-11-18 · P6 drafts · `deploy/compose.example.yml` passes `PORKBUN_API_KEY` and `PORKBUN_API_SECRET_KEY`
  to both `caddy` and `caddy-ui` as `${VAR:-}` (empty when unset), not `:?` as in David's own file · the example is
  also used by the updater CI job and by people without Porkbun; the Domains area must then be off · switch to
  `:?` in your own compose · confidence 78. Needs P0 to treat an empty value like an unset one; told the
  coordinator.
- 2026-11-18 · P6 drafts · The example `caddy` service builds from `deploy/caddy/Dockerfile` (tag
  `caddy-porkbun:local`) instead of `caddy:latest`; the Dockerfile pins the Caddy minor version (`ARG
  CADDY_VERSION=2.11`) but not the plugin, which xcaddy resolves to its latest · David already builds the plugin
  Caddy himself, and pinning the minor keeps rebuilds predictable while the plugin has no tags worth pinning ·
  edit the ARG, or pass `--build-arg` · confidence 70.
- 2026-11-18 · P6 drafts · A new CI job `caddy-porkbun` builds the plugin image, checks that `dns.providers.porkbun`
  is listed, adapts the documented Caddyfile syntax, and uploads the image as artifact `caddy-porkbun-image` for
  later jobs (P5, P7) · gives P5 a real way to verify the plugin syntax that the plan flagged as unverified ·
  none · confidence 80.
- 2026-11-18 · P6 drafts · `.github/workflows/porkbun-spec-drift.yml` runs weekly, compares `SPEC_VERSION` with the
  live spec's `info.version`, fails visibly and does nothing else; it exits with a notice while `SPEC_VERSION`
  does not exist yet (P0 creates it) · plan §7 · none · confidence 85.
- 2026-11-18 · P6 drafts · `docs/porkbun.md` is committed as a draft: set-up, settings, sandbox and troubleshooting
  are final; the tab descriptions and safety rules are marked *(to verify)* and are checked in the final docs pass
  after P1-P5 · the UI does not exist yet, and claiming behaviour that may change would mislead · final pass
  rewrites the marked sections · confidence 85.
- 2026-11-18 · Porkbun plan · David answered both questions asked below 70: renewals, WHOIS contacts and email
  forwarding stay out, and there is no dynamic DNS. The P8a/P8b/P8c and P9 workstreams are dropped
  (docs/porkbun-plan.md §8) · his choice on the decision cards · he can ask for any of them later · confidence 100.
- 2026-11-18 · P0 · `CADDY_UI_PORKBUN_READONLY` also defaults to `true` when auth mode is `local` with neither
  `CADDY_UI_USER` nor `CADDY_UI_PASSWORD` set, not only with mode `none` · that case runs without sign-in too, and
  the reason for the default (an open UI should not change DNS by accident) is the same · set
  `CADDY_UI_PORKBUN_READONLY=false` · confidence 78.
- 2026-11-18 · P0 · An empty or blank `PORKBUN_API_KEY` / `PORKBUN_API_SECRET_KEY` counts as unset, and the values
  are trimmed · P6's compose example passes `${VAR:-}`, and a stray newline from an env file would otherwise make
  every call fail · none · confidence 90.
- 2026-11-18 · P0 · Contract (§3.2), additions only: `audit()` returns the row id; `PorkbunStatus` gains `account`
  and `checkedAt`; `ApiError` gains `retryAfter` and `details` (Porkbun's extra error fields such as `existingId`
  and `conflictingRecords`); the failure branch of `WriteResult` gains an optional `auditId`; the server module
  also exports `isConfigured()`, `listDomains()`, `auditLog()`, `toApiError()` and `write()`; migration 3 adds an
  index on `porkbun_audit (domain, id)` · each was needed by a P0 page or saves P1–P5 from writing the same code
  five times, and nothing that was promised changed shape · they are additions, so removing one only needs its
  callers changed · confidence 88. Told the coordinator.
- 2026-11-18 · P0 · Contract (§3.2), one change: `DnsRecord.type` is `AnyRecordType` (the 14 known types or any
  other string), with `isKnownRecordType()` to narrow it; `DnsRecordInput.type` stays the 14 · §7 says a record
  of a type this build does not know is shown read-only and never dropped, which the narrower type could not
  express · narrow it back if Porkbun's list is ever closed · confidence 85. Told the coordinator.
- 2026-11-18 · P0 · Dates in the shared types are ISO 8601 UTC strings (or '' when Porkbun sent none); the client
  converts Porkbun's "YYYY-MM-DD HH:MM:SS" · one format for every page, and `Date` parses it the same in every
  browser · change `isoDate` in client.ts · confidence 88.
- 2026-11-18 · P0 · `write()` in the server module is the one way to send a change: it checks read-only mode and
  the key's permission, runs the call, drops the domain's cached reads on success and on failure (after a lost
  connection the write may have happened), and records both outcomes in `porkbun_audit` · the safety rules of
  §3.1 then hold by construction instead of by five workstreams remembering them · routes can still call the
  client directly, but should not · confidence 85.
- 2026-11-18 · P0 · The read cache is emptied when the process starts, instead of being tied to a fingerprint of
  the key · a restart is the only way the key can change, and no hash of a secret has to be stored · store a
  fingerprint if cold starts ever hurt · confidence 80.
- 2026-11-18 · P0 · A stale cached answer is served only when Porkbun can not be reached or says the failure is
  temporary (rate limit, DNS read failed); a refusal such as a missing permission is shown as the error it is ·
  old data should not hide that access was taken away · cache.ts · confidence 82.
- 2026-11-18 · P0 · The client waits out a 429 on a read once, and only when `Retry-After` is 5 s or less; writes
  are never retried by the client. At most 4 requests run at once, each with a 15 s timeout, and redirects are
  refused · a page should answer or fail quickly, a write must not be sent twice without the person knowing
  (every POST still carries an `Idempotency-Key`), and a redirect would carry the key headers to another host ·
  the limits are options of the `Porkbun` class · confidence 80.
- 2026-11-18 · P0 · The key's scopes come from the last `/ping`, remembered in memory (as long as the cache TTL,
  at least 10 s; a failed ping for 10 s); `requireWritable()` uses that and lets the request through when no ping
  has succeeded yet, so Porkbun itself is the judge · one extra call per write would double the request count
  against the rate limit · `porkbunStatus({ force: true })` re-checks · confidence 80.
- 2026-11-18 · P0 · Key values are blanked in everything that leaves the client (error messages and details,
  results) and in every audit row, and fields named like a key or a private key are dropped from audit rows; the
  cache refuses to store the SSL bundle · the keys and the certificate key are the only secrets here, and
  `secrets.test.ts` holds the line with marker keys · none · confidence 90.
- 2026-11-18 · P0 · `toResponse()` maps errors to HTTP like this: keys unset or Porkbun unreachable 503, rate limit
  429 with `Retry-After`, Porkbun's 403/404/409 as they are, its other 4xx as 422, anything else 502 · the browser
  needs to tell "try again" from "change the request" without parsing text; the body always carries the code ·
  errors.ts · confidence 80.
- 2026-11-18 · P0 · With the keys unset, `/domains` shows the set-up steps and every page under it redirects
  there; the nav entry is always shown · the plan asks for one nav entry and no calls, and a person who has not
  set it up should find out that it exists · hide the entry in nav.ts · confidence 80.
- 2026-11-18 · P0 · The About page lists `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` (as set or unset) and
  `CADDY_UI_PORKBUN_READONLY` · it already lists every other setting that way, and it is the quickest way to see
  whether the container got the keys · remove the three rows · confidence 82.
- 2026-11-18 · P0 · `routes/domains/[domain]/+layout.svelte` owns the page heading (the domain name), the status
  tags and the tab bar; tab pages start at `<h2>`. The Activity page links each row to its domain and pages with
  `?before=` · one heading per page, and tabs that do not jump · the layout file · confidence 85.
- 2026-11-18 · P0 · The fake Porkbun (`fake.ts`) imports nothing at run time and has two error codes of its own
  where the spec names none (`SSL_NOT_READY`, `INVALID_RECORD_ID` for an unknown URL forward) · P7 can load it
  with plain Node and serve it over HTTP for the e2e suite; nothing may branch on the two invented codes ·
  replace them when Porkbun documents real ones · confidence 78.
- 2026-11-18 · P0 · A vitest setup file makes any request to a `porkbun.com` host fail in unit tests · "no test
  calls the real API" is then enforced, not just intended · `no-network.setup.ts` · confidence 92.
- 2026-11-18 · P4 · The SSL switch is read with `config().porkbun.sslKeyDownload` in `lib/server/porkbun-ssl.ts`,
  not from the Porkbun module's own settings · `index.ts` is P0's and exports no accessor, so a P4 helper reads
  the same environment value; tests flip it by mocking `$lib/server/env`. A later cleanup can move it behind a
  P0 accessor · `useFakePorkbun({ settings: { sslKeyDownload } })` does not reach it · confidence 75.
- 2026-11-18 · P4 · `GET …/ssl` answers with certificate details (`SslInfo`) and never with the bundle; the chain
  and the key are only served by `…/ssl/download?part=chain|key` · the browser never needs the key in a JSON
  body, and the page's load data can not leak it · none · confidence 88.
- 2026-11-18 · P4 · The key download is refused unless `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` is on, refused when
  `Sec-Fetch-Site` is `cross-site`, and written to the activity log as `ssl.key-download` without the key · a
  private key leaving the server should leave a trace · log row for the chain download too (judged noise) ·
  confidence 80.
- 2026-11-18 · P4 · Adding a forward is refused with 409 `DUPLICATE_FORWARD` when the subdomain already has one,
  after a fresh read of the list · the API spec does not say what Porkbun does with two forwards for one name,
  so a second one is not risked · let Porkbun decide · confidence 68. Low only because Porkbun may allow it;
  the effect of being wrong is that a legitimate second forward needs the first deleted.
- 2026-11-18 · P4 · A forward's subdomain takes letters, digits and hyphens in dot-separated labels; `*` is not
  allowed, the "every subdomain" option is the wildcard · matches how Porkbun's form splits the two · accept
  `*` · confidence 80. The destination must be http(s) without a user name or password.
- 2026-11-18 · P4 · Deleting a forward uses the review dialog with a plain confirm, not a typed domain name ·
  §3.1 rule 3 asks for typing only for DNS records by name and type, nameservers, DNSSEC, glue and prune
  restores, and a forward is one row · typed confirm · confidence 82.
- 2026-11-18 · P4 · The SSL page does not branch on Porkbun's invented `SSL_NOT_READY`; any error is shown by
  `PorkbunNotice` as written · P0 asked for that · none · confidence 90.
- 2026-11-18 · P1 · P1's shared code lives in a new folder, `apps/ui/src/lib/porkbun/domains/`: client-safe
  types and helpers in `index.ts`, the reads and the auto-renew write in `data.server.ts`, used by both the
  `/api/porkbun/*` routes and the two page loads · the ownership table names no home for a workstream's
  helpers outside its route folders, and no other workstream owns this one · move it if P0 wants it elsewhere ·
  confidence 80.
- 2026-11-18 · P1 · The domain list sends every row to the page and sorts, filters and searches in the browser,
  drawing 100 rows per page; the page data leaves out `createDate` and `tld`. Measured with 1,000 fake domains
  against the built app: 423 KB in all, TTFB 136 ms, load 248 ms, 60 KB of JS (the W11 budget is 600 KB,
  500 ms, 1,500 ms, 120 KB) · instant filtering without a server round trip, inside the budget · server-side
  paging if accounts grow past a few thousand domains · confidence 78.
- 2026-11-18 · P1 · "Expiring soon" means within 30 days or already expired. The countdown is a warning tag only
  when auto-renew is off (an expired domain is always an error tag) · a domain that renews by itself needs no
  attention · `EXPIRING_SOON_DAYS` in `lib/porkbun/domains` · confidence 75.
- 2026-11-18 · P1 · The renewal price is Porkbun's public list price for the TLD (`/pricing/get`, every TLD in one
  call, cached as `_account:pricing`); a price list that fails leaves the column empty with a notice and does not
  fail the page · the API has no per-domain renewal quote outside the out-of-scope renew call; premium domains
  can cost more than this · confidence 72.
- 2026-11-18 · P1 · The Overview tab's flags come from `/domain/get` (cached as `<d>:domain`), not from the list,
  and fall back to the list's copy with a notice when that read fails · the definition of done asks that every
  flag match `/domain/get` · confidence 85.
- 2026-11-18 · P1 · The Overview counts (records, restore points, URL forwards, glue hosts, DS records) are
  cached under their own keys, `<d>:<area>:overview`, holding counts only; the nameservers are read through
  P3's key `<d>:ns` with P3's loader (`ns.get`, a sorted string[]) and summarised after reading, as P3 asked. With API access off
  those reads are not made and the tiles say why · a write on another tab that drops `<d>:<area>` or `<d>` drops
  the count too, and the overview can never store something under another tab's key in a shape that tab does
  not expect; asking for what Porkbun is known to refuse only spends the rate limit · confidence 80.
- 2026-11-18 · P1 · Bulk auto-renew sends 100 domains per `/domain/updateAutoRenew` request, in turn, and answers
  with one result per domain in the order asked. A request for one domain is logged under that domain; a
  request for several is logged once as an account-wide change with the names and the state before in the row.
  One name not in the account refuses the whole request before anything is sent · Porkbun takes a list, so one
  row per request matches what was sent; per-domain rows would mean one request per domain · confidence 75.
- 2026-11-18 · P1 · Auto-renew changes skip domains already in the target state. In bulk, a domain with API access
  off is still sent and Porkbun's refusal is reported for it (the review step says it will be refused); on the
  Overview tab the button is disabled for such a domain · a bulk selection should report what happened to every
  name in it, while a single button that can only fail should not be offered · confidence 72.
- 2026-11-18 · P1 · Transfer lock, WHOIS privacy and API access are shown read-only with a link to porkbun.com, and
  the account credit is a read-only tile on the list (no top-up) · the API in this build's scope has no call that
  changes them, and top-ups are out of scope (plan §2) · confidence 85.
- 2026-11-18 · P1 · The list's filter and search are kept in the address (`?filter=soon`, `?q=`) by a shallow
  history replace, so a reload or a link shows the same list; the sort is not · links such as "expiring soon"
  can point straight at the filtered list · confidence 78.
- 2026-11-18 · P3 · P3 also owns two new folders the ownership table does not list, `lib/porkbun/registry/**`
  (input checks, browser calls, the safety check list, shared by the pages and the routes) and
  `lib/server/porkbun-registry/**` (small route helpers) · the checks must be the same in the form and on the
  server, and no other workstream claimed these names, so nothing collides · move them under a P3 route folder
  if anyone objects · confidence 85.
- 2026-11-18 · P3 · The server checks the typed confirmation as well as the page: restore with prune, a
  nameserver change, deleting glue, and adding or deleting a DS record need `"confirm": "<domain>"` in the body,
  or the route answers 400 `CONFIRMATION_REQUIRED` and sends nothing · §3.1 rule 3 then holds for every caller,
  not only for this UI's pages · drop `requireConfirm` from a route to relax it · confidence 80.
- 2026-11-18 · P3 · Adding a DS record needs the domain typed too, although §3.1 rule 3 names only deleting one
  · a DS record that does not match the zone's key makes the whole domain fail for validating resolvers, which
  is worse than most deletes · confidence 75.
- 2026-11-18 · P3 · Nameserver and DNSSEC changes run Porkbun's preflight on the server, uncached, right before
  the write, and answer 409 `PREFLIGHT_BLOCKED` (with the preflight) while it reports a blocker. The review
  step gets the same check from the rehearsal (`PUT …/nameservers` with `dryRun`, `POST …/dnssec` with
  `check`) · §3.1 rule 4 and the P3 definition of done; a cached "safe" answer must not let a move through ·
  confidence 88.
- 2026-11-18 · P3 · "Undo this restore" restores `previousStateSavedAs` with prune, always · a restore without
  prune only adds records back, so it can not take away what the first restore added; with prune the zone is
  exactly as before. The undo still needs the domain typed · confidence 85.
- 2026-11-18 · P3 · Cache keys: `<domain>:history`, `<domain>:history:<id>` (diff), `<domain>:preflight:<intent>`,
  `<domain>:ns` (the `string[]` of `porkbun().ns.get`, the shape P1's overview would read), `<domain>:glue`,
  `<domain>:dnssec`. Compare and the review step always ask Porkbun for a fresh diff · one key per read, same
  shape for anyone who reads the same key; a diff is a comparison with the live zone and goes stale with every
  change made at porkbun.com · confidence 80. Told the coordinator about `<domain>:ns`.
- 2026-11-18 · P3 · Input rules before any call: 2 to 13 distinct nameserver hostnames; a glue host is one label
  (`ns1`) or a full name under the domain (`ns1.eu.example.com`), never another domain; 1 to 13 glue addresses;
  DS key tag 0 to 65535, digest in hex with the length its digest type requires (40, 64 or 96); algorithms 1, 3,
  5, 6, 7 and 12 refused as retired (the same list the fake refuses); key data all or nothing; a second DS
  record with a key tag that exists is refused (Porkbun keys DS records by key tag) · catches typing mistakes
  with a clear message instead of a registry error · `lib/porkbun/registry/validate.ts` · confidence 78.
- 2026-11-18 · P3 · Glue and DNSSEC have no dry run at Porkbun, so their review step shows the change, the
  safety check (DNSSEC) and advice, and says plainly that Porkbun does not rehearse it · §3.1 rule 2 asks for a
  dry run only where Porkbun has one · confidence 85.
- 2026-11-18 · P3 follow-up · `ReviewDialog` (P0-owned) no longer shows "Porkbun checked this change and would
  accept it" while `blocked` is set; the red "This can not be applied" stands alone. A failed dry run is still
  shown beside a blocker · the two lines contradicted each other in the nameserver dialog with active DNSSEC and
  in the restore dialog with nothing to add back. A one-condition change, no prop or contract changes, so P2, P4
  and P5 need nothing · confidence 92.
- 2026-11-18 · P5 · The plugin's Caddyfile syntax was read from the source of github.com/caddy-dns/porkbun
  v0.3.1 and checked by adapting against Caddy 2.11.2 built with and without it: nothing on the `porkbun` line,
  `api_key` and `api_secret_key` in its block, both required, no other option. Stock Caddy answers the probe
  with HTTP 400 "module not registered: dns.providers.porkbun" · the plan's syntax was written from memory and
  flagged; it was right · `packages/caddy-schema/scripts/plugins.ts` and `PROBE_CADDYFILE` · confidence 95.
- 2026-11-18 · P5 · Contract addition (schema): `DirectiveSchema.plugin` (Caddy module ID),
  `DirectiveSchema.requires` (subdirectives that must be present) and `ArgSchema.secret` (the placeholder to
  suggest); the four lines that name a DNS provider (`tls`'s `dns`, the acme issuer's `dns`, global `acme_dns`
  and `dns`) now take a block, free-form for providers the schema does not know, with a `porkbun` variant from
  `scripts/plugins.ts` · the schema said "dns does not take a block" for the valid `dns porkbun { … }`, and a
  validator rule reaches both editors and the server at once · all three fields are optional, so nothing that
  reads the schema changes; remove the `applyPlugins` call to undo · confidence 85.
- 2026-11-18 · P5 · The literal-key warning is a validator rule (`literal-secret`, a warning, never an error):
  a value for `api_key` / `api_secret_key` without a placeholder says "this puts the key in the Caddyfile and
  in History; use {env.…} instead" and never repeats the value; `{env.X}` and `{$X}` both pass. The form shows
  the same as a notice · one rule for the text editor, the visual editor and the server's check · `validate.ts`
  `checkArg` · confidence 88.
- 2026-11-18 · P5 · Contract addition (forms): `FormSpec.claimsFor(node)` lets a form claim body lines per node;
  the provider picker is a `custom` field, so `forms-w5b.test.ts` (W5b's file) sets the provider through the
  picker's functions instead of the old text field · a global `acme_dns` line is the provider line itself, so
  which of its lines the form owns depends on the node · optional, nothing else uses it · confidence 85.
- 2026-11-18 · P5 · Porkbun is first in the provider picker unless the plugin is known to be missing, where it
  is still offered, marked "plugin not in this Caddy", with a warning; a provider other than Porkbun keeps the
  free text it had (credentials on the line, options in a block) · "not checked" must not hide the guided path,
  and controls are disabled or explained, not hidden · `DnsProviderField.svelte` · confidence 80.
- 2026-11-18 · P5 · Detection is cached until Caddy's process start time changes (from the metrics the UI
  already reads), looks at that at most every 30 s, asks again after an answer that was neither yes nor no, and
  never throws for an unreachable Caddy (state `unknown` with the reason) · "cached until Caddy restarts"
  needs something that changes on a restart, and a page must still render when Caddy is down · `plugin.ts` ·
  confidence 85.
- 2026-11-18 · P5 · Contract additions (API): `GET /api/porkbun/caddy` takes `?only=plugin` (asks Caddy only,
  works with the keys unset), `?domain=` and `?force`, and its `sites[]` rows carry `siteId`, `status`, `detail`,
  `fix`, `hints` beside the `host`, `records[].id` and `dns01` the DNS tab reads; `POST
  /api/porkbun/caddy/records` takes `dryRun` and `expect`; new route `POST /api/porkbun/caddy/challenges` for
  the cleanup. Shapes are in `lib/api/porkbun-caddy.ts` · the review step needs a rehearsal and a way to notice
  that the records changed since, and the cleanup is a write of its own · additive; P2 reads only the three
  fields it named · confidence 82.
- 2026-11-18 · P5 · The server decides the record fix: an A (or AAAA) record with this server's public IP as
  Porkbun's `/ping` saw it, or that content on the one record that is wrong. The browser sends only the site
  address and the fix it reviewed; a fix that no longer matches is a 409 with the new one. No fix is offered
  behind a CNAME, for several records of one name, or when only some of them are wrong; behind a wildcard the
  name gets a record of its own and the wildcard is left alone · a request can then never write an address the
  person did not review, and the cases without one obvious change go to the DNS tab · `actions.ts`, `judge()` in
  `check.ts`; the dialog says where the IP comes from, for servers that are reached through another address ·
  confidence 80.
- 2026-11-18 · P5 · Cross-check statuses beyond the plan's wording: `private` (the name points at 10.x,
  192.168.x and the like; shown neutral, no fix, since internal-only sites are normal in a homelab),
  `external` (a CNAME leaves the account), `unverified` (public IP unknown, or only the other address family
  has a record), `elsewhere` (nameservers are not Porkbun's) and `unreadable`. Wildcard records answer by the
  closest-encloser rule, and CNAME/ALIAS are followed across the account's zones · a private address is not a
  mistake to fix, and "wrong" should only be said when it is certain · `DnsCheckStatus` · confidence 78.
- 2026-11-18 · P5 · "Left behind" for a challenge record means this UI first saw it more than 24 hours ago;
  first-seen times are kept by record id in the `settings` table (key `porkbun.caddy.challenges`), no migration.
  The cleanup deletes only such records, checks each id against the zone again, rehearses with Porkbun's dry
  run, and logs each delete with what the record held · Porkbun does not say when a record was made, and a
  record of an order in progress must never be deleted · `STALE_AFTER_MS` in `challenges.ts` · confidence 75.
- 2026-11-18 · P5 · With the Porkbun keys unset the Sites pages look as before: no DNS column, no panel, no
  hints; `GET /api/porkbun/caddy` still answers the plugin check. With keys, the pages ask for the tie-in after
  they have rendered, so the list never waits for Porkbun · the cross-check is about records at Porkbun, and
  David's first deploy has no keys on the UI yet · `porkbunOn` in the two `+page.server.ts` · confidence 80.
- 2026-11-18 · P5 · The wildcard hint's "Use the Porkbun DNS challenge" is a form action (`dns01`) on the
  Sites list and the site page that edits the site through the config service, after a dialog that shows the
  block; "also create the DNS record" opens by itself after "Add site" as a second review step, once per new
  address that has no record, and not at all in read-only mode · the Caddyfile edit gets Caddy's validation,
  the hash check and History like every other edit, and the record write gets the same review as every other
  record write · `site-edit.ts`, `RecordFixDialog.svelte` · confidence 82.
- 2026-11-18 · P5 · Files outside the folders the plan lists for P5: `lib/api/porkbun-caddy.ts` (the API's
  shapes, beside `lib/api/porkbun.ts`), `lib/porkbun/caddy/**` (the dialogs and the checks list that the Sites
  pages and the Caddy tab share), `lib/visual/forms-w5b.test.ts` (see above) and one job in
  `.github/workflows/ci.yml` (P6's file): `caddy-porkbun-tie-in` loads the `caddy-porkbun-image` artifact and
  runs `test:caddy` with `CADDY_TEST_PORKBUN_PLUGIN=present`; the existing `caddy` job runs the same file
  against stock Caddy and expects "missing" · shared code needs a home no other workstream owns, and the
  definition of done asks for both Caddy builds; P6's entry says the artifact is for P5 · confidence 80.
- 2026-11-18 · P5 · "Every Caddy call goes through `adminFetch`" is a test (`caddy.test.ts`) that reads the
  tie-in's server files and fails on a bare `fetch(`; the detector takes a `CaddyAdmin` · the plan allows a lint
  rule or a test, and a test needs no change to the shared ESLint config · confidence 85.
- 2026-11-18 · P2 · Every change to a record goes into a pending-changes tray first, a single add, edit or
  delete included, and is sent from one review step. The tray is kept in the tab's session storage per domain,
  so a reload does not lose it · one path to Porkbun means one review (§3.1 rule 1) and nothing to keep in step
  between a "quick" path and the batch path. The "plain confirm" for deleting one record (rule 3) is the
  review's Apply button; more than one delete needs the domain typed · add direct buttons that call
  `POST …/dns` and `PUT`/`DELETE …/dns/:id`, which exist and are tested · confidence 78.
- 2026-11-18 · P2 · A batch is sent as deletes, then edits, then new records, each in the order they were
  decided · replacing a record (a CNAME for the A record at the same name) then works whichever of the two was
  decided first, and the review lists the changes in the order they go out · `inSendOrder` in
  `lib/porkbun/records/tray.ts` · confidence 80.
- 2026-11-18 · P2 · Records are edited and deleted by id only; Porkbun's `…ByNameType` endpoints are not used ·
  they change every record of a name and type at once, which the review could not show record by record ·
  confidence 82.
- 2026-11-18 · P2 · An edit carries the whole record and, from this UI, the record as the person saw it
  (`expect`). Only the fields that differ are sent to Porkbun. A record that reads differently now, is gone, or
  is named twice in one batch refuses the change with a 409 before anything is written · two people (or this
  UI and porkbun.com) must not overwrite each other without seeing it · leave `expect` out of a request to
  skip the check · confidence 85.
- 2026-11-18 · P2 · The type of a record can not be changed by an edit; the form says to delete it and add
  another · Porkbun's edit keeps the id, and a record that silently became another type under the same id is
  hard to follow in the write log · confidence 80.
- 2026-11-18 · P2 · Records of a type outside the 14 are shown and exported but can be neither edited nor
  deleted here · this build has no rules for them, so it can not say what a change would do · allow delete in
  `planChanges` (`READ_ONLY_TYPE`) · confidence 80.
- 2026-11-18 · P2 · Preview and apply both read the zone fresh from Porkbun and plan the batch with the same
  pure code the page uses (`planChanges`). A problem with any change refuses the whole batch before a write:
  400 `INVALID_RECORD` for a record that is not valid, 409 `PLAN_REFUSED` for a clash with the zone. Once writes
  go out, the first failure stops the batch and the changes after it are reported as `not_applied` (HTTP 207) ·
  later changes were reviewed on the assumption that earlier ones worked; sending them into another zone than
  the one reviewed is worse than stopping. Porkbun has no transaction to roll back with · confidence 78.
- 2026-11-18 · P2 · The server, not only the page, wants `"confirm": "<domain>"` for a batch with more than one
  delete (400 `CONFIRM_REQUIRED`) · §3.1 rule 3 then holds for every caller, as P3 did for its routes ·
  confidence 85.
- 2026-11-18 · P2 · Limits: 100 changes in one batch; an import reads at most 1 MiB and 2000 records and
  creates at most 500 at a time (Porkbun's own limit for `/dns/import`) · a batch is one request that sends
  its writes one after another, and Porkbun rate limits by the minute · `MAX_BATCH`, `MAX_IMPORT_SOURCE` in
  `lib/porkbun/records/service.server.ts` · confidence 75.
- 2026-11-18 · P2 · A create that Porkbun refuses as `DUPLICATE_RECORD` adopts the existing id: the change
  counts as done (`adopted`), the record's TTL and notes are left alone, and the write log still shows the
  refusal as what it was · §3.1 rule 7 · confidence 80.
- 2026-11-18 · P2 · No Idempotency-Key is reused for a retry by the person · Porkbun replays the stored answer
  for 24 hours, failures included, so a second click after a fix would get the old failure back. P0's client
  still sends a fresh key per write · confidence 80.
- 2026-11-18 · P2 · Checks made here before Porkbun is asked: a duplicate (same name, type and value), a CNAME
  that would not be alone at its name (both ways), and a second SPF record at the bare domain. An edit that only
  changes the TTL or the notes is not held against its neighbours · they mirror `DUPLICATE_RECORD`,
  `RECORD_CONFLICT` and `SPF_CONFLICT`, give the reason with the records in the way, and work for changes
  Porkbun's dry run can not judge (a change that depends on an earlier one in the same batch) · confidence 78.
- 2026-11-18 · P2 · The review asks Porkbun to rehearse each change on its own (`dryRun`), except a change that
  only works after an earlier one of the batch, which is marked as not rehearsed, and except when any change
  has a problem found here, where Porkbun is not asked at all · Porkbun's dry run sees the zone as it is now ·
  confidence 82.
- 2026-11-18 · P2 · HTTPS and SVCB values are written as the full RDATA in `content` ("priority target
  parameters"); the spec does not show an example and no account was at hand to check. A stored value this page
  can not split into its fields is shown as one raw value, and the record's name, TTL and notes can still be
  edited with the value kept as stored · nothing is lost if Porkbun spells these differently · adjust
  `serviceBinding` in `lib/porkbun/records/kinds.ts` · confidence 72.
- 2026-11-18 · P2 · Import (zone file, the JSON this page exports, or a scan of the live DNS) is a dry run
  first: every record is sorted into new, already there, in conflict, left out or not valid against the fresh
  zone, the person ticks what to import, Porkbun rehearses it, and only then it is sent. Everything but NS goes
  through `/dns/import`; NS records below the bare domain are created one by one, because Porkbun's import
  skips every NS record. SOA and the domain's own NS records are left out. Notes are not imported (the import
  endpoint has no field for them); the review says so · confidence 74.
- 2026-11-18 · P2 · Export is a BIND zone file (`$ORIGIN`, `$TTL 600`, one record per line, notes as
  `; note: …` comments) or JSON with the notes, read fresh from Porkbun; when Porkbun can not be reached the
  last good copy is exported with a comment saying so. `ANAME` in a zone file is read as `ALIAS` ·
  `GET …/dns/export?format=json` · confidence 80.
- 2026-11-18 · P2 · "Managed by Caddy" and "used by site" are worked out by the DNS tab itself from the
  Caddyfile's site addresses and the zone (exact name, else the covering wildcard, following CNAME and ALIAS
  inside the zone). When `GET /api/porkbun/caddy?domain=<domain>` (P5) answers within 1.5 s, the pairs of
  its cross-check (`sites[].host`, `sites[].records[].id`) are used instead, and `siteId` gives the link for a
  site the scan here did not list; an answer of another shape, or one that could not read the zone, is
  ignored · the tab works when Caddy or the tie-in is slow or down and never waits on it; a test runs P5's
  real route against the same zone and both ways give the same marks. The tie-in is asked for this domain
  only, so a site under another domain whose CNAME leads into this zone is not marked; asking for every
  domain would read every zone of the account each time a DNS tab opens (the reader already handles that
  answer) · `lib/porkbun/records/marks.ts` · confidence 75.
- 2026-11-18 · P2 · The DNS tab reads the nameservers under P3's cache key `<domain>:ns` to say up front when a
  domain is answered from somewhere else, and uses P3's browser helper (`lib/porkbun/registry/api.ts`) and
  `isAtPorkbun` · one read and one way to call the API routes; no P3 file is changed · confidence 85.
- 2026-11-18 · P2 · Known gap, not decided here: `porkbun().dns.list` drops the `warnings` Porkbun sends with
  `/dns/retrieve`, so a warning that only comes with a read is not shown on the DNS tab. Warnings on dry runs
  and writes are shown as written. Needs `warnings` on `DnsZone` in P0's client; told the coordinator.
- 2026-11-19 · P6 final · `docs/porkbun.md` now documents what P1-P5 shipped, including that an import creating
  more than 500 records is refused (not split) and that read-only defaults on whenever the UI has no sign-in of
  its own (auth `none`, or `local` without user and password) · written from the merged code, not the plan ·
  none · confidence 90.
- 2026-11-19 · P2 · The gap above is closed: `DnsZone` has an optional `warnings` (the strings Porkbun
  sends with `/dns/retrieve`, left out when it sends none), `porkbun().dns.list` fills it, and the DNS tab
  shows each one as written above the table; a warning of a batch that the zone already shows is not shown
  twice · additive: no caller that builds or compares a zone changes, and the cached copy carries the
  warnings until the zone is read again. Porkbun's spec (v3.107) lists `warnings` on writes only, so the
  fake Porkbun still sends none with a read and the tests queue an answer that has them. Done on the
  coordinator's request, outside P2's own files (`lib/api/porkbun.ts`, `lib/server/porkbun/client.ts`) ·
  confidence 85.
- 2026-11-19 · P7 · The e2e stack always starts the fake Porkbun (`e2e/support/porkbun-fake.mjs`, the unit
  tests' `fake.ts` served with `node:http`) and gives the UI its fake keys, so every existing spec now runs with
  the Domains area on. Specs arrange it through `/__fake/*` control routes that live only in that server
  (`reset`, `scopes`, `records`, `record-limit`, `ssl`, `many-domains`, …); `fake.ts` is not changed. The UI's
  Porkbun cache TTL is 0 in e2e so a reset is seen at once · the keys-unset path stays covered by P0's unit
  tests, and the 33 W11 specs passed unchanged with the fake on · confidence 82.
- 2026-11-19 · P7 · "Green on both Caddy versions" is read as: the existing e2e matrix (stock Caddy 2.10 and 2)
  runs the new Porkbun specs too, where they expect the plugin to be missing, and a new job
  **E2E in Chromium against the plugin Caddy** runs the whole suite on P6's `caddy-porkbun:ci` image with
  `CADDY_TEST_PORKBUN_PLUGIN=present`, the switch `test:caddy` already uses. On stock Caddy the wildcard spec
  checks that the hint says the plugin is missing and offers no button; on the plugin Caddy it applies
  `tls { dns porkbun { … } }` through the hint and checks Caddy's running config · confidence 80.
- 2026-11-19 · P7 · P7 adds its two CI jobs to `ci.yml` and a "Domains" section to `docs/testing.md` and the
  README now, before P6's final pass, appended at the end so P6's edits merge cleanly · the plan's "after P6 is
  merged" is about not colliding; appending does not collide · confidence 75.
- 2026-11-19 · P7 · The optional sandbox job runs one read-only spec (`porkbun-sandbox.spec.ts`) with
  `E2E_PORKBUN=sandbox`; the stack refuses a key that does not start with `pk1_sb_` in that mode, and without
  the two secrets (TODO-USER, 18 Nov) every step is skipped and the job passes. It writes nothing, so it leaves
  nothing in the sandbox account · confidence 80.
- 2026-11-19 · P7 · The SSL spec makes a throwaway self-signed certificate with `openssl` at run time and has
  the fake server return it from `/ssl/retrieve`, because the fake's own chain is placeholder text the tab
  can not parse (it says so, correctly). Nothing shaped like a key is committed · confidence 85.
- 2026-11-19 · P7 · Bug fixed: axe (WCAG 1.4.1, `link-in-text-block`, serious) failed on the Caddy tab and on a
  domain with API access off: links inside a sentence were told apart by colour only. The links in the
  API-access notice, the Overview's "changed at porkbun.com", the Caddy tab's "global options" and the
  DNS-challenge dialog's "History" are now underlined, as the Overview page already does (`.inline-link`).
  Fixed in this PR rather than a separate one, because this thread can push only one branch · confidence 85.
- 2026-11-19 · P7 · Performance budget for the new pages: Domains, a domain's Overview and Caddy tab get the
  stats pages' budget (500 ms, 1.5 s, 120 KB JS, 600 KB), the DNS tab 150 KB of JS for its forms, and the list
  with 1,000 domains (P1's definition of done) 1 s, 2 s, 120 KB, 800 KB. Measured locally: first byte 20-50 ms,
  load about 0.1 s, 60-81 KB of JS, 417 KB for 1,000 domains · confidence 78.
- 2026-11-19 · P7 · Seen, not changed: the Forwarding tab opens the review for a forward whose name already has
  one and the server refuses it at apply (`DUPLICATE_FORWARD`) before Porkbun is asked. The spec covers that
  path. Catching it in the form first would be nicer, but the outcome is the same and nothing is sent ·
  confidence 72.
- 2026-11-19 · Release · Releases are cut by `.github/workflows/release.yml` (run by hand on main with a version).
  It pushes the tag with GITHUB_TOKEN, which does not start `publish.yml`, so it calls `publish.yml` as a reusable
  workflow (new `workflow_call` input `tag`) and creates the GitHub release only after the images are pushed. A
  pushed tag still publishes the same way as before. The run refuses to tag unless CI passed on the commit
  (`skip_ci_check` overrides it). Notes come from the input, else `docs/releases/vX.Y.Z.md`, else GitHub's
  generated notes · confidence 85.
- 2026-11-19 · Fix · David's false errors. (1) `tls { dns porkbun { … } }` ("dns does not take a block") is his
  1.0.0 image: on main, P5 (#30) already gives every DNS provider host a free-form block, and a test now pins
  his exact text. (2) `-1` is accepted where Caddy special-cases it, read from Caddy v2.11.9: `flush_interval`,
  `stream_timeout`, `stream_close_delay` (reverse_proxy parses them with `strconv.Atoi` first) and
  `propagation_timeout` (tls, acme and zerossl issuers). They get `literals: ['-1']`, not "any integer": Caddy
  would take `stream_timeout 5000000000` as nanoseconds, but nobody writes that and the duration error is
  more useful than silence · confidence 82.
- 2026-11-19 · Fix · A module name a host's `variants` do not list (`lb_policy`, `tls issuer`,
  `get_certificate`, `trust_pool`, …) is treated as a plugin's and its block is not checked, the same rule P5
  set for DNS providers. A known module keeps its checks (`lb_policy first { … }` is still "no block") ·
  confidence 80.
- 2026-11-19 · Fix · The duration grammar now follows Go's `time.ParseDuration`: a leading `+`, a signed
  unitless zero, `1.s` and the Greek micro sign (μs) are accepted; a bare `30` is still an error · confidence 88.
- 2026-11-19 · Settings and speed plan · Planning only, on David's word: `docs/settings-and-perf-plan.md` ranks
  the causes of the 15 s Overview and Sites loads (first: `latestProbes` scans the whole `probes` table, measured
  at 1.6 s for 1.4 million rows and 7.0 s for 6 million on a synthetic database), plans the fixes and a Settings
  page, and adds workstreams S0–S5. Its decisions D1–D14 carry their own confidence (72–85) in §5 of that file ·
  reverse by editing the plan before S0 starts · confidence 80.
- 2026-11-19 · Settings and speed plan · Four choices are below 70 and wait for David (§4 of the plan): whether
  the environment or the UI wins for a setting (recommended: environment wins and locks the field, 65), whether
  the Porkbun keys can be typed into the UI (recommended: no, 60), whether raw probe rows are kept 7 days with an
  hourly summary for the full retention (recommended: yes, 62), and which extras the page gets (55). S0 does not
  need them, except the probe summary · confidence 60.
- 2026-11-19 · Settings and speed plan · David answered Q3: raw probe results stay for the full retention (he
  has about 5 GB for site data), so there is no hourly summary table and the per-table storage view moves into
  S2. He also asked for the pages to appear at once and fill in as data arrives, so streaming with skeletons
  (fix F) is now always built instead of "only if still slow". The access log tail was checked as a cause at his
  request: it reads at most 8 MB per 5 s and the pages only read minute rollups, so it is ranked low, and fix A
  reports its lag · David's words on 19 Nov · confidence 90.
- 2026-11-19 · Settings and speed plan · David answered the rest: the UI wins over the environment (the plan had
  recommended the opposite), Porkbun keys are never entered or shown in the UI, and the extras are Discord
  notifications with editable messages, display preferences, updater controls and export/import; no editor
  preferences. The plan now has S0–S6 and decisions D16–D21, among them `CADDY_UI_SETTINGS_IGNORE=true` as the
  way back from a bad saved value, and the Discord webhook URL as the one secret kept in SQLite · David's words
  on 19 Nov; "the UI should be able to override any of that" is read as every editable setting, not sign-in,
  paths or the port · confidence 75.
- 2026-11-19 · S0 · `probe_latest` (migration 4) is a `WITHOUT ROWID` table keyed by (site, target), upserted
  in the same transaction as the probe rows, and only moved forward (`WHERE excluded.ts >= probe_latest.ts`).
  No backfill: on a database at schema 3 with 200,000 probes the migration takes under 100 ms and does not read
  `probes`; the table fills on the first probe cycle. Pruning deletes a row only when its target has not been
  probed for the whole retention · plan D1, D2 · confidence 85.
- 2026-11-19 · S0 · The `log_minutes (minute)` index goes into the same migration 4. It is not instant on a
  large `log_minutes` (about 1.5 s once on 90 days of minute rows for 35 busy sites, 0.4 s on 30 days; David's
  table is far smaller since quiet sites write no rows), but it never touches `probes`, which is what the
  "instant on millions of probe rows" rule protects, and it cuts per-site traffic for a day from 150 ms to
  16 ms on 30 days of rows. A covering index (minute, site, requests) was measured too: 25% faster for the
  30-day sum but 60% slower to build, so not taken · confidence 75.
- 2026-11-19 · S0 · The read model is a `Snapshot` object beside the collector (`collector/snapshot.ts`), fed by
  `Collector.onChange` events: after each probe cycle it rebuilds the sites payload and the 24 h Overview, and the
  sites payload again after each upstream poll (every scrape interval), certificate scan and site list change.
  Rebuilding the sites payload costs about 1.5 ms on 90 days of data, so rebuilding eagerly is cheaper than
  tracking staleness per field. `/api/sites`, `/api/overview` and the Site page read it too · plan D3 ·
  confidence 82.
- 2026-11-19 · S0 · Other Overview ranges (1h, 7d, 30d) are remembered for one step of the range but never more
  than five minutes, so the 7-day view's last hour and the 30-day view's last six hours do not freeze. The 24 h
  range has the same five-minute cap as a fallback for when the probe timer is not running · confidence 78.
- 2026-11-19 · S0 · Added beyond the plan: `topLists` and `requestsBySite` sum each calendar day (UTC) of the
  window separately and remember the sums of days that are over, per database; a write into a remembered day
  (late log minute, metrics) or any prune forgets it. Without it the 30-day Overview took 1.0–1.3 s on the
  seeded 90-day database and held the server for 775 ms in one query; with it 235 ms warm, and the first time
  is split into parts that yield. It changes no result: the merged sums equal the single query (unit tests
  compare them) · confidence 80.
- 2026-11-19 · S0 · `/reverse_proxy/upstreams` is polled by the collector with `adminFetch` on the scrape timer
  (2 s timeout); pages read `Collector.live`. A failed poll sets `live.data` to null at once, which pages already
  show as "admin API not answering", rather than keeping old numbers · plan D4 · confidence 85.
- 2026-11-19 · S0 · `Server-Timing` is set in `hooks.server.ts` from a `Timing` object every request gets in
  `locals.timing`; only requests that recorded a step get the header and the slow-load log line, so static
  files and Porkbun pages stay as they were. Steps read from the snapshot carry `desc="snapshot"` with the
  build-time duration, streamed ones `desc="streamed"`; `snapshot` gives the snapshot's age and `tail` the
  access log lag in bytes. The last 20 slow loads are kept in memory (`recentSlowLoads()`) for S3's
  Diagnostics. No new API route and no §3.2 response shape changes: `/api/sites` and `/api/overview` return
  exactly what they did (unit tests compare the snapshot with the direct computation) · confidence 85.
- 2026-11-19 · S0 · Streaming (fix F): a part the snapshot already has is returned as a plain value, so the page
  renders it on the server with no placeholder; only a part the server must still compute is returned as a
  promise, computed after the shell went out (`Timing.defer`, `setImmediate`). Overview streams its traffic
  tiles and charts, then its top lists; what is up, the upstream table and certificates always come with the
  shell. Sites streams its whole list only before the first snapshot exists. Placeholders use Fishnet's
  `fp-skel` in the real card and tile frames (no shimmer, nothing to switch off for reduced motion). The
  30-second refresh keeps the shown values until the new ones land (`Streamed` in `lib/stats`); a range change
  shows placeholders instead of the old range's numbers · plan D6 · confidence 85.
- 2026-11-19 · S0 · Sites now refreshes every 30 s while visible, like Overview (`autoRefresh`); the plan
  assumed it already did. It reloads statuses and the file hash, so an edit started before a refresh still
  gets the usual conflict check · confidence 78.
- 2026-11-19 · S0 · Streaming checked through a real Caddy 2.10.2 (built from source) in front of the UI with
  `forward_auth` and with and without `encode gzip zstd`: the shell arrived at 20–50 ms and the streamed parts
  followed in the same response (30-day range, cold: charts at 376 ms, top lists at 983 ms on the 90-day
  database). Caddy flushes chunked responses at once, so no `flush_interval` change is needed in David's
  Caddyfile · confidence 85.
- 2026-11-19 · S0 · The 90-day performance test (`pnpm test:perf`, fix G) runs in its own CI job, not in
  `pnpm test`: seeding 18 million probe rows and 4.7 million log minutes takes about 45 s and 3.5 GB. It fails
  over 200 ms for either payload's build and over 5 ms for reading them from the snapshot · confidence 82.
- 2026-11-19 · S0 · The access log is read in 1 MB slices, at most 8 per 5 s tick as before, with a
  `setImmediate` between slices; `tailLogs` became async. Prune deletes 5,000 rows per statement with a pause
  between batches · plan §1.3 E · confidence 85.
- 2026-11-19 · S1 · New contracts `GET /api/settings` and `PATCH /api/settings` (PLAN.md §3.2 table, shapes in
  `apps/ui/src/lib/api/settings.ts`). GET lists every editable variable with `value`, `source` (`saved`, `env`,
  `default`), `env`, `default`, `saved` and `ignoredReason`, then the environment-only ones (secrets as
  `{ secret: true, set }` only), plus `ignoringSaved`, `signIn`, `warnings` and the latest 50 log rows. PATCH
  takes `{ VAR: "value" | number | boolean | null }`; `null` is the reset, so there is no separate DELETE route.
  All keys are checked first and saved in one transaction, or none is. Refusals: 400 `INVALID` (with a message
  per key), `NOT_EDITABLE`, `UNKNOWN_KEY`; 403 `NEEDS_SIGN_IN`; 409 `SETTINGS_IGNORED` · confidence 82.
- 2026-11-19 · S1 · Saved values are stored as the variable's own text (`cfg.CADDY_UI_PROBE_INTERVAL` = `2m`) and
  the effective config is `loadConfig({...env, ...saved})`, so precedence, defaults (including the read-only
  default that depends on the sign-in) and error messages are exactly the environment's. Only the seven editable
  fields are taken from that result; every other field comes from the environment's own parse. `process.env` is
  never written, so a `TZ` saved in Settings changes how the UI shows times, not Node's clock · confidence 85.
- 2026-11-19 · S1 · `config()` keeps its name and its callers: it now returns the effective config through a
  resolver the settings service installs at the top of `init` (`installSettings()`), and `envConfig()` is the
  environment alone (the database path uses it, which breaks the cycle settings → db → config). Everything that
  reads `config()` per use (layout time zone, public URL for cookies) is live with no other change; the two
  places that keep a copy get a subscriber: `Collector.reconfigure()` and `reconfigurePorkbun()` · confidence 80.
- 2026-11-19 · S1 · `Collector` timers are now named loops. `reconfigure()` re-arms a waiting probe or scrape
  timer to fire one new interval from now; a job that is running takes the new interval when it schedules its
  next run. Retention is read at the next prune. S0's upstream poll runs on the scrape interval and is re-armed
  with it. Paths and the admin URL in the passed config are ignored, since
  they cannot change while the process runs. S0 also touches this file; S1 rebases onto it · confidence 82.
- 2026-11-19 · S1 · Only `CADDY_UI_PUBLIC_URL` may be saved as an empty value (meaning unset, so the UI can clear a
  URL compose sets). An empty value for any other key is refused, because it would silently mean "the default"
  while hiding the environment's value; the reset is the way to get the environment back · confidence 78.
- 2026-11-19 · S1 · "Has a sign-in" for the Porkbun guard means auth mode `forward`, or `local` with both a user and a
  password. A saved `CADDY_UI_PORKBUN_READONLY=false` is refused from the UI without one (403) and ignored with a
  warning if the sign-in is removed later. An environment `false` without a sign-in still works as before, since
  that is a deploy-time choice · confidence 80.
- 2026-11-19 · S1 · With `CADDY_UI_SETTINGS_IGNORE=true` the UI runs on environment values and defaults, saving a
  value answers 409, and a reset (`null`) still works, so the flag is also how a bad saved value is cleared
  without touching the database by hand. The layout gets `settingsIgnored` for S2's banner · confidence 76.
- 2026-11-19 · S1 · `settings_log` holds the saved values before and after (NULL = nothing saved), not the
  effective ones: the effective value can be rebuilt from the environment, and this keeps environment values out
  of the database. A save that leaves a value as it was writes no row. It is migration 5, after S0's migration 4
  (`probe_latest`). A new empty table, so it is instant on any database · confidence 80.
- 2026-11-19 · S1 · A saved settings store that can not be read at all (database error) is logged and the UI runs
  on the environment, in line with D11; only a bad environment variable stops the container · confidence 78.
- 2026-11-19 · S2 · The Settings page adds no API route and changes no §3.2 contract. Saving and the per-key reset use
  S1's `PATCH /api/settings`; the page's `load` returns the same object as `GET /api/settings` plus the path checks
  and storage facts; "Test" reuses `GET /api/caddy/status` (through `adminFetch`, as before) and
  `GET /api/porkbun/status?force` (Porkbun's `/ping`); "Measure again" is a form action on the page (`?/measure`),
  not a route · confidence 85.
- 2026-11-19 · S2 · Table sizes come from SQLite's `dbstat` (exact bytes and rows per table, indexes counted with their
  table). It reads every page of the database, about 2.6 GB at 90 days, so it runs in a `worker_threads` worker on
  its own read-only connection, never on the main thread (D5 still holds for request-path queries). The worker's
  source is inlined and started with `eval`, so the build needs no extra entry point. The answer is remembered for
  15 minutes and streamed into the page when it is not; a failure shows a notice and is not remembered. File size,
  free space on the volume (`statfs`) and the oldest pruned row are read at once in `load` · confidence 78.
- 2026-11-19 · S2 · Lowering retention shows, before saving, what the next hourly prune deletes: the cutoff time and
  about how many probe and metric rows (the measured row count times the share of the time span before the cutoff,
  since rows are one per target per cycle) and bytes. The Save button then reads "Save and delete older data"; there
  is no extra confirmation dialog, because the notice is next to the button and nothing is deleted until the prune
  runs · confidence 74.
- 2026-11-19 · S2 · Each section saves its own changed keys in one PATCH; "Use the environment's value" (or "Use the
  default" when the variable is unset) applies at once, per key. After a save the page reloads its data, so the time
  zone in the footer and every other page follow at once · confidence 82.
- 2026-11-19 · S2 · Path checks ask for what the UI does with each path: the Caddyfile must be readable and writable
  (error otherwise), a missing access log or Caddy data directory is a warning (both are optional), Caddy's data
  directory only needs reading, `CADDY_UI_DATA` must be writable. A few `stat`/`access` calls in `load`; "Check
  again" reloads · confidence 80.
- 2026-11-19 · S2 · With `CADDY_UI_SETTINGS_IGNORE=true` the layout shows a banner on every page (S1's
  `settingsIgnored`), and the Settings fields show the value in force rather than the ignored saved text, with
  saving off and the reset still working. Without the flag, a saved value ignored for failing its check stays in the
  field so it can be fixed · confidence 80.
- 2026-11-19 · S2 · About keeps the version and uptime and links to Settings; its configuration table is gone (D12).
  Docs that pointed to About for the values in use now point to Settings · confidence 85.
- 2026-11-19 · S2 · The Updates section shows the updater's variables as this container sees them, read-only, and
  says the sidecar reads its own copy; S4 makes the interval and "check now" editable through its file channel
  (D13). Sections later workstreams add go into `SECTION_KEYS` (lib/settings/meta.ts) and the page's section list
  · confidence 80.
- 2026-11-19 · S4 · The channel to the updater is two JSON files in one shared folder (D13): the UI writes
  `control.json` (interval, a check-now token), the updater writes `status.json` and `last-run.json`, both replaced
  atomically. The folder is `CADDY_UI_UPDATER_DIR` (default `<CADDY_UI_DATA>/updater`), which in the example compose
  is the same host folder as the updater's `CADDY_UI_UPDATE_CHANNEL_DIR` (`./caddy-ui/updater`), so David's compose
  needs no new mount, only the one environment line on the updater. No new port and no Docker socket in the UI
  · confidence 80.
- 2026-11-19 · S4 · The updater polls `control.json` every `CADDY_UI_UPDATE_POLL` seconds (default 5) instead of one
  long sleep. A check runs when the interval is up, when a new check-now token appears, or (as before) on a webhook.
  Changing the interval counts from the last check, so shortening it can make a check due at once. The token the
  updater has handled is kept in `status.json`, so a restart never repeats an old request · confidence 82.
- 2026-11-19 · S4 · `CADDY_UI_UPDATE_INTERVAL` becomes editable (UI wins, D16) and leaves the environment-only list.
  Saved values must be what the shell script understands (`30s`, `5m`, `1h`, `1d` or bare seconds, at least 30s), so
  the UI's check is stricter than its general duration parser, and its minimum drops from 1m to the updater's 30s.
  Resetting writes `interval: null`, handing the choice back to the updater's own environment. The Updates section
  shows the interval the updater says it uses, not the UI's copy of the environment, because the UI container does
  not receive that variable in the example compose · confidence 78.
- 2026-11-19 · S4 · "Newest found" is the pulled image's `org.opencontainers.image.version` label (the git commit for
  the `git` source). The UI does not compare versions or offer a manual "install": the updater already applies new
  versions on its own, so the page reports and lets David trigger a check. A failed pull is now recorded as
  `failed` instead of being read as "up to date" · confidence 80.
- 2026-11-19 · S4 · "Check now" is a form action on the Settings page (like "Measure again"), the interval saves
  through the existing `PATCH /api/settings`; no new API route, no change to a PLAN.md §3.2 contract. The updater
  image gains `jq` to read and write the files · confidence 85.
- 2026-11-19 · S6 · Display preferences (stats range, clock, date format, landing page, theme, sidebar) are stored in
  the existing `settings` table under `pref.` keys, beside the `cfg.` keys. No migration, no new API route: the page
  saves through form actions (`?/prefs`, `?/clearOverrides`) on `/settings`. They are not environment variables, so
  there is no environment value and no `EDITABLE` entry; a missing key is the default, and a value that is not one
  of the choices is ignored · confidence 80.
- 2026-11-19 · S6 · The clock and date format are module state in `lib/format.ts` (`setDisplayFormat`), set from the
  layout's data. They are the same for every request, so there is no per-request leak, and the layout rebuilds the
  page with `{#key}` when they change. This avoids threading a preferences argument through about 50 call sites ·
  confidence 75.
- 2026-11-19 · S6 · Theme and sidebar (D20): a cookie, when present and valid, beats the saved default. The theme
  button now writes a `system` cookie instead of clearing it, otherwise "system" could never override a saved dark
  default. Settings has "Use the saved default here" to drop both cookies in this browser · confidence 78.
- 2026-11-19 · S6 · The landing page applies to `/` only when the request is not `Sec-Fetch-Site: same-origin`
  (typed, bookmarked, external link, reload), so a click on Overview stays on Overview. A reload of Overview with
  another landing page saved goes to the landing page, and a local sign-in without `next` goes there too.
  `/?home` also stays on Overview · confidence 70.
- 2026-11-19 · S6 · The collector's prepared Overview range follows the saved default range (`setDefaultRange`), so the
  default page stays instant whichever range is chosen. `RangeSwitch` leaves `?range=` off only for that default ·
  confidence 82.
- 2026-11-19 · S3 · New API route `GET /api/settings/backup` (a file download cannot be a form action). It answers a
  `.tar.gz` with `caddy-ui.db` (a `VACUUM INTO` copy made in a worker thread on a read-only connection, which in WAL
  mode is a read, so probes keep being written) and the `Caddyfile`; the copy is written next to the database and
  deleted once streamed. 409 while compacting, 507 when the volume has no room for the copy. Signed-in only, like
  every `/api` route. No §3.2 contract changes · confidence 80.
- 2026-11-19 · S3 · Every other S3 action is a form action on the Settings page (`?/diagnose`, `?/helper`, `?/prune`,
  `?/compact`, `?/probeOptions`), as S2 did with `?/measure`, so no further routes. The Caddy helpers apply through the
  editor's existing `PUT /api/caddyfile` with the hash the proposal was worked out on, so a file changed meanwhile
  is refused (409) and Caddy validates first · confidence 82.
- 2026-11-19 · S3 · Four new editable variables through `EDITABLE`: `CADDY_UI_PROBE_TIMEOUT` (1s to 60s; unset or empty
  is the old automatic rule, a third of the interval between 2s and 10s; capped at the probe interval),
  `CADDY_UI_CERT_WARN_DAYS` (1 to 365, default 14), `CADDY_UI_REVISIONS_KEEP` (10 to 10000, default 200) and
  `CADDY_UI_BACKUPS_KEEP` (1 to 10000, default 50). The plan named one "revisions and backups kept" number; they were
  already two numbers (200 and 50), so they stay two settings. Lowering either trims at once · confidence 78.
- 2026-11-19 · S3 · Per-site probe options live in a new table `probe_options` (migration 6, empty, `WITHOUT ROWID`,
  instant on any database), keyed by the site id, which is the hash of the site's addresses: changing a site's
  addresses starts it with default options again. Options: skip (no site or upstream probe; the site and its
  upstreams are recorded as `unknown`, and `/api/sites` gains `probeSkipped`), a path (and query) probed instead of
  the site block's own, and extra statuses that count as up on top of the 502/503/504 rule. Changes are logged in
  `settings_log` under `probe:<first address>` so Recent changes lists them. S6's export should include this table
  · confidence 76.
- 2026-11-19 · S3 · The JSON access log helper does not use a global `log` option, which in Caddy configures runtime
  logs and does not turn on access logs. It adds an `(access_log)` snippet (or reuses one that already writes
  `CADDY_LOG_PATH` as JSON; `caddy_ui_access_log` when the name is taken) and `import`s it at the top of every site
  that has no `log` of its own. Sites with their own `log` elsewhere are left alone and named in the review. It
  writes the UI's `CADDY_LOG_PATH`, which in the example compose file is the same path in both containers; the
  review says so · confidence 74.
- 2026-11-19 · S3 · Compact is `VACUUM` in a worker thread on its own connection, with the collector's jobs held
  (`Collector.hold()` waits for running jobs and pauses new ticks until released), so the main thread never waits on
  the lock. It is refused unless the volume has twice the database's size free. Request-path writes during a
  compact (a settings save, a Porkbun cache write) can wait up to the 5 s busy timeout; the page says probes pause
  while it runs · confidence 72.
- 2026-11-19 · S3 · Diagnostics is one report built from what the server already holds (collector job status, path
  checks, storage facts, S0's slow-load log) plus two live calls: the config service's status (through `adminFetch`)
  and Porkbun `/ping` with `force`. Metrics, the access log and Porkbun count as optional: missing ones are "Check"
  or "Off", not "Problem". A job is late after three missed runs plus a minute · confidence 80.
- 2026-11-19 · S3 · The certificate warning applies everywhere a threshold was hard-coded: Overview's tile and list,
  the Sites column and the site page. The layout passes `certWarnDays`; Overview's cached part is rebuilt when it
  changes · confidence 85.
- 2026-11-19 · S3 · The database size view moved from Monitoring to the new "Data and storage" section with the
  storage tools; the retention field and its "what will be deleted" notice stay in Monitoring. Section order:
  Diagnostics, Monitoring, Data and storage, Caddy helpers, then S2's sections · confidence 78.
