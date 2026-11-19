# Testing

How the project is tested, and how to run each layer locally. CI runs all of it on every
pull request (`.github/workflows/ci.yml`).

| Layer | Where | Runs against | CI job |
| --- | --- | --- | --- |
| Unit tests | `pnpm test` (vitest, every package) | Fakes | Lint, typecheck, test, build |
| Config service | `apps/ui`, `pnpm --filter @caddy-ui/ui test:caddy` | A real Caddy admin API | Config service against Caddy 2.10 and 2 |
| Formatter differential | `packages/caddyfile/test/caddy-differential.test.ts` | A real `caddy` binary | Formatter against caddy fmt and caddy adapt |
| End to end | `e2e/` (Playwright, Chromium) | The built UI, a real Caddy and a fake Porkbun | E2E in Chromium against Caddy 2.10 and 2, and against the plugin Caddy |
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
- **Domains** (`porkbun-*.spec.ts`): the Porkbun pages against a fake Porkbun, below.

### Domains and the fake Porkbun

The stack also starts a fake Porkbun API (`e2e/support/porkbun-fake.mjs`) and points the UI at it with
`PORKBUN_API_URL` and the fake keys of `fixtures/seed.json`. It is the in-memory fake the unit tests use
(`apps/ui/src/lib/server/porkbun/fake.ts`), served over HTTP, so no e2e test reaches the real API. Specs reset
and arrange it through `/__fake/*` (see the file's header) with the helpers in `e2e/support/porkbun.ts`.

- **Domains** (`porkbun-domains.spec.ts`): filters, search, bulk auto-renew with per-domain results, the
  Overview tab against Porkbun's data, Activity, a key without the `dns` permission, API access off, and a
  domain outside the account (404, never sent to Porkbun).
- **DNS** (`porkbun-dns.spec.ts`): add, edit and delete through the pending-changes tray and **Review and
  apply**; invalid input refused before any call; a batch Porkbun stops halfway reports what failed and keeps
  the rest pending; export, then import into an empty zone, gives the same records.
- **History and Registry** (`porkbun-registry.spec.ts`): a nameserver change refused while preflight reports
  DNSSEC, an allowed one behind the typed domain, glue added and deleted, a restore with its dry run and its
  undo.
- **Forwarding and SSL** (`porkbun-forwarding-ssl.spec.ts`): a forward added, refused a second time and
  deleted; the certificate details of a throwaway certificate made with `openssl` for the run, the chain
  download with `no-store`, and the private key refused while `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` is off.
- **Caddy tie-in** (`porkbun-caddy.spec.ts`): the plugin readout, the site-to-record cross-check, a record
  fixed from the Sites list, and the wildcard hint. With `CADDY_TEST_PORKBUN_PLUGIN=present` (the
  **E2E in Chromium against the plugin Caddy** job, on the `caddy-porkbun:ci` image) the hint writes
  `tls { dns porkbun { … } }` and Caddy loads it; on stock Caddy the hint says the plugin is missing and
  offers nothing Caddy would refuse.

To run against a local plugin build:

```sh
xcaddy build --with github.com/caddy-dns/porkbun
CADDY_BIN=./caddy CADDY_TEST_PORKBUN_PLUGIN=present pnpm --filter @caddy-ui/e2e e2e
```

**Porkbun sandbox (optional).** The CI job **Domains area against the Porkbun sandbox** runs
`porkbun-sandbox.spec.ts` against the real API with a sandbox key (`pk1_sb_…`, which touches nothing real),
and only reads. It runs when the repository has the secrets `PORKBUN_SANDBOX_API_KEY` and
`PORKBUN_SANDBOX_API_SECRET_KEY`; without them it skips every step and passes. Locally:
`E2E_PORKBUN=sandbox PORKBUN_SANDBOX_API_KEY=… PORKBUN_SANDBOX_API_SECRET_KEY=… pnpm --filter @caddy-ui/e2e e2e tests/porkbun-sandbox.spec.ts`.
The stack refuses a key that is not a sandbox key in this mode.

## Performance budget

Cold load, cache off, against the ~35-site Caddyfile. The limits are about twice what a
GitHub runner measures, so they catch regressions rather than noise.

| Page | First byte | Load event | JavaScript | Everything |
| --- | --- | --- | --- | --- |
| Overview, Sites, Site, History | 500 ms | 1.5 s | 120 KB | 600 KB |
| Domains, Domain overview, Domain Caddy | 500 ms | 1.5 s | 120 KB | 600 KB |
| Domain DNS | 500 ms | 1.5 s | 150 KB | 600 KB |
| Domains with 1,000 domains | 1 s | 2 s | 120 KB | 800 KB |
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

