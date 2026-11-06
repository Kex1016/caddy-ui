# Testing

How the project is tested, and how to run each layer locally. CI runs all of it on every
pull request (`.github/workflows/ci.yml`).

| Layer | Where | Runs against | CI job |
| --- | --- | --- | --- |
| Unit tests | `pnpm test` (vitest, every package) | Fakes | Lint, typecheck, test, build |
| Config service | `apps/ui`, `pnpm --filter @caddy-ui/ui test:caddy` | A real Caddy admin API | Config service against Caddy 2.10 and 2 |
| Formatter differential | `packages/caddyfile/test/caddy-differential.test.ts` | A real `caddy` binary | Formatter against caddy fmt and caddy adapt |
| End to end | `e2e/` (Playwright, Chromium) | The built UI and a real Caddy | E2E in Chromium against Caddy 2.10 and 2 |
| Collector | `deploy/ci/collector-check.sh` | Docker image + Caddy with traffic | Collector against a real Caddy |
| Install and compose swap | `deploy/ci/install-smoke.sh` | Docker image + Compose | Install docs and compose swap |

Caddy is tested at two versions: 2.10 (the oldest supported) and `caddy:2`, which is the
same image as `caddy:latest`.

## End to end

The suite starts Caddy and the built UI itself (`e2e/support/stack.mjs`), with local auth on,
and loads David's anonymised Caddyfile
(`packages/caddy-schema/test/fixtures/sample-home.Caddyfile`) with three global options added
so a runner can serve it (`auto_https off`, ports 18080 and 18443).

```sh
pnpm build
CADDY_BIN=/path/to/caddy pnpm --filter @caddy-ui/e2e e2e        # caddy binary started by the suite
CADDY_ADMIN_URL=http://127.0.0.1:2019 pnpm --filter @caddy-ui/e2e e2e   # a Caddy you started
```

What it covers:

- **Round trip** (`roundtrip.spec.ts`): the Caddyfile opened in the visual editor, every row
  opened in the inspector, nothing changes; **Format** then **Review and apply** writes exactly
  `format()` of the file, keeps every comment, gives the same config in Caddy and does not
  reload it; after that **Format** finds nothing to do; a form edit changes exactly one line on
  disk and in Caddy's running config.
- **Rows** (`rows.spec.ts`): a rows field writes a row only once its required columns are
  filled, and clearing a cell to retype it keeps the line and the comment above it.
- **Sites** (`sites.spec.ts`): add from a recipe, duplicate, disable, enable and delete, each
  checked on disk and in Caddy; an edit made elsewhere gives a conflict, not an overwrite.
- **History** (`history.spec.ts`): Caddy refuses a bad edit and nothing changes; restoring a
  revision rewrites the file and reloads Caddy.
- **Pages** (`pages.spec.ts`): every page renders without console errors and passes axe
  (WCAG 2.1 A and AA) with no serious or critical violations, in light and dark.
- **Performance** (`perf.spec.ts`): the budget below.

## Performance budget

Cold load, cache off, against the ~35-site Caddyfile. The limits are about twice what a
GitHub runner measures, so they catch regressions rather than noise.

| Page | First byte | Load event | JavaScript | Everything |
| --- | --- | --- | --- | --- |
| Overview, Sites, Site, History | 500 ms | 1.5 s | 120 KB | 600 KB |
| Editor | 500 ms | 2 s | 450 KB | 1.4 MB |

Sizes are bytes over the wire (`encodedBodySize`). The editor must also show the whole
outline with its directive docs within 2 s, and one keystroke in a form must reach the
outline within 300 ms. Measured locally at the time of writing: first byte about 20 ms, load
about 0.1 s, 55 KB of JavaScript on the stats pages and 226 KB on the editor.

## Formatter differential

`format()` must produce exactly what `caddy fmt` produces, because every save is written
with it. The test runs both on every Caddy docs example, the package fixtures and David's
anonymised Caddyfile, and checks that `caddy adapt` gives the same JSON before and after.
Known differences are listed in the test with their reason.

```sh
CADDY_BIN=/path/to/caddy pnpm --filter @caddy-ui/caddyfile exec vitest run test/caddy-differential.test.ts
```

Without `CADDY_BIN` the test is skipped.

## Screenshots

The README screenshots in `docs/screenshots/` are taken by a Playwright script against a demo
version of the e2e stack. It is not part of the test suite or CI. To retake them after a UI
change:

```sh
pnpm build
CADDY_BIN=/path/to/caddy pnpm --filter @caddy-ui/e2e screenshots
```

Run it as root in a throwaway container or VM: `e2e/screenshots/demo.mjs` binds port 443 and
adds the sample's `10.0.0.x` addresses to the loopback interface so stub upstreams can answer
on them (two stay down on purpose). It starts the stack from `demoCaddyfile()` in
`e2e/support/paths.mjs`, which is the anonymised sample plus `metrics { per_host }` and
certificates from Caddy's internal CA. It then appends a made-up access log for the last 24
hours (client IPs from the documentation ranges) and keeps a trickle of real requests going for
the metrics charts. `e2e/screenshots/capture.spec.ts` waits for the probes and a metrics scrape,
then writes each page in light and dark. The README shows the dark versions to readers whose
GitHub theme is dark.

