# Stats and status

Everything is read from things Caddy already exposes, plus the UI's own probes. Nothing is
installed in the Caddy container. Every chart names its source in its footer, and every chart
has a **Tables** view with the same numbers. Pick the range (1h, 24h, 7d, 30d) at the top.

## Sources

| Source | You need | You get |
| --- | --- | --- |
| Admin `/config/` | nothing | Whether the file on disk matches the running config |
| Admin `/adapt`, `/load` | nothing | Validation with line numbers; apply without restart |
| Admin `/reverse_proxy/upstreams` | nothing | Per upstream: active requests, recent failures |
| Admin `/metrics` | `metrics { per_host }` in global options | Requests, errors, latency, response size, in-flight requests, process start time (Caddy uptime), memory, goroutines. `per_host` adds a host label, which makes per-site charts possible |
| JSON access log | a `log` directive writing JSON to `CADDY_LOG_PATH` | Exact per-request detail, rolled up per minute: counts, 4xx and 5xx, latency percentiles, bytes, top paths, top client IPs |
| UI probes | network reachability | Site reachable through Caddy, each upstream reachable, latency, state changes, uptime |
| Certificate files | `CADDY_DATA_PATH` mounted | Expiry, issuer, days left |

The Docker socket is not used by the UI. (The optional updater sidecar uses it, only to
redeploy `caddy-ui`.)

## What works with nothing enabled

Probes, state history, "up for" times, uptime percentages, upstream status and drift
detection need no change to Caddy. Add `metrics { per_host }` and a JSON `log` for traffic
charts; see [install.md](install.md#1-prepare-caddy). A chart whose source is missing shows an
empty state that names the fix.

## How status is decided

- **Sites** are probed through Caddy itself, with the site's host and TLS name, so a pass
  means the whole path works. Any answer except 502, 503 or 504 counts as up. Redirects to
  the same host are followed. A site with only wildcard or placeholder addresses is judged by
  its upstreams.
- **Upstreams** (from `reverse_proxy`, `forward_auth` and `php_fastcgi`) are probed directly
  from the UI container: a TCP connect, plus an HTTP `HEAD` when the scheme is known. An
  upstream only reachable from inside the Caddy container shows as down.
- **"Up for"** is the time since the last state change. A down upstream shows within two
  probe intervals.
- **Caddy uptime** comes from `process_start_time_seconds` in `/metrics`.

## Charts

Overview: sites and upstreams up and down, requests, error rate, p95 latency, Caddy uptime,
certificates expiring soon, traffic series, busiest sites, memory and goroutines.
Per site: requests, errors (5xx with 4xx as the shadow), latency (p95 with p50 as the shadow),
bytes out, in-flight requests, probe latency, uptime strip, one health strip per upstream,
top paths and top client IPs, certificate expiry.

## Accuracy

- When the access log has data for the window, traffic comes from it and is exact. Otherwise
  it comes from metrics and is approximate. Each series says which.
- Latency over a chart bucket is the request-weighted mean of the per-minute p50 and p95.
  That approximates the true percentile; it is not a percentile of all requests.
- With metrics, Caddy counts a request once per handler, so per host the UI counts only the
  handler with the most requests.
- Top paths and client IPs exist only with an access log. Client IPs are the real address only
  behind `trusted_proxies`.

## Staleness and gaps

A chart is **stale** when its source is failing now or probes are more than three intervals
late. It then shows the last good data and the time of it. Fewer than two points shows the
frame with an empty state. A gap means no data; zero means the source ran and saw nothing.

## How the pages stay fast

The collector does the work, not the page. After every probe cycle it builds what Sites and
the 24-hour Overview show and keeps it in memory, and it rebuilds the site list after every
upstream poll, certificate scan and Caddyfile change. A page load reads that snapshot, so it
costs the same on day 1 and day 90. Other Overview ranges are computed when first asked for,
streamed into the page after its shell (placeholders show until they land), and remembered
for one step of the range, five minutes at most. Sums over days that are over are computed
once and remembered. Caddy's `/reverse_proxy/upstreams` is polled on the scrape timer, never
during a page load.

Every page response carries a `Server-Timing` header: each step with its time in
milliseconds, `snapshot` with the snapshot's age, `tail` with how many bytes of the access
log are not read yet, and `total`. Browser developer tools show it under the request's
Timing tab. A load that takes over 500 ms, streamed parts included, also writes one line to
the container log:

```
caddy-ui: slow load /?range=30d 984 ms: states=0(snapshot) ... traffic=262.6(streamed) ...
```

## Retention and time

Probe results and metric samples are kept `CADDY_UI_RETENTION_DAYS` days (default 90) and then
pruned, a few thousand rows at a time so the pruning never holds up a page. State changes, certificates and the access-log minute rollups are kept. The log
reader starts at the end of an existing log and remembers its position across restarts, so
history before first start is not read. Times use `TZ`, and the zone is named.
