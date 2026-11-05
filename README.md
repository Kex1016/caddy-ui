# Caddy UI

A self-hosted web UI for [Caddy](https://caddyserver.com): edit your Caddyfile visually
or as syntax-highlighted text, see which sites and upstreams are up and for how long, and
get stats and charts for the whole server and for each site, all from one container that
talks to Caddy's admin API.

It is built to replace `zackwag/caddy-ui-frontend` and `zackwag/caddy-ui-backend` with a
single `caddy-ui` service.

## Status

Planning. Nothing runs yet. The build plan is in [PLAN.md](PLAN.md); it splits the work
into parallel workstreams that are developed on autopilot under the rules in
[AUTOPILOT.md](AUTOPILOT.md). Decisions are logged in [DECISIONS.md](DECISIONS.md) and
things the owner must do in [TODO-USER.md](TODO-USER.md).

## Planned features

- Visual editor covering every standard Caddyfile directive, matcher and global option,
  with a raw fallback for plugin directives, and a lossless round trip that keeps your
  comments and formatting.
- Text editor (CodeMirror) with Caddyfile syntax highlighting, folding, lint from a real
  parser and from Caddy's `/adapt`, and autocomplete from the directive schema.
- Validate before apply, backup every revision, one-click rollback, drift detection when
  the file is edited outside the UI.
- Per-site and per-upstream uptime probes, state history ("up for 4d 2h"), certificate
  expiry, Caddy process uptime.
- Dashboards with charts for requests, errors, latency, bytes, in-flight requests,
  upstream health, top paths and client IPs, from Caddy's metrics and JSON access log.
- One image on GHCR, a compose example, and an updater sidecar that redeploys the UI when
  a new version is published.
- Design from the Fishnet design system.

## Documentation

- [docs/caddy-coverage.md](docs/caddy-coverage.md) — what the editor supports.
- [docs/visual-editor-options.md](docs/visual-editor-options.md) — editor design.
- Install, configuration, architecture and migration guides arrive with the
  documentation workstream.

## License

MIT (to be added with the first release).
