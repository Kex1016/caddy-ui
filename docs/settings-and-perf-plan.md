# Faster pages and a Settings page — plan

Planning only. Nothing in this file is built yet. It extends [PLAN.md](../PLAN.md) the same
way [porkbun-plan.md](porkbun-plan.md) does: [AUTOPILOT.md](../AUTOPILOT.md) for how threads
behave, [DECISIONS.md](../DECISIONS.md) for choices with a confidence score,
[TODO-USER.md](../TODO-USER.md) for what only David can do. Workstreams here are named
**S0–S5**.

Two asks from David (19 Nov 2026):

1. Overview and Sites take around 15 seconds to load in his deployment.
2. System settings, mainly what environment variables configure today, should be changeable
   in the UI. Plus ideas for what else the Settings page could hold.

Questions for David are collected in [§4](#4-questions-for-david). Everything else proceeds
on the recommended option once he says "build it".

## 1. Why the pages are slow

### 1.1 What both pages do

Overview (`routes/+page.server.ts`) calls `overview()` and `sitesPayload()`. Sites
(`routes/sites/+page.server.ts`) calls `sitesPayload()` and reads the Caddyfile. Both pages
are server-rendered, so the browser shows nothing new until the whole `load` has finished.
`sitesPayload()` (`lib/server/collector/index.ts`) is the part they share:

| Step | Cost |
| --- | --- |
| `loadStates(db)` | Indexed, about 0 ms. Runs twice on Overview. |
| `latestProbes(db)` | **Reads the whole `probes` table.** See below. |
| `allCerts(db)` | Tiny. |
| `liveUpstreams(adminUrl)` | One `adminFetch` to `/reverse_proxy/upstreams`, 2 s timeout, cached 5 s. |
| `stateSpans()` per site | Two indexed queries per site, about 0 ms each. |

No Porkbun call sits in either page's `load`. The Sites page asks `/api/porkbun/caddy` for
its DNS column from the browser after it has rendered.

### 1.2 Likely causes, ranked

**1. `latestProbes` scans every probe ever stored (likelihood: high).**
The query is `SELECT site_id, target, MAX(ts) FROM probes GROUP BY site_id, target`, joined
back to `probes`. The only indexes are `(site_id, ts)` and `(ts)`, so SQLite walks every row
to find the newest one per target. The table gets one row per site and one per upstream
every 30 seconds: about 200,000 rows a day with 35 sites, 1.4 million after a week, 18
million at the 90-day retention.

Measured on a synthetic database with the real schema (35 sites, one upstream each, in a
cloud VM with a warm cache):

| Probe rows | Days of running | `latestProbes` | Database size |
| --- | --- | --- | --- |
| 1.4 million | 7 | 1.6 s | 200 MB |
| 6.0 million | 30 | 7.0 s | 860 MB |
| 18 million (projected) | 90 | about 21 s | about 2.6 GB |

Every other query on the two pages measured under 0.15 s on the same data. The time grows by
the day, which fits "it was fine at first". David's 15 seconds after about a week is higher
than the 1.6 s measured here, so either his disk and CPU are several times slower than the
VM (likely for a home server reading a 200 MB+ file that does not fit the page cache), or
causes 2 and 3 stack on top. S0 starts by measuring on his box to settle that.

**2. SQLite calls block the whole server (likelihood: high as a multiplier).**
`better-sqlite3` is synchronous. While one scan runs, every other request waits, including
the next page navigation. Both pages re-run their `load` every 30 seconds while a tab is
visible (`autoRefresh`), and Overview and Sites each start their own scan. One open tab plus
one click is two scans back to back. Two tabs make it three.

**3. Nothing is shared or remembered between requests (likelihood: certain, medium cost).**
`sitesPayload()` rebuilds everything on every call, although the data only changes when the
collector finishes a probe cycle. The collector already holds the current states in memory
(`Collector.states`) and sees every probe result as it writes it; the pages re-read both
from disk.

**4. The page waits for the admin API (likelihood: low for David, up to 2 s).**
`liveUpstreams` runs inside `load`. If Caddy's admin API is slow or down, every load waits
up to 2 seconds, and a failed answer is cached for only 5 seconds.

**5. Tables that grow without bound (likelihood: low today, rising).**
`requestsBySite` filters `log_minutes` by minute, but the table's only index starts with
`site_id`, so it scans the table (0.03 s at 7 days, kept forever by design). `topLists`
parses two JSON columns per minute of the range: 86,000 small JSON documents for the 30-day
view. Raw probes alone reach about 2.6 GB at 90 days.

**6. Ruled out.** Porkbun (not in either `load`), the Caddyfile read (one small file), chart
rendering (the wait is before the first byte), and tinyauth's `forward_auth` hop (one fast
request per page).

