# Configuration

> **Draft.** The variable names and defaults below are the contract from
> [PLAN.md §3.2](../PLAN.md). If a name changes, the change is logged in
> [DECISIONS.md](../DECISIONS.md) and this page is updated in the final pass.

All configuration is by environment variables. The UI never logs their values.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADDY_UI_PORT` | `3001` | Port the UI listens on inside the container |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy admin API |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | The file to edit |
| `CADDY_LOG_PATH` | `/var/log/caddy/access.log` | JSON access log to tail (optional) |
| `CADDY_DATA_PATH` | `/data/caddy` | Caddy data dir, for certificate expiry (optional) |
| `CADDY_UI_DATA` | `/etc/caddy-ui` | Where the SQLite database and backups live |
| `CADDY_UI_USER`, `CADDY_UI_PASSWORD` | unset | Local login; both unset disables local auth |
| `CADDY_UI_AUTH_MODE` | `local` | `local`, `forward` or `none` |
| `CADDY_UI_SESSION_SECRET` | random at boot | Cookie signing; set it to keep sessions across restarts |
| `CADDY_UI_PROBE_INTERVAL` | `30s` | Site and upstream probes |
| `CADDY_UI_SCRAPE_INTERVAL` | `15s` | Caddy `/metrics` scrape |
| `CADDY_UI_RETENTION_DAYS` | `90` | Raw sample retention; minute rollups are kept |
| `CADDY_UI_PUBLIC_URL` | unset | Used in links and for the probe's own address |
| `CADDY_UI_UPDATE_INTERVAL` | `1h` | Updater poll period |
| `CADDY_UI_UPDATE_WEBHOOK_PORT` | unset | Updater listens for a GitHub push webhook when set |
| `CADDY_UI_UPDATE_SOURCE` | `ghcr` | `ghcr` (pull image) or `git` (clone and build) |
| `TZ` | `UTC` | Display timezone |

Durations use Go style: `30s`, `5m`, `1h`.

## Authentication

- **`local`**: username and password from `CADDY_UI_USER` and `CADDY_UI_PASSWORD`. Set
  `CADDY_UI_SESSION_SECRET` so sessions survive restarts.
- **`forward`**: trust the `Remote-User` header set by a forward-auth provider such as
  tinyauth. Only use this when the UI is reachable solely through that proxy.
- **`none`**: no login. Only for a trusted network.

`GET /api/health` is always unauthenticated so health checks work.

## Volumes

See the mount table in [install.md](install.md#2-add-the-service). The UI writes only to the
Caddyfile and to `CADDY_UI_DATA`. Every apply stores a backup revision first (last 200
kept).

## Updater

The updater is a separate sidecar, not part of the UI container. Its variables are the
`CADDY_UI_UPDATE_*` ones above. (Draft: exact service definition arrives with W9.)
