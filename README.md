# Caddy UI

A self-hosted web UI for [Caddy](https://caddyserver.com). Edit your Caddyfile visually or
as syntax-highlighted text, see which sites and upstreams are up and for how long, and get
stats and charts for the whole server and for each site. It is one container that talks to
Caddy's admin API.

It replaces `zackwag/caddy-ui-frontend` and `zackwag/caddy-ui-backend` with a single
`caddy-ui` service.

> **Draft.** This README is written from [PLAN.md](PLAN.md) before the code exists. Parts
> marked `(draft)` describe planned behaviour and are confirmed or corrected in the final
> documentation pass, after the visual editor, collector, dashboard and updater land.

## Features

- **Visual editor** for every standard Caddyfile directive, matcher and global option,
  with a raw fallback for plugin directives. Your comments and formatting survive a round
  trip. See [docs/editor.md](docs/editor.md).
- **Text editor** (CodeMirror) with Caddyfile highlighting, folding, lint from a real
  parser and from Caddy's `/adapt`, and autocomplete from the directive schema.
- **Safe apply**: every change is validated, backed up as a revision, and applied without
  restarting Caddy. One click rolls back. Edits made outside the UI are detected.
- **Status**: per-site and per-upstream probes, state history ("up for 4d 2h"),
  certificate expiry and Caddy uptime.
- **Stats and charts** for the server and each site, from Caddy's metrics, its JSON access
  log, certificate files and the UI's own probes. See [docs/stats.md](docs/stats.md).
- **Updater** sidecar that redeploys the UI when a new image is published.
- Built on the Fishnet design system.

## Quick start (draft)

```yaml
# compose.yml (excerpt) - the full example will live in deploy/compose.example.yml
services:
  caddy-ui:
    image: ghcr.io/kex1016/caddy-ui:latest
    restart: unless-stopped
    ports:
      - "9876:3001"
    environment:
      CADDY_ADMIN_URL: http://caddy:2019
      CADDY_UI_USER: admin
      CADDY_UI_PASSWORD: change-me
      CADDY_UI_SESSION_SECRET: change-me-to-a-long-random-string
      TZ: Europe/Budapest
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./logs:/var/log/caddy:ro
      - ./data:/data/caddy:ro
      - ./caddy-ui:/etc/caddy-ui
    networks:
      - caddy-ui
```

Open `http://<host>:9876`. Full steps, including what Caddy needs
(`admin 0.0.0.0:2019` on a private network, optionally `metrics` and `log`), are in
[docs/install.md](docs/install.md).

## Configuration

All settings are environment variables, for example `CADDY_UI_PORT`, `CADDY_ADMIN_URL` and
`CADDYFILE_PATH`. The complete table is in [docs/configuration.md](docs/configuration.md).

## Development

Needs Node 22 and pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm check        # lint, typecheck, unit tests
pnpm build        # production build of apps/ui
docker build -t caddy-ui .
```

The repo is a pnpm workspace: `apps/ui` is the SvelteKit app (UI and API), `packages/*` hold the
Caddyfile parser and the directive schema. Configuration is by environment variable; see
[docs/configuration.md](docs/configuration.md).

## Documentation

| Guide | What it covers |
| --- | --- |
| [docs/install.md](docs/install.md) | Install, prerequisites, first run, updating |
| [docs/configuration.md](docs/configuration.md) | Every environment variable, auth modes, volumes |
| [docs/architecture.md](docs/architecture.md) | How the pieces fit; for contributors |
| [docs/editor.md](docs/editor.md) | The visual and text editors |
| [docs/stats.md](docs/stats.md) | Where each number comes from and what to enable |
| [docs/migration-from-caddy-ui.md](docs/migration-from-caddy-ui.md) | Swapping the zackwag images for this one |
| [docs/faq.md](docs/faq.md) | Common questions and fixes |
| [docs/caddy-coverage.md](docs/caddy-coverage.md) | Every directive and matcher the editor supports |

Project process documents: [PLAN.md](PLAN.md), [AUTOPILOT.md](AUTOPILOT.md),
[DECISIONS.md](DECISIONS.md), [TODO-USER.md](TODO-USER.md).

## Status

Under construction. The build plan splits the work into parallel workstreams developed
under [AUTOPILOT.md](AUTOPILOT.md).

## License

MIT (to be added with the first release).
