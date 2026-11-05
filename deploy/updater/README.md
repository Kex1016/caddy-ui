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

## Webhook

Set `CADDY_UI_UPDATE_WEBHOOK_PORT`, publish the port, and add a GitHub webhook (push
events, content type JSON, same secret) pointing at `http://your-host:PORT/update`.
Always set a secret if the port is reachable from outside. `GET /healthz` returns `ok`.

## Run it by hand / test it

```sh
CADDY_UI_UPDATE_SOURCE=ghcr ./updater.sh once
./test/run.sh          # behaviour tests against a fake docker
```
