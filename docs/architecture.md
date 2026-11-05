# Architecture

> **Draft** for contributors, summarising [PLAN.md §3](../PLAN.md). The plan is the source
> of truth until the code lands.

## Shape

One SvelteKit application (Node adapter) in one container. Server routes are the API. A
background worker in the same process runs the collector. State is one SQLite file. There is
no separate backend and no queue.

```
browser ──► SvelteKit (Node)  ──► Caddy admin API  http://caddy:2019
              │   ├ /api/*
              │   ├ pages (SSR)
              │   └ collector ──► probes, access-log tailer, certificate reader
              └ SQLite  (CADDY_UI_DATA)
```

## Packages

| Path | Purpose |
| --- | --- |
| `packages/caddyfile` | Lexer, parser, concrete syntax tree that keeps comments and whitespace, byte-exact printer, formatter |
| `packages/caddy-schema` | Machine-readable schema of directives, matchers, global options and placeholders, generated from the Caddy docs |
| `apps/ui` | The SvelteKit app: pages, API, collector, SQLite |
| `deploy/` | Dockerfile, compose example, updater, GitHub Actions |
| `docs/` | These documents |

## Key ideas

- **The editor edits the syntax tree, not text.** The visual and text editors are two views
  of one document, so switching is lossless. `print(parse(x)) === x` for unchanged input.
- **Validate, back up, then apply.** A change is parsed, checked with Caddy's `/adapt`,
  stored as a revision, written to disk and loaded with `/load`. Caddy keeps the last good
  config if a load fails.
- **Site identity** is a hash of the address list, so editing a body keeps its history.
- **Stats have named sources.** See [stats.md](stats.md).

## API

All JSON under `/api`, behind auth except `/api/health`. The route list is in
[PLAN.md §3.2](../PLAN.md).

## Data

SQLite tables: `probes`, `state_changes`, `metric_samples`, `log_minutes`, `certs`,
`revisions`, `settings`. Raw samples are pruned after `CADDY_UI_RETENTION_DAYS`; minute
rollups are kept.

## Development

(Draft: setup, `pnpm` scripts, test commands and the fixture policy are added by W0 and
confirmed in the final pass. Fixtures never contain secrets.)