Why CI did not catch it: the performance budget in the e2e suite runs against a database
that is minutes old.

### 1.3 Fixes

In order. Each is small; together they make both loads independent of how long the UI has
been running.

- **A. Measure first.** Add a `Server-Timing` header and a log line for any `load` over
  500 ms, with one entry per step (`states`, `latestProbes`, `live`, `spans`, `traffic`,
  `top`). Confirms the ranking on David's box before and after, and stays in as a diagnostic.
- **B. Latest probe per target without a scan.** New small table `probe_latest`
  (`site_id, target` primary key), upserted in the same transaction that inserts the probe
  rows. `latestProbes` reads about 70 rows. No backfill: the table fills on the first probe
  cycle after the upgrade (30 s), and status itself comes from `state_changes`, which is
  unaffected.
- **C. One snapshot per probe cycle.** The collector builds the `sitesPayload` and the
  default Overview snapshot after each cycle and keeps them in memory. Page loads and
  `/api/sites` return the snapshot. Other ranges (`1h`, `7d`, `30d`) are computed on demand
  and remembered for one step of that range. `uptime24h` for all sites becomes one query.
- **D. Take the admin API out of the request path.** The collector refreshes
  `/reverse_proxy/upstreams` on the scrape timer with `adminFetch`; pages read the last
  answer and its age.
- **E. Stop the growth.** Add `log_minutes (minute)` index. Keep raw probe rows for a short
  window and an hourly summary for the full retention (question Q3). Prune in batches so the
  hourly delete never holds the server for long.
- **F. Show the page before the numbers, if still needed.** If a load can still exceed
  300 ms after A–E (first request after a restart, 30-day range), return the slow parts as
  streamed promises with skeletons so navigation is instant. Decided by the numbers from A.
- **G. Keep it fixed.** A unit-level performance test seeds 90 days of probes for 35 sites
  and fails if `sitesPayload` or `overview('24h')` takes more than 200 ms. The e2e budget
  stays as is.

Expected result: both pages answer in tens of milliseconds regardless of database age.

## 2. Settings page

### 2.1 Inventory of environment variables

"Live" means a change in the UI takes effect without a restart.

