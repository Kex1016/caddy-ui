# Stats and status

> **Draft** from [PLAN.md §4](../PLAN.md). Confirmed against the running collector (W4) and
> dashboard (W7) in the final pass.

Everything is read from things Caddy already exposes. Nothing is installed in the Caddy
container. Every number in the UI names its source.

## Sources

| Source | You need | You get |
| --- | --- | --- |
| Admin `/config/` | nothing | Whether the file on disk matches the running config |
| Admin `/adapt`, `/load` | nothing | Validation with line numbers; apply without restart |
| Admin `/reverse_proxy/upstreams` | nothing | Per upstream: active requests, recent failures |
| Admin `/metrics` | `metrics { per_host }` in global options | Request counts, duration histogram, response size, in-flight requests, healthy upstreams, process uptime, memory, goroutines. `per_host` adds a host label, which makes per-site charts possible |
| JSON access log | a `log` directive writing to `CADDY_LOG_PATH` | Per request detail, rolled up per minute: counts, error rates, latency percentiles, top paths, top client IPs |
| UI probes | network reachability | Site reachable through Caddy, each upstream reachable, latency, state changes, uptime over 24h, 7d and 30d |
| Certificate files | `CADDY_DATA_PATH` mounted | Expiry, issuer, days left |
| Docker socket (opt-in) | `/var/run/docker.sock` mounted read-only | Container state, restarts, logs. Off by default because it grants host-level access |

## What works with nothing enabled

Probes, state history, "up for" times, drift detection and upstream status work with no
changes to Caddy. Enable metrics and access logging for the rest; Settings offers the exact
Caddyfile change for each.

## Charts

Requests per minute, error rate, latency p50 and p95, bytes out, in-flight requests, probe
latency, uptime strip per site, upstream health strip, certificate expiry list, top paths,
top client IPs, server memory and goroutines. Each chart has a table view and a source note.

## Retention

Raw samples are kept `CADDY_UI_RETENTION_DAYS` days (default 90). Minute rollups are kept.
Times are shown in the zone set by `TZ`, and the zone is named.

## Empty and stale states

A chart with no data tells you which source is missing and how to enable it. A source that
stopped updating is marked stale rather than shown as zero.
