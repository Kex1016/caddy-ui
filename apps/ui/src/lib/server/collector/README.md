# Collector (W4)

Background worker inside the UI process, started from `hooks.server.ts` `init`. Each job runs on its own timer:

| Job | Every | Reads | Writes |
| --- | --- | --- | --- |
| Site list | each probe cycle, when the Caddyfile mtime changes | `CADDYFILE_PATH` | `sites` |
| Probes | `CADDY_UI_PROBE_INTERVAL` | sites through Caddy (Host + SNI to the admin URL's host), upstreams by TCP (+ HEAD when the scheme is known) | `probes` and `probe_latest` in one transaction, `state_changes` |
| Metrics | `CADDY_UI_SCRAPE_INTERVAL` | `CADDY_ADMIN_URL/metrics` | `metric_samples` (per minute) |
| Upstream health | `CADDY_UI_SCRAPE_INTERVAL` | `CADDY_ADMIN_URL/reverse_proxy/upstreams` (with `adminFetch`) | memory only (`Collector.live`) |
| Access log | 5s, in 1 MB slices (8 MB a tick) with a yield between them | `CADDY_LOG_PATH` (JSON) | `log_minutes`, `settings.collector.log_position` |
| Certificates | 1h | `CADDY_DATA_PATH/certificates/**.crt` | `certs` |
| Retention | 1h, in batches of 5,000 rows | | prunes `probes`, `metric_samples`, stale `probe_latest` rows |

## Read side and snapshot (S0)

`views.ts` shapes rows into the API payloads. `snapshot.ts` keeps them ready: after each probe cycle the
collector rebuilds the sites payload and the default (24 h) Overview, and the sites payload again after each
upstream poll, certificate scan and site list change (`Collector.onChange`). Pages, `/api/sites` and
`/api/overview` read the snapshot. Other Overview ranges are computed on first request (streamed into the page
with `Timing.defer`, computed at once for the API) and kept for one step of the range, five minutes at most.
Sums over whole days that are over (`topLists`, `requestsBySite`) are remembered per database and forgotten
when a write lands in that day. States come from `Collector.currentStates`, the latest probe per target from
`probe_latest`, and the 24 h uptime of every site from one query (`siteSpans`). Every request carries
`locals.timing`; `hooks.server.ts` turns it into a `Server-Timing` header and logs loads over 500 ms.

Choices and their reasons are in `DECISIONS.md` (entries tagged W4).

## API

All responses are JSON, `cache-control: no-store`, behind auth. Times are ms since the epoch. A series is
`{ source: 'metrics' | 'logs' | 'probes' | null, points: [bucketStart, value | null][] }`; `null` means no data
for that bucket (source off or scrape failed), `0` means the source ran and saw nothing. `source: null` means
the series has no source at all, which pages should show as Fishnet's empty state and name the fix (enable
`metrics { per_host }` or a `log` directive). Every payload has `sources`, the health of each data source:
`caddyfile`, `probes`, `metrics` (`perHost`), `logs` (`found`, `lastEntry`), `certs`.

`range` is `1h` (1 min buckets), `24h` (5 min, default), `7d` (1 h) or `30d` (6 h); anything else is a 400.

### `GET /api/sites`

`{ asOf, sites: SiteView[], sources }`, sites in Caddyfile order. `SiteView`:
`id`, `addresses`, `label` (first address), `line` (1-based, in the Caddyfile), `status` (`up | down | unknown`),
`since` (when it entered that status, for "up for 4d 2h"), `probe` (latest: `target, ts, ok, latencyMs, status,
error`), `upstreams[]` (`address, via, status, since, probe, activeRequests, fails`; the last two come live from
`/reverse_proxy/upstreams` and are null when the admin API is unreachable), `cert` (`host, notAfter, issuer,
daysLeft` or null), `uptime24h` (0–1 or null).

### `GET /api/sites/:id/stats?range=`

404 for an unknown id. `{ asOf, site: { id, addresses, removedAt }, range, from, to, stepMs, totals, series,
uptime, upstreams, top, sources }`:
- `totals`: `requests, errors4xx, errors5xx, bytesOut, latencyP50, latencyP95` over the window (null when unknown).
- `series`: `requests, errors4xx, errors5xx, latencyP50, latencyP95, bytesOut, inFlight, probeLatency`.
- `uptime`: `{ ratio, strip: { t, state: 'up'|'down'|'mixed'|'unknown', upRatio }[] }`, one cell per bucket.
- `upstreams`: `{ address, uptime, strip }[]`.
- `top`: `{ paths: [path, count][], ips: [ip, count][] }` from the access log, or null without one.

### `GET /api/overview?range=`

`{ asOf, range, from, to, stepMs, tiles, series, topSites, top, certs, sources }`:
- `tiles.sites` / `tiles.upstreams`: `{ up, down, unknown }` (+ `total` for sites).
- `tiles.requests`, `tiles.errorRate` (5xx / requests, 0–1), `tiles.latencyP95`: `{ value, source }`.
- `tiles.caddyStartedAt`: `{ value, source }` from `process_start_time_seconds`, for Caddy's uptime.
- `tiles.certs`: `{ count, soonest, expiringSoon, warnDays }`.
- `series`: the traffic series for the whole server plus `memory` and `goroutines`.
- `topSites`: `{ siteId, label, requests, source }[]`, busiest ten.
- `certs`: every certificate, soonest expiry first.
