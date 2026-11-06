# Caddy UI — build plan

A self-hosted web UI for Caddy that replaces `zackwag/caddy-ui-frontend` and
`zackwag/caddy-ui-backend` in David's `compose.yml` with one container. It edits the
Caddyfile visually and as text, watches every site block, and shows stats and charts
for the whole server and for each site, using only what Caddy itself exposes.

This file is the source of truth for the build. The coordinator launches one thread
per workstream from the tables below once David approves the plan. Rules for how
threads behave are in [AUTOPILOT.md](AUTOPILOT.md); things David must do are logged in
[TODO-USER.md](TODO-USER.md); choices made on his behalf are logged in
[DECISIONS.md](DECISIONS.md). The paste-able goal for the coordinator is in
[COORDINATOR.md](COORDINATOR.md).

Companion documents:

- [docs/caddy-coverage.md](docs/caddy-coverage.md) — every Caddyfile directive, matcher
  and global option, with what the visual editor must support for each, and which ones
  David's Caddyfile uses today.
- [docs/visual-editor-options.md](docs/visual-editor-options.md) — the visual editor
  approaches that were brainstormed, with the recommendation and the open questions.

## 1. Goals and non-goals

Goals, in David's words, mapped to features:

| Ask | Feature |
| --- | --- |
| Edit, add and remove existing blocks | Sites list with add/duplicate/delete; visual editor per block; global options and snippets editable too |
| Visual editor that supports every Caddy rule | Schema-driven editor covering all 41 standard directives, all 19 matcher types, global options, snippets, named routes, `import`, heredocs, placeholders and env vars, with a raw fallback for plugin directives |
| Text editing with syntax highlighting and a proper editor | CodeMirror 6 with a Caddyfile language mode, lint from the parser and from Caddy's `/adapt`, autocomplete from the schema |
| Check if blocks are online, see elapsed time | Uptime probes per site and per upstream, state history, "up for 4d 2h", cert expiry countdown, Caddy process uptime |
| Stats for the whole server and per block, with graphs | Collector that stores Prometheus metrics, upstream status, access-log aggregates and probe results in SQLite; dashboard and per-site pages with Fishnet charts |
| Auto deploy and watch script, port from env | Updater sidecar that polls for a new image or commit on an interval and redeploys; UI port, admin URL and paths all from env |
| Proper docs and a good README | `README.md` plus `docs/` (install, configuration, architecture, coverage, FAQ, migration from zackwag images) |
| Fishnet design system, colour and font tweaks only | Fishnet tokens and components ported; a `caddy-ui` theme file that overrides only colour and font tokens |
| Replace both zackwag containers | One image, one service in compose, same volumes, drop-in env names where sensible |

Non-goals for v1 (logged so nobody builds them by accident): multi-user accounts and
roles, editing Caddy JSON directly, managing more than one Caddy instance, a plugin
marketplace, certificate issuance outside what Caddy already does, Docker container
management beyond reading status.

## 2. David's environment (facts the build relies on)

- Caddy runs as `caddy:latest` in Docker. Admin API is `admin 0.0.0.0:2019`, reachable
  on the `caddy-ui` bridge network as `http://caddy:2019`. It is not published on the
  host.
- Caddyfile is bind-mounted at `./Caddyfile` → `/etc/caddy/Caddyfile`. Certificates and
  state are in `./data` (mounted as `/data/caddy` in the old backend). Logs dir
  `./logs` → `/var/log/caddy`. `CADDY_LOG_PATH=/var/log/caddy/access.log` is set but the
  Caddyfile has no `log` directive yet, so there is no access log today (see TODO-USER).
- The Caddyfile has a global options block (`servers { trusted_proxies static … }`,
  `admin`, `email`), one snippet (`tinyauth_forwarder`), and about 35 site blocks. Most
  are a single `reverse_proxy` to a `10.0.0.x:port` upstream. The complex ones use
  `handle`, `route`, `handle_errors`, `try_files`, `file_server`, `forward_auth` with
  `uri` and `copy_headers`, `uri strip_prefix`, `rewrite`, `redir` with codes, named
  matchers with `path` and `path_regexp`, regex capture placeholders (`{re.name.1}`,
  `{path.1}`), `reverse_proxy` with `to`, `lb_policy`, active health checks, `transport
  http { tls_insecure_skip_verify, tls_server_name }` and `header_up` with request
  header placeholders. Comments and commented-out directives exist and must survive a
  round trip.
