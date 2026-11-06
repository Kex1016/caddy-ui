# Architecture

For contributors. [PLAN.md](../PLAN.md) holds the contracts; [DECISIONS.md](../DECISIONS.md)
holds the reasons and any later changes.

## Shape

One SvelteKit application (Node adapter) in one container. Server routes are the API. A
background collector in the same process probes sites, scrapes metrics and tails the access
log. State is one SQLite file. There is no separate backend and no queue.

```
browser ──► SvelteKit (Node)  ──► Caddy admin API  http://caddy:2019
              │   ├ /api/*              /config, /adapt, /load, /reverse_proxy/upstreams, /metrics
              │   ├ pages (SSR)
              │   └ collector ──► probes, access-log tailer, certificate reader
              └ SQLite  (CADDY_UI_DATA)

caddy-ui-updater (separate, optional) ──► docker compose pull / up caddy-ui
```

## Packages

| Path | Purpose |
| --- | --- |
| `packages/caddyfile` | Lexer, parser, syntax tree that keeps comments and whitespace, byte-exact printer, `caddy fmt` style formatter, edit helpers |
| `packages/caddy-schema` | Machine-readable schema of directives, matchers, global options and placeholders, generated from the Caddy docs; a CI job reports drift weekly |
| `apps/ui` | The SvelteKit app |
| `deploy/` | Compose example, updater sidecar, CI helpers |
| `Dockerfile` | Image build at the repo root |

Inside `apps/ui/src/lib`:

| Folder | Contents |
| --- | --- |
| `server/config` | Caddy admin client, read, validate, apply, backup, restore, drift detection |
| `server/collector` | Probes, metrics scraper, log tailer, certificate reader, retention |
| `server/db` | One SQLite module with append-only migrations |
| `server/sites` | Text splices for add, duplicate, disable, delete and reorder |
| `visual` | Visual editor: document model, forms, recipes, matcher builder, components |
| `editor` | Text editor: CodeMirror language, lint, completion, diff |
| `design` | Fishnet tokens, components and charts; `theme-caddy.css` holds the colour and font overrides |

## Key ideas

- **The text is the document.** Every visual edit changes the syntax tree, prints it and
  parses the result again, so the outline always shows what the text says. Nodes are
  addressed by path, so a selection survives a re-parse. Visual, Text and Split are views of
  one document.
- **Forms are declarative.** An inspector form is a list of fields with `get` and `set` over
  a directive node. Bespoke forms register by name under `lib/visual/forms`; the schema
  generates a fallback form, and raw text is the last resort. A test fails if the schema gains
  a directive or matcher without a bespoke form.
- **Validate, back up, then apply.** Parser and `/adapt` check the text, the old file is
  copied, the file is written in `caddy fmt` style, and `/load` applies it. Caddy keeps its
  last good config if a load fails.
- **Site identity** is a hash of the address list, so editing a body keeps its history.
- **Every number has a source.** See [stats.md](stats.md).

## API

All JSON under `/api`, behind auth except `/api/health`. The routes are listed in
[PLAN.md §3.2](../PLAN.md); the collector routes are described in
[`lib/server/collector/README.md`](../apps/ui/src/lib/server/collector/README.md). Pages
(Overview, Sites, Site, Editor, Globals, History, Settings, About) read the same services
in-process.

## Data

SQLite tables: `revisions`, `settings` (config service); `sites`, `probes`, `state_changes`,
`metric_samples`, `log_minutes`, `certs` (collector). Probes and metric samples are pruned
after `CADDY_UI_RETENTION_DAYS`; minute rollups from the log, state changes, sites and
certificates are kept.

## Development

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm check          # lint, typecheck, unit tests
```

CI also builds the image, runs the config service and the collector against a real Caddy, and
tests the updater against a fake Docker. Fixtures never contain secrets: the sample Caddyfile
uses `10.0.0.x` addresses and has any key-like lines removed. Regenerate the schema with the
script in `packages/caddy-schema`.