| Variable | Read by | Plan | Why |
| --- | --- | --- | --- |
| `CADDY_UI_PROBE_INTERVAL` | UI | **Editable, live** | Collector re-arms its timer. |
| `CADDY_UI_SCRAPE_INTERVAL` | UI | **Editable, live** | Same. |
| `CADDY_UI_RETENTION_DAYS` | UI | **Editable, live** | Read at each prune. Lowering it shows how much will be deleted first. |
| `TZ` | UI | **Editable, live** | Display only; every formatter already takes the zone as a parameter. |
| `CADDY_UI_PUBLIC_URL` | UI | **Editable, live** | Used for links and the secure-cookie check. |
| `CADDY_UI_PORKBUN_READONLY` | UI | **Editable, live**, with a guard | Can always be switched on. Can be switched off only when the UI has a sign-in (forward or local). |
| `CADDY_UI_PORKBUN_CACHE_TTL` | UI | **Editable, live** | Cache reads the value per lookup. |
| `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` | UI and Caddy | Shown as set or unset, **env only** (Q2) | Caddy reads the same pair from its own environment for the DNS challenge. A UI-only copy would drift from it. |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | UI | Shown, **env only** | A deliberate deploy-time opt-in to hand out a private key. |
| `PORKBUN_API_URL` | UI | Shown, **env only** | Test and IPv4 knob. |
| `CADDY_UI_AUTH_MODE`, `CADDY_UI_USER`, `CADDY_UI_PASSWORD`, `CADDY_UI_SESSION_SECRET` | UI | Shown (secrets as set or unset), **env only** | A mistake locks David out, and whoever reaches the UI must not be able to turn sign-in off. |
| `CADDY_ADMIN_URL` | UI | Shown with a **Test** button, **env only** | Describes container wiring; changes together with compose. |
| `CADDYFILE_PATH`, `CADDY_LOG_PATH`, `CADDY_DATA_PATH`, `CADDY_UI_DATA` | UI | Shown with a health check (exists, readable, writable), **env only** | They name mounts; a new value means a new mount, which is a compose change anyway. |
| `CADDY_UI_PORT` (and adapter-node's `PORT`, `HOST`, `ORIGIN`) | UI entry point | Shown, **env only** | The listener, the compose port mapping and the health check must agree. David's 9876 stays where it is. |
| `CADDY_UI_UPDATE_INTERVAL`, `_SOURCE`, `_WEBHOOK_PORT`, `_WEBHOOK_SECRET`, `_SERVICE`, `_HEALTH_TIMEOUT`, `_GIT_URL`, `_GIT_BRANCH` | Updater sidecar | Shown read-only in the first build (S4 makes interval and "check now" editable) | Another container reads them; the UI needs a channel to it first. |
| `CADDY_UI_TAG`, `CADDY_UI_HOST_PORT`, `CADDY_UI_COMPOSE_DIR`, `CADDY_UI_BUILD_CONTEXT` | Compose | Not shown | Compose variables, not app settings. |

So seven variables become editable in the first build, and every other one is visible on the
same page with its current value, where it comes from, and a health check where one makes
sense. The About page's table moves here.

### 2.2 How it works

- **Storage.** The existing `settings` key/value table in SQLite (migration 1), keys under
  `cfg.`, values validated by the same parsers as `env.ts` so messages match. A new
  `settings_log` table records who changed what and when (old and new value).
- **Precedence** (Q1). Recommended: a variable set in the environment wins and its field is
  locked with the note "Set by `NAME` in the environment". Unset variables are editable; the
  order is environment, then saved setting, then default. The page offers "Reset to default"
  per field.
- **Applying.** `config()` returns the effective config. A settings service validates, saves
  and notifies subscribers (`Collector.reconfigure()`, the Porkbun cache). All seven
  editable settings apply live, so the first build needs no "restart required" state.
- **Bad stored values.** A saved value that no longer validates (for example after a
  downgrade) is ignored with a warning in the log and on the page. Only a bad environment
  variable stops the container, as today.
- **Who may change settings.** Any signed-in identity, as with the Caddyfile. When the UI
  has no sign-in at all (mode `none`, or `local` with no user), settings can still be
  changed except for the one that loosens security (`CADDY_UI_PORKBUN_READONLY` off).
- **Secrets.** Never stored in the database, never sent to the browser, shown as set or
  unset. Nothing changes here in the first build.
- **API.** `GET /api/settings` (effective values, source, editable or not) and
  `PATCH /api/settings`. These are new §3.2 contracts and get their own DECISIONS entry when
  built.
- **Docs.** `docs/configuration.md` gains a column for "also in Settings" and the precedence
  rule.

### 2.3 Page layout

One page, sections in this order: **Monitoring** (probe interval, scrape interval,
retention, database size), **Display** (time zone, public URL), **Domains** (read-only
switch, cache TTL, key status with a "Test connection" button that runs `/ping`),
**Connections** (admin URL, paths, each with its check), **Sign-in** (mode and what is set),
**Updates** (updater values), **Recent changes** (the settings log). Fishnet components
only; each section saves on its own.

## 3. More ideas for the Settings page

Grouped by how much they are worth. The first group is recommended for the build after the
core; the rest are a menu for David (Q4).

**Recommended next**

- **Diagnostics.** One "Check everything" button: admin API reachable and its version,
  metrics on and per-host or not, access log found and last entry, data directory readable,
  Porkbun ping and key scopes, collector job status, and the slowest recent page loads from
  fix A.
- **Caddy helpers.** One-click edits to the global options through the normal review and
  apply flow: turn on `metrics { per_host }`, turn on the JSON access log at the path the UI
  tails. The Settings stub already promises these.
- **Data and storage.** Database size per table, "prune now", "compact database", number of
  Caddyfile revisions and backups kept (200 today, fixed), download a backup (database plus
  Caddyfile).
- **Monitoring thresholds.** Certificate warning days (14, fixed today), probe timeout, and
  per-site probe options: skip a site, probe a path other than `/`, treat a given status as
  up.

**Worth considering**

- **Notifications.** A webhook (ntfy, Discord, generic JSON) when a site goes down or comes
  back, a certificate is close to expiry, the Caddyfile changed outside the UI, or an update
  was applied or rolled back. The largest item here and the one most people expect from a
  status page.
- **Editor preferences.** Format on save (exists as a server option, not exposed), default
  to Visual or Text, ask before reloading Caddy.
- **Display preferences.** Default stats range, 12 or 24 hour clock, theme and sidebar (both
  are cookies today), default landing page.
- **Updates.** Current and latest version, last updater run and result, "check now", update
  interval. Needs the updater to read a small file the UI writes into the shared compose
  directory (S4).
- **Domains defaults.** Default TTL for new records, "clear Porkbun cache", and the cache
  age.
- **Export and import settings** as one JSON file, for moving to another host.

**Possible, with a cost**

- **Change the local password in the UI** (stored as a hash, replacing `CADDY_UI_PASSWORD`).
  Not useful with forward auth, which David runs.
- **API tokens** for scripts that call `/api/*` without a browser session.
- **Session length and "sign everyone out".**
- **Danger zone.** Reset statistics, reset all settings.

Out of scope as before: renewals, WHOIS contacts, email forwarding, dynamic DNS.

## 4. Questions for David

Decisions under about 70. Work can start on S0 without any of them.

- **Q1 · Environment or UI, which wins?** (confidence 65) Recommended: the environment wins
  and locks the field. Compose stays the source of truth, and a broken saved value can
  always be overridden from compose. The cost: to edit something in the UI that your compose
  sets today, you first remove that line from compose. The alternative is "UI wins, the
  environment is only the starting value", which is more convenient and makes "I changed
  compose and nothing happened" possible.
- **Q2 · Porkbun keys in the UI?** (confidence 60) Recommended: no, they stay in the
  environment, shown as set or unset with a test button. Caddy needs the same keys in its
  own environment for the DNS challenge, so a key typed into the UI would only half-apply,
  and it would put a secret in the SQLite file. The alternative is to accept that and allow
  it for the UI's own calls.
- **Q3 · Keep raw probe results for 7 days instead of 90?** (confidence 62) Recommended:
  yes, with an hourly summary (checks, failures, average and slowest latency) kept for the
  full `CADDY_UI_RETENTION_DAYS`. Up, down and uptime history are unaffected because they
  come from state changes, which are kept forever. What is lost: per-probe latency points
  older than a week (charts for 30 days already show 6-hour steps). What is gained: the
  database stays near 250 MB instead of growing to about 2.6 GB. This changes what the
  retention variable means, hence the question.
- **Q4 · Which extras from §3?** (confidence 55) Recommended: the four under "Recommended
  next", and notifications as its own later workstream. Say which others you want.

## 5. Decisions already taken

| # | Decision | Confidence |
| --- | --- | --- |
| D1 | `latestProbes` is fixed with a small `probe_latest` table written with each probe cycle, not with a third index on `probes` (which would make the largest table bigger and still scan the whole index: 0.65 s at 6 million rows). | 85 |
| D2 | No backfill of `probe_latest`; it fills within one probe interval after the upgrade, so the migration is instant on a large database. | 80 |
| D3 | Page loads read a snapshot the collector builds after each probe cycle; they do not query per request. | 82 |
| D4 | The admin API is polled by the collector with `adminFetch`, never from a page `load`. | 85 |
| D5 | SQLite stays on the main thread. With D1–D4 no request-path query is slow enough to justify a worker thread. | 78 |
| D6 | Streaming with skeletons (fix F) is built only if the timings from fix A still show loads over 300 ms after B–E. | 72 |
| D7 | Settings live in the existing `settings` table under `cfg.` keys, with a `settings_log` table for changes. No settings file on disk. | 85 |
| D8 | Sign-in settings, paths, the admin URL and the port stay environment-only and are shown read-only with health checks. | 85 |
| D9 | The Porkbun read-only switch can be loosened from the UI only when the UI has a sign-in. | 80 |
| D10 | `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` stays environment-only. | 75 |
| D11 | A saved setting that fails validation is ignored with a warning instead of stopping the container. | 85 |
| D12 | The About page's configuration table moves to Settings; About keeps version and uptime. | 75 |
| D13 | Updater settings are read-only in the first build; editing them waits for S4. | 75 |
| D14 | Changing the local password in the UI is not in the first build. | 72 |

## 6. Workstreams

| # | Workstream | Depends on | Model, effort | Done when |
| --- | --- | --- | --- | --- |
| S0 | Fast Overview and Sites: fixes A–E and G, F if the numbers ask for it | none | Opus, high | Seeded 90-day test under 200 ms; `Server-Timing` on both pages; David's pages load in under a second |
| S1 | Settings core: effective config, settings service, live re-configuration, `/api/settings`, settings log | none (touches `env.ts` and `Collector`, so it merges after S0) | Opus, high | Seven settings change live with unit tests; bad stored values are ignored; contracts logged |
| S2 | Settings page: sections from §2.3, checks and test buttons, About table moved, docs | S1 | Sonnet, medium | Page passes axe and the e2e budget; `docs/configuration.md` updated |
| S3 | Extras "Recommended next": diagnostics, Caddy helpers, storage, thresholds | S2 | Opus, medium | Each has an e2e spec |
| S4 | Updater channel: interval and "check now" from the UI | S2 | Sonnet, medium | Optional; only if David picks it in Q4 |
| S5 | Notifications | S2 | Opus, high | Optional; only if David picks it in Q4 |

S0 and S1 can run at the same time if S1 rebases after S0 merges; they share
`collector/worker.ts` and `collector/index.ts`. S0 needs none of the answers in §4 except Q3
for the probe summary, and ships without that part if Q3 is still open.

One optional thing David can do to speed up S0: open Overview with the browser's network
panel and note the time of the document request, and run
`docker compose exec caddy-ui ls -la /etc/caddy-ui` to show the database size. That tells us
at once whether cause 1 explains all 15 seconds.