- Auth today is tinyauth (`forward_auth` to `10.0.0.101:8888`, `/api/auth/caddy`).
- Old backend published `9876:3001`, old frontend `9877:80`, with `CADDY_UI_USER`,
  `CADDY_UI_PASSWORD`, `JWT_SECRET` env vars. The new image keeps `CADDY_UI_USER` and
  `CADDY_UI_PASSWORD` so the swap is mostly deleting one service.
- Timezone Europe/Budapest; the UI shows local time with the zone named, per Fishnet's
  content rules.

## 3. Architecture

One SvelteKit application (Node adapter) in one container. SvelteKit server routes are
the API; a background worker inside the same process runs the collector. State lives in
one SQLite file. No separate backend process, no message queue.

```
browser ──► SvelteKit (Node)  ──► Caddy admin API  http://caddy:2019
              │   ├ /api/*               /config/, /adapt, /load, /reverse_proxy/upstreams, /metrics
              │   ├ pages (SSR)
              │   └ collector worker ──► probes (HTTPS to sites, TCP/HTTP to upstreams)
              │                     ──► access log tailer  /var/log/caddy/access.log
              │                     ──► cert reader        /data/caddy/certificates/**
              └ SQLite  /etc/caddy-ui/caddy-ui.db
```

Why SvelteKit: Fishnet was built from a SvelteKit site (Kex1016/fishnet) and its
components are Svelte, so the design system ports with the least loss. One process keeps
the compose change to a single service. Logged in DECISIONS.md.

### 3.1 Packages inside the repo (pnpm workspace)

| Package | Purpose | Owner workstream |
| --- | --- | --- |
| `packages/caddyfile` | Lexer, parser, concrete syntax tree (CST) that keeps comments and whitespace, printer, formatter. Pure TypeScript, no DOM, no Node APIs. | W1 |
| `packages/caddy-schema` | Machine-readable schema of every directive, subdirective, matcher, global option and placeholder, generated from the Caddy docs with a script that can be re-run. | W2 |
| `apps/ui` | The SvelteKit app: pages, API routes, collector worker, SQLite. | W0, W3–W8 |
| `deploy/` | Dockerfile, compose example, updater script, GitHub Actions. | W9 |
| `docs/` | User and developer docs. | W10 |

### 3.2 Contracts between workstreams

These are fixed up front so threads can run in parallel without waiting on each other.
Changing one is allowed but must be recorded in DECISIONS.md and announced to the
coordinator in the same turn.

**CST shape (`packages/caddyfile`)**

```ts
type Caddyfile = { blocks: Block[]; trivia: Trivia[] }            // top-level comments/blank lines
type Block =
  | { kind: 'global';  body: Node[];  span: Span; trivia: Trivia[] }
  | { kind: 'snippet'; name: string; body: Node[]; span: Span; trivia: Trivia[] }
  | { kind: 'named_route'; name: string; body: Node[]; span: Span; trivia: Trivia[] }
  | { kind: 'site';    addresses: Token[]; body: Node[]; span: Span; trivia: Trivia[] }
type Node =
  | Directive            // { kind:'directive', name: Token, matcher?: MatcherRef, args: Token[], body?: Node[], span, trivia }
  | MatcherDef           // { kind:'matcher', name:'@x', body: Node[] | inline: Directive, span, trivia }
  | Raw                  // { kind:'raw', tokens: Token[], body?: Node[] }  (anything the parser can tokenize but not classify)
type Token = { text: string; raw: string; quote: 'none'|'double'|'backtick'|'heredoc'; span: Span }
type Trivia = { kind: 'comment'|'blank'; text: string; span: Span }
```

The printer must reproduce the input byte-for-byte when the tree is unchanged
(`print(parse(x)) === x`). Edits to a node re-print only that node, keeping the file's
indentation style (tabs vs spaces, detected per block). A separate `format()` produces
`caddy fmt` style output. David's choice (DECISIONS.md, 6 Nov): every save through the
UI runs `format()` before writing, so the file on disk is always in `caddy fmt` style;
comments are kept. The byte-exact printer is still required for in-editor diffs, the
revision history and the "unapplied changes" comparison.

