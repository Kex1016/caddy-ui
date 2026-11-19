# caddy-ui updater

A small sidecar that keeps the `caddy-ui` service current. It only ever touches that one
service (`docker compose pull && docker compose up -d --no-deps caddy-ui`); Caddy itself
is never restarted by it.

Why a sidecar: a container cannot safely replace itself, and this keeps the UI image
free of the Docker socket.

## What it does

1. Every `CADDY_UI_UPDATE_INTERVAL` (and immediately on a webhook) it checks for a new
   version.
   - `ghcr` (default): `docker compose pull caddy-ui`, redeploys if the image ID changed.
   - `git`: fetches `CADDY_UI_UPDATE_GIT_URL`/`CADDY_UI_UPDATE_GIT_BRANCH`, rebuilds if
     HEAD moved, redeploys.
2. Waits up to `CADDY_UI_UPDATE_HEALTH_TIMEOUT` seconds (default 90) for the container's
   healthcheck (`/api/health`).
3. If it never becomes healthy, retags the previous image and recreates the container.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADDY_UI_UPDATE_INTERVAL` | `1h` | `30s`, `5m`, `1h`, `1d`; minimum `30s` |
| `CADDY_UI_UPDATE_SOURCE` | `ghcr` | `ghcr` or `git` |
| `CADDY_UI_UPDATE_WEBHOOK_PORT` | unset | Listen for `POST /update` on this port |
| `CADDY_UI_UPDATE_WEBHOOK_SECRET` | unset | GitHub webhook secret (HMAC) or `Authorization: Bearer` token |
| `CADDY_UI_UPDATE_SERVICE` | `caddy-ui` | Service name in your compose file |
| `CADDY_UI_UPDATE_HEALTH_TIMEOUT` | `90` | Seconds to wait before rolling back |
| `CADDY_UI_UPDATE_GIT_URL` / `_GIT_BRANCH` | repo / `main` | `git` source only |
| `CADDY_UI_UPDATE_CHANNEL_DIR` | `./caddy-ui/updater` | Folder shared with the UI (see below) |
| `CADDY_UI_UPDATE_POLL` | `5` | Seconds between looks at `control.json` |

## Talking to the UI

The Settings page of the UI changes the interval and asks for a check through a folder both
containers share (no port, no Docker socket in the UI). The UI writes `control.json`; the updater
reads it every `CADDY_UI_UPDATE_POLL` seconds and writes `status.json` and `last-run.json`.

```jsonc
// control.json (UI -> updater)
{ "version": 1, "interval": "5m",   // or null: use CADDY_UI_UPDATE_INTERVAL
  "checkNow": "9f2c4a1e0b7d3a55",   // a token; a new one means "check now"
  "writtenAt": "2026-11-19T12:00:00.000Z" }

// status.json (updater -> UI)
{ "version": 1, "updatedAt": "...", "source": "ghcr", "pollSeconds": 5, "checking": false,
  "intervalSeconds": 3600, "intervalFrom": "env",   // or "control"
  "nextCheckAt": "...", "checkNowHandled": "9f2c4a1e0b7d3a55", "warning": null,
  "latest": { "version": "1.1.0", "id": "sha256:..." },
  "lastRun": { "startedAt": "...", "finishedAt": "...", "trigger": "timer",
               "result": "up-to-date", "message": "..." } }
```

`result` is `up-to-date`, `updated`, `rolled-back`, `needs-attention` or `failed`. An interval in
`control.json` that is not `30s`/`5m`/`1h`/`1d` (or under 30s) is ignored, with a `warning`.
A "check now" token that was already handled is not run again after a restart.
The "newest version" is the image's `org.opencontainers.image.version` label (or the git
commit for the `git` source).

## Webhook

Set `CADDY_UI_UPDATE_WEBHOOK_PORT`, publish the port, and add a GitHub webhook (push
events, content type JSON, same secret) pointing at `http://your-host:PORT/update`.
Always set a secret if the port is reachable from outside. `GET /healthz` returns `ok`.

## Run it by hand / test it

```sh
CADDY_UI_UPDATE_SOURCE=ghcr ./updater.sh once
./test/run.sh          # behaviour tests against a fake docker
```
