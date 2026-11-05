# Migrating from `zackwag/caddy-ui-frontend` and `-backend`

> **Draft** from [PLAN.md §2](../PLAN.md) and [DECISIONS.md](../DECISIONS.md). The final
> compose snippet comes from `deploy/compose.example.yml` (W9).

The goal is a delete and a rename, not a rewrite: one `caddy-ui` service replaces both old
services and keeps the same volumes and most env names.

## What changes

| Old | New |
| --- | --- |
| Two services: `caddy-ui-backend` (host port 9876 → 3001) and `caddy-ui-frontend` (9877 → 80) | One service `caddy-ui`, port `9876:3001` |
| `CADDY_UI_USER`, `CADDY_UI_PASSWORD` | Same names, same meaning |
| `JWT_SECRET` | Replaced by `CADDY_UI_SESSION_SECRET` |
| `CADDY_LOG_PATH` | Same name |
| Frontend on its own port | Gone; the one service serves the UI and API |

## Steps

1. **Back up** your Caddyfile and the old UI's data directory.
2. Tag `v1.0.0` of the image must exist. Check that `ghcr.io/kex1016/caddy-ui` is public or
   that the host has a pull secret.
3. In `compose.yml`, **remove** `caddy-ui-backend` and `caddy-ui-frontend`.
4. **Add** the `caddy-ui` service from `deploy/compose.example.yml`. Keep your Caddyfile,
   logs and data mounts. Set `CADDY_UI_USER`, `CADDY_UI_PASSWORD` and a long random
   `CADDY_UI_SESSION_SECRET`. Remove `JWT_SECRET`.
5. Keep Caddy's admin API on `admin 0.0.0.0:2019`, reachable only on the shared network.
6. `docker compose up -d`. Open port 9876 and sign in.
7. Check the first screen: it should say the file matches the running config. If your
   proxy referenced port 9877, point it at 9876 instead.

## What does not carry over

History and settings kept by the old backend are not imported. The new UI starts its own
history from the first apply. (Draft: confirm whether an import is worth building.)

## Rolling back

Put the two old services back and remove `caddy-ui`. The Caddyfile is the same file, so
nothing else needs undoing. Your revisions stay in `CADDY_UI_DATA`.