**Schema shape (`packages/caddy-schema`)**

```ts
type DirectiveSchema = {
  name: string; summary: string; docsUrl: string;
  category: 'routing'|'handler'|'middleware'|'request'|'response'|'tls'|'logging'|'misc';
  order: number;                    // position in Caddy's default directive order
  matcher: boolean;                 // accepts [<matcher>]
  args: ArgSchema[];                // positional, with optional/variadic flags and value types
  subdirectives?: Record<string, DirectiveSchema>;   // recursive for blocks like transport, handle_response
  allowsDirectives?: boolean;       // handle/route/handle_errors/handle_path bodies
  examples: string[];
}
type ArgSchema = { name: string; type: 'string'|'int'|'duration'|'size'|'status'|'path'|'upstream'|'url'|'header'|'enum'|'regexp'|'cel'|'placeholder'|'matcher'; enum?: string[]; optional?: boolean; variadic?: boolean; doc: string }
type MatcherSchema = { name: string; args: ArgSchema[]; blockForm?: boolean; celForm: string; docsUrl: string }
type GlobalOptionSchema = DirectiveSchema  // same shape, category 'global'
```

Also exported: the default directive order list, the placeholder catalogue
(`{host}`, `{uri}`, `{path.N}`, `{re.name.N}`, `{http.request.header.*}`, `{env.*}`, …),
upstream address forms, duration/size grammars.

**API routes (`apps/ui`)** — all JSON, all under `/api`, all behind auth:

| Route | Purpose |
| --- | --- |
| `GET /api/caddyfile` | Raw text + parsed CST + schema-validated diagnostics |
| `PUT /api/caddyfile` | Body `{ text }`; validates with parser then `POST /adapt`; writes file with backup; applies via `POST /load`; returns diagnostics or the new revision |
| `GET /api/caddyfile/revisions`, `POST …/revisions/:id/restore` | History and rollback (stored in SQLite, last 200) |
| `POST /api/caddyfile/format`, `POST /api/caddyfile/validate` | Format and dry-run validate |
| `GET /api/sites` | Site blocks with current status (up/down/unknown, since, upstreams, cert expiry) |
| `GET /api/sites/:id/stats?range=24h` | Series for charts: requests, errors, latency p50/p95, bytes, probe latency, uptime strip |
| `GET /api/overview` | Server-wide tiles and series |
| `GET /api/caddy/status` | Caddy version, uptime, config hash, admin reachability |
| `GET /api/caddy/upstreams` | Proxy of `/reverse_proxy/upstreams` enriched with the site that owns each upstream |
| `GET /api/schema` | The schema bundle for the editor (cached, versioned) |
| `GET /api/health` | Unauthenticated liveness for the updater and compose healthcheck |

**SQLite tables** (owned by W4, read by W7/W8): `probes(site_id, target, kind, ts, ok,
latency_ms, status, error)`, `state_changes(site_id, ts, from, to)`,
`metric_samples(ts, name, labels_json, value)`, `log_minutes(site_id, minute, requests,
errors_4xx, errors_5xx, bytes_out, p50_ms, p95_ms, top_paths_json, top_ips_json)`,
`certs(host, not_after, issuer, seen_at)`, `revisions(id, ts, author, text, note)`,
`settings(key, value)`.

**Site identity**: a site block is identified by the hash of its address list, so
reordering or editing the body keeps its history; renaming the address creates a new
site and the UI offers to merge history.

**Environment variables** (final names; the README documents them):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADDY_UI_PORT` | `3001` | Port the UI listens on inside the container |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy admin API |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | The file to edit |
| `CADDY_LOG_PATH` | `/var/log/caddy/access.log` | JSON access log to tail (optional) |
| `CADDY_DATA_PATH` | `/data/caddy` | Caddy data dir, for certificate expiry (optional) |
| `CADDY_UI_DATA` | `/etc/caddy-ui` | Where the SQLite DB and backups live |
| `CADDY_UI_USER`, `CADDY_UI_PASSWORD` | unset | Local login; both unset disables local auth |
| `CADDY_UI_AUTH_MODE` | `local` | `local`, `forward` (trust `Remote-User` from tinyauth), or `none` |
| `CADDY_UI_SESSION_SECRET` | random at boot | Cookie signing; set it to keep sessions across restarts |
| `CADDY_UI_PROBE_INTERVAL` | `30s` | Site and upstream probes |
| `CADDY_UI_SCRAPE_INTERVAL` | `15s` | `/metrics` scrape |
| `CADDY_UI_RETENTION_DAYS` | `90` | Raw sample retention; minute rollups kept forever |
| `CADDY_UI_PUBLIC_URL` | unset | Used in links and for the probe's own address |
| `CADDY_UI_UPDATE_INTERVAL` | `1h` | Updater sidecar poll period |
| `CADDY_UI_UPDATE_WEBHOOK_PORT` | unset | Updater listens for a GitHub push webhook when set |
| `CADDY_UI_UPDATE_SOURCE` | `ghcr` | `ghcr` (pull image) or `git` (clone + build) |
| `TZ` | `UTC` | Display timezone |

## 4. What stats a Caddy-only frontend can show

Every number has a source; the UI names it in the tile foot, per Fishnet.

| Source | Needs | Gives |
| --- | --- | --- |
| Admin `GET /config/` | nothing | Running config, so the UI can tell whether the file on disk matches what Caddy runs ("unapplied changes" banner) |
| Admin `POST /adapt` and `POST /load` | nothing | Validation errors with line numbers; apply without restart |
| Admin `GET /reverse_proxy/upstreams` | nothing | Per upstream: active requests, remembered fails (passive health) |
| Admin `GET /metrics` | `metrics { per_host }` in global options (TODO-USER, or the UI offers to add it) | `caddy_http_requests_total`, `caddy_http_request_duration_seconds` histogram, `caddy_http_response_size_bytes`, `caddy_http_requests_in_flight`, `caddy_reverse_proxy_upstreams_healthy`, Go process metrics incl. `process_start_time_seconds` (Caddy uptime), memory, goroutines, open fds. With `per_host` every HTTP metric carries a `host` label, which is what makes per-site charts possible without logs |
| JSON access log | a `log` directive (global or per site; the UI offers to add a snippet) | Per request: host, path, method, status, duration, bytes, remote ip (behind `trusted_proxies`), user agent, TLS version. Rolled up per minute into counts, error rates, latency percentiles, top paths and top client IPs |
| Probes from the UI | network reachability | Site reachable through Caddy (HTTPS GET to the public host, follows the redirect chain), each upstream reachable directly (TCP connect + HTTP HEAD where the scheme is known), latency, state changes with timestamps → "up for 4d 2h 9m", uptime % over 24h/7d/30d |
| Certificate files in `CADDY_DATA_PATH` | the data volume | Expiry per host, issuer, days left, renewal warnings |
| Docker socket (optional, off by default) | `/var/run/docker.sock` mount | Container state, restarts, container logs tail. Only if David opts in (TODO-USER) |

Charts (all Fishnet ChartCard with a table twin): requests per minute, error rate, latency
p50/p95, bytes out, in-flight requests, probe latency, uptime strip per site, upstream
health strip, cert expiry bar list, top paths and top IPs bar lists, server-wide memory
and goroutines.

## 5. Workstreams

Model and effort are sized to the work. "Effort" is the Claude Code effort level
(`low`, `medium`, `high`, `xhigh`). Start conditions reference other workstreams; the
coordinator launches a thread the moment its start condition holds.

| ID | Workstream | Model | Effort | Starts when | Produces |
| --- | --- | --- | --- | --- | --- |
| W0 | Scaffold and shell | Opus | high | plan approved | pnpm workspace, SvelteKit app, Fishnet tokens + base components ported, app shell (sidebar, top bar, theme), auth (local + forward + none), Dockerfile, CI (lint, typecheck, unit tests), `GET /api/health` |
| W1 | Caddyfile parser and printer | Fable | xhigh | plan approved | `packages/caddyfile`: lexer (quotes, backticks, heredocs, env vars, comments), CST, byte-exact printer, node-level edits, `format()`, fixtures incl. David's Caddyfile and every example in the Caddy docs, fuzz round-trip test |
| W2 | Caddy schema | Opus | high | plan approved | `packages/caddy-schema`: generator script reading `caddyserver/website` markdown, schema JSON for 41 directives, 19 matchers, global options, placeholders; coverage test that fails if the docs add a directive the schema lacks |
| W3 | Config service and Caddy client | Opus | high | W0 merged | Admin client, read/validate/apply/backup/rollback, drift detection, revisions table, `/api/caddyfile*`, `/api/caddy/*`, file watcher for external edits |
| W4 | Collector | Opus | high | W0 merged | Probes, metrics scraper, log tailer with minute rollups, cert reader, state-change tracking, retention, SQLite schema and migrations, `/api/sites`, `/api/sites/:id/stats`, `/api/overview` |
| W5a | Visual editor core | Fable | xhigh | W1, W2, W3 merged | Tree + inspector editor (David's choice), Visual \| Text mode switch with an optional split, the inspector form API that W5b builds on, bespoke forms for the 12 directives and 5 matcher forms in David's Caddyfile, matcher builder, placeholder picker, recipes for new blocks, raw fallback, effective-order view, diagnostics panel, generic schema form as the fallback for plugin directives |
| W5b | Bespoke forms for the remaining 29 directives | Opus | high | W5a's form API merged (W5a may merge it as its first PR) | Hand-designed inspector forms for every standard directive W5a does not cover, in batches by category (logging, headers and request shaping, TLS and ACME, static and templates, routing extras), plus the 14 generic matchers, each with examples from the docs and a round-trip test |
| W6 | Text editor | Opus | high | W1, W2 merged | CodeMirror 6 Caddyfile language (Lezer grammar or stream parser backed by W1 tokens), highlighting, folding, bracket matching, lint from W1 + `/adapt`, autocomplete and hover docs from W2, format on demand, diff before apply |
| W7 | Dashboard and stats pages | Opus | high | W4 merged | Overview page, per-site page, charts per Fishnet chart rules, time-range switch, table twins, uptime strips, cert list, upstream list |
| W8 | Sites list and lifecycle | Sonnet | medium | W3, W4 merged | Sites index with status badges and "up for" times, search/filter, add (opens recipe picker from W5 or a blank block), duplicate, delete with confirm, enable/disable (comment out a block), reorder, global options and snippets entry points |
| W9 | Deploy, image and updater | Sonnet | medium | W0 merged (script part can start at plan approval) | Multi-stage Dockerfile, GitHub Actions building `ghcr.io/kex1016/caddy-ui` on push to main and tags, `deploy/compose.example.yml`, `deploy/updater/` (poll GHCR digest or git HEAD every `CADDY_UI_UPDATE_INTERVAL`, `docker compose pull && up -d caddy-ui`, optional webhook on `CADDY_UI_UPDATE_WEBHOOK_PORT`), migration notes from zackwag images |
| W10 | Documentation | Sonnet | medium | drafts at plan approval; final after W5b–W9 | `README.md`, `docs/install.md`, `docs/configuration.md`, `docs/architecture.md`, `docs/editor.md`, `docs/stats.md`, `docs/migration-from-caddy-ui.md`, `docs/faq.md`, screenshots |
| W11 | Integration and QA | Opus | medium | W5a, W5b, W6, W7, W8 merged | Playwright e2e against a real `caddy` container in CI (compose in GitHub Actions), round-trip test of David's Caddyfile through the visual editor, accessibility pass, performance budget |

Parallelism: W0, W1, W2, W9 (script), W10 (drafts) start together. W3, W4, W6 start
when W0 (and for W6, W1 + W2) merge. W5a, W7, W8 follow, then W5b beside W5a. W11 and
the final W10 close.
Peak is five threads at once, which matches "as many as reasonable".

Suggested branch names: `ws/w1-caddyfile-parser`, `ws/w5-visual-editor`, and so on.
One PR per workstream, split into stacked PRs when a thread judges a PR would exceed
about 2,000 changed lines.

### 5.1 Definition of done per workstream

- W1: `print(parse(fixture)) === fixture` for every fixture; parses every `caddy` and
  `caddy-d` code block in the Caddy docs without a `raw` node except where the block is
  deliberately partial; fuzz test passes 10,000 cases.
- W2: schema lists every directive in `caddyfile/directives.md`, every matcher heading in
  `caddyfile/matchers.md` and every option in `caddyfile/options.md`; the generator
  re-run produces no diff; each directive in David's Caddyfile validates clean.
- W3: applying David's Caddyfile unchanged produces no diff on disk and no config change
  in Caddy; a bad edit returns the `/adapt` error with the right line; rollback restores
  the previous revision and reloads Caddy.
- W4: after 10 minutes against a running Caddy the overview shows non-zero requests,
  every site has a probe state, a down upstream shows as down within two intervals.
- W5a: David's Caddyfile opened in the visual editor, every block expanded and saved
  with no changes, writes the `caddy fmt` form of the same file with every comment kept,
  and saving that again changes nothing; the 12 directives and 5 matcher forms David
  uses have bespoke forms; unknown directives show as raw rows and still round-trip.
- W5b: every one of the 41 standard directives and 19 matchers has a bespoke form; each
  form has a test that builds the docs' example and prints it back.
- W6: highlighting covers comments, addresses, directives, matchers, placeholders, env
  vars, quoted and heredoc strings; a syntax error is underlined within 300 ms.
- W7: every chart has a table twin and a source note; empty and stale states follow
  Fishnet; pages render within the performance budget set by W11.
- W8: add, duplicate, disable and delete each round-trip through W1 and apply via W3.
- W9: `docker compose up` with the example file brings up Caddy and the UI; the updater
  redeploys within one interval of a new image.
- W10: a reader can install, configure and migrate from the zackwag images using only
  the docs.
- W11: e2e suite green in CI; axe reports no serious violations.

## 6. Design

Fishnet is the design system (https://claude.ai/artifact/3ZNviWT4q7g5kSbsVaawTK). W0
reads `project/README.md` and `project/tokens.json` from it with the Artifact tool and
ports `tokens.css`, the base and component styles and the Svelte components it needs.
Only colour and font tokens may change, in one file `apps/ui/src/lib/design/theme-caddy.css`
that overrides Fishnet tokens. Proposed tweak, for David to veto in TODO-USER: accent
shifts from Fishnet's sea blue toward Caddy's teal-green (`#1f8a70` light, `#5fd3b4`
dark), headings keep Zen Maru Gothic, body keeps Zen Kaku Gothic New, mono stays
JetBrains Mono. Everything else (grounds, spacing, radius, motion, chart rules,
iconography with Lucide) stays as Fishnet defines it.

Pages: Overview (tiles + server charts), Sites (list), Site (status, charts, editor
entry), Editor (visual | text, per block or whole file), Globals (global options,
snippets, named routes), History (revisions, diff, restore), Settings (auth, intervals,
log and metrics setup helpers), About (Caddy version, UI version, update status).

## 7. Risks and how the plan handles them

- Round-trip fidelity is the whole game. W1 is on the strongest model at the highest
  effort, with David's Caddyfile as the first fixture and a fuzz test.
- The schema drifts from Caddy. W2 ships a generator against the docs repo and a test;
  the updater can re-run it on release.
- Applying a broken config takes every site down. W3 always validates with `/adapt`
  before writing, writes a backup first, and offers one-click rollback. Caddy itself
  keeps the last good config running if `/load` fails.
- Metrics and access logs are off today. W4 works with probes alone and the UI shows an
  explicit "enable metrics" / "enable access logging" helper that proposes the exact
  Caddyfile change.
- The UI edits a file that Caddy also reads. The file watcher in W3 detects external
  edits and asks before overwriting.
- Secrets. Nothing real goes in the repo; compose examples use placeholders; the UI never
  logs env values.

## 8. Milestones

1. Foundations merged: W0, W1, W2 (parallel).
2. Working core: W3, W4, W6, W9 image.
3. The product: W5a, W7, W8, then W5b.
4. Release 1.0: W11 green, W10 final, W9 updater, compose swap in TODO-USER.
