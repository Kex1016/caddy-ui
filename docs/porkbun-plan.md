# Porkbun integration — build plan

Adds a **Domains** area to Caddy UI that manages David's existing Porkbun domains through
the [Porkbun API v3](https://porkbun.com/api/json/v3/spec) (spec version 3.107 was read for
this plan), and ties it to the `caddy-dns/porkbun` plugin his Caddy is now built with.

This file extends [PLAN.md](../PLAN.md) (§9 points here). The same rules apply:
[AUTOPILOT.md](../AUTOPILOT.md) for how threads behave, [DECISIONS.md](../DECISIONS.md) for
choices (now with a confidence score), [TODO-USER.md](../TODO-USER.md) for what only David
can do. Workstreams here are named **P0–P7** so they never clash with W0–W11.

## 1. What exists today

- **Caddy side.** David's Caddy image is built with
  `xcaddy build --with github.com/caddy-dns/porkbun`, and the `caddy` service gets
  `PORKBUN_API_KEY` and `PORKBUN_API_SECRET_KEY` from compose. That gives Caddy one ability:
  solving ACME DNS-01 challenges (wildcard certificates, certificates for hosts not reachable
  on port 80/443) by creating `_acme-challenge` TXT records. It manages nothing else.
- **UI side.** Nothing Porkbun-specific. The `tls` form has a free-text "DNS provider" and
  "Provider credentials" field (`apps/ui/src/lib/visual/forms/directives/tls.ts`), so
  `dns porkbun { … }` can be typed but is not guided, and the global `acme_dns` option has
  only the generic schema form. The `caddy-ui` container does not receive the Porkbun keys.
- **CI.** Every Caddy job uses the stock `caddy` image, which rejects `dns porkbun`
  (`module not registered: dns.providers.porkbun`). Tests of the tie-in need a Caddy built
  with the plugin.

So the plugin does not give the UI domain management; that is new work. It does mean the
keys and the env names already exist, and the plan reuses both.

## 2. Scope

"Fully manage my existing domains" is read as: everything Porkbun lets an account holder
change on a domain they already own, except things that spend money or belong to a
different product.

| Area | Porkbun endpoints | In this build |
| --- | --- | --- |
| Connection check | `/ping` (returns key scopes and the server's public IP) | Yes |
| Domain list and detail | `/domain/listAll`, `/domain/get/{domain}` | Yes: status, expiry, auto-renew, lock, privacy, API access, labels |
| DNS records | `/dns/retrieve*`, `/dns/create`, `/dns/edit`, `/dns/editByNameType`, `/dns/delete`, `/dns/deleteByNameType` | Yes: all 14 types (A, AAAA, MX, CNAME, ALIAS, TXT, NS, SRV, TLSA, CAA, SSHFP, HTTPS, SVCB, DS), notes, TTL, priority |
| DNS undo | `/dns/history`, `/dns/diff/{domain}/{snapshotId}`, `/dns/restore` | Yes: restore points, diff against live, restore with or without prune |
| DNS safety check | `/dns/preflight/{domain}` | Yes: shown on demand and run automatically before nameserver and DNSSEC changes |
| DNS import | `/dns/import`, `/dns/scan` | Yes, import only from a pasted BIND zone file or JSON; scan is offered as "discover records" |
| DNSSEC | `/dns/getDnssecRecords`, `/dns/createDnssecRecord`, `/dns/deleteDnssecRecord` | Yes |
| Nameservers | `/domain/getNs`, `/domain/updateNs` | Yes, with "back to Porkbun defaults" |
| Glue records | `/domain/getGlue`, `/domain/createGlue`, `/domain/updateGlue`, `/domain/deleteGlue` | Yes |
| URL forwarding | `/domain/getUrlForwarding`, `/domain/addUrlForward`, `/domain/deleteUrlForward` | Yes |
| Auto-renew | `/domain/updateAutoRenew` | Yes, per domain and in bulk |
| SSL bundle | `/ssl/retrieve/{domain}` | Yes: certificate details and chain download; private key download is off unless enabled by env |
| Pricing and balance | `/pricing/get`, `/account/balance`, `/account/apiSettings` | Read-only: renewal price next to expiry, account credit |
| Renewals | `/domain/renew` | No (David, 18 Nov) |
| Contacts (WHOIS) | `/domain/getContacts`, `/domain/updateContacts` | No (David, 18 Nov) |
| Email forwarding | `/email/getForwards`, `/email/addForward`, `/email/deleteForward` | No (David, 18 Nov) |
| Dynamic DNS | `/ping` + `/dns/editByNameType` on a timer | No (David, 18 Nov) |
| Registration, transfers, closeouts, marketplace, aftermarket | `/domain/create`, `/domain/transfer*`, `/closeout/*`, … | No: not "existing domains", and they charge |
| Hosting, WordPress, Link in Bio, mailboxes, Cloudflare move, agent naming, webhooks, API key management, top-ups | `/hosting/*`, `/linkinbio/*`, `/email/*Mailbox`, `/cloudflare/*`, `/ans/*`, `/webhook/*`, `/apikey/*`, `/account/topup*` | No: other products |

A domain that was moved to Cloudflare through Porkbun still appears; Porkbun returns a
`warnings` entry on every `/dns/*` call for it, and the UI shows that text as written
rather than managing the Cloudflare zone.

## 3. Architecture

```
browser ──► SvelteKit server ──► Porkbun API   https://api.porkbun.com/api/json/v3   (global fetch, header auth)
              │   /api/porkbun/*
              │   lib/server/porkbun/   client · cache · audit · validation
              ├──► Caddy admin API      http://caddy:2019                            (adminFetch, unchanged rule)
              └ SQLite  porkbun_cache, porkbun_audit
```

- **The keys never reach the browser.** Only server routes call Porkbun. The client sends
  `X-API-Key` / `X-Secret-API-Key` headers (never keys in a JSON body), so request bodies
  can be logged in the audit table safely. Keys are read from env only; they are never
  written to SQLite, to a revision, to a log line or to an error message. A unit test
  greps every thrown error and audit row for the key values.
- **`adminFetch` stays the rule for Caddy.** Every call to Caddy's admin API in this work
  goes through `lib/server/caddy/admin-fetch.ts`. Porkbun calls use Node's `fetch`; the
  Sec-Fetch-Mode problem is specific to Caddy.
- **One client module** (`lib/server/porkbun/client.ts`) is the only file that performs
  HTTP to Porkbun. It does: GET for reads and POST for writes, a 15 s timeout, an
  `Idempotency-Key` on every POST, URL-encoding of every path segment, one retry of a read
  after a 429 honouring `Retry-After`, and mapping of error bodies to
  `PorkbunError { code, message, httpStatus, nextAction, requestId }`. Code branches on
  `code` and `next_action.retryable`, never on `message`.
- **Domain names are validated against the account.** A `[domain]` route parameter must be
  in the cached `/domain/listAll` result before any call is made with it.
- **Cache.** Domain list, records, nameservers and similar reads are cached in SQLite for
  `CADDY_UI_PORKBUN_CACHE_TTL` (default 60 s) with a "refreshed 40 s ago · Refresh" control
  (Fishnet `AsOf`). Every write invalidates the keys it touches. Stale cache is served with
  a notice when Porkbun is unreachable or rate limited.
- **Audit.** Every write appends to `porkbun_audit`: who, when, domain, action, the request
  (without keys), the state before, the result and Porkbun's `requestId`. The Domains area
  shows it as an activity list; where Porkbun has no undo, "before" is what makes a manual
  undo possible.
- **Sandbox.** A key starting with `pk1_sb_` is a Porkbun sandbox key: nothing real is
  touched. The UI shows a "Sandbox" tag in the Domains header when it sees one.

### 3.1 Safety rules for writes

These apply to every workstream that builds a write.

1. Every change goes through a review step that shows before and after, the same pattern
   as "Review and apply" in the editor. Nothing is sent on a single click.
2. Where Porkbun supports `dryRun` (DNS record writes, `/domain/updateNs`, `/dns/restore`,
   `/dns/import`), the review step runs the dry run first and shows its result.
3. Destructive or hard-to-reverse actions need the domain name typed: deleting records by
   name and type, changing nameservers, deleting a DNSSEC record, restore with `prune`,
   deleting glue. Deleting one record needs a plain confirm.
4. A nameserver change runs `/dns/preflight?intent=move-nameservers` and refuses while
   there are blockers (for example active DNSSEC). Adding DNSSEC runs
   `intent=enable-dnssec`.
5. `warnings` from Porkbun are shown as written. A write that "succeeded" on a zone
   Porkbun's nameservers do not serve says so.
6. Records Caddy depends on are marked: `_acme-challenge` TXT records ("managed by Caddy")
   and any A/AAAA/CNAME/ALIAS a site block in the Caddyfile resolves through. Editing or
   deleting one shows which sites it would affect.
7. `DUPLICATE_RECORD` adopts the existing id; `RECORD_CONFLICT` lists
   `conflictingRecords`; `ZONE_RECORD_LIMIT`, `API_ACCESS_DISABLED`, `DOMAIN_NOT_ALLOWED`,
   `IP_NOT_ALLOWED` and `INSUFFICIENT_SCOPE` each get a message that says what David has
   to change at Porkbun, with the link from `next_action.url`.
8. Controls outside the key's scopes (from `/ping`) are disabled with the reason, not
   hidden. `CADDY_UI_PORKBUN_READONLY=true` disables every write. With
   `CADDY_UI_AUTH_MODE=none` read-only is the default and must be switched off explicitly.

### 3.2 Contracts

Fixed here so P1–P6 can run in parallel. P0 implements them; changing one needs a
DECISIONS.md entry and a note to the coordinator, as in PLAN.md §3.2.

**Environment variables**

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` | unset | Same names the `caddy` service uses, so one `.env` entry serves both. Both unset: the Domains area shows how to set it up and makes no calls. One unset: the area reports which one is missing; the rest of the UI runs |
| `PORKBUN_API_URL` | `https://api.porkbun.com/api/json/v3` | Base URL. `https://api-ipv4.porkbun.com/api/json/v3` forces IPv4; tests point it at a local fake |
| `CADDY_UI_PORKBUN_READONLY` | `false` (`true` when auth mode is `none`) | Disables every write |
| `CADDY_UI_PORKBUN_CACHE_TTL` | `60s` | How long reads are cached |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | `false` | Allows downloading the private key of the Porkbun-issued certificate |

**Server module** `apps/ui/src/lib/server/porkbun/` (owned by P0; others import, never edit)

```ts
// index.ts
export function porkbun(): Porkbun                 // process-wide; throws PorkbunNotConfigured
export function porkbunStatus(): Promise<PorkbunStatus>
export function requireDomain(name: string): Promise<DomainSummary>   // 404 if not in the account
export function requireWritable(scope: PorkbunScope): void            // 403 in read-only mode or without the scope
export function audit(entry: AuditInput): void
export function cached<T>(key: string, load: () => Promise<T>, opts?: { force?: boolean }): Promise<Cached<T>>
export function invalidate(...prefixes: string[]): void               // keys are '<domain>:<area>', e.g. 'example.com:dns'

// client.ts — one method per endpoint in §2, grouped: ping, domains, dns, dnssec, ns, glue, forwards, ssl, pricing, account
// errors.ts — PorkbunError, PorkbunNotConfigured, PorkbunUnreachable; toResponse(err) for +server.ts files
// fake.ts   — in-memory Porkbun for unit tests, seeded from fixtures/ (captured from Porkbun's /mock server)
```

**Shared types** `apps/ui/src/lib/api/porkbun.ts` (owned by P0)

```ts
type PorkbunScope = 'read'|'dns'|'domains'|'email'|'hosting'|'purchase'|'funding'|'account'
type PorkbunStatus = { state: 'off'|'misconfigured'|'ok'|'error'; missing?: string; sandbox: boolean; readonly: boolean;
                       scopes: PorkbunScope[]; publicIp?: string; error?: ApiError }
type DomainSummary = { domain: string; tld: string; status: string; createDate: string; expireDate: string;
                       autoRenew: boolean; securityLock: boolean; whoisPrivacy: boolean; apiAccess: boolean;
                       notLocal: boolean; labels: { id: string; title: string; color: string }[] }
type DnsRecordType = 'A'|'AAAA'|'MX'|'CNAME'|'ALIAS'|'TXT'|'NS'|'SRV'|'TLSA'|'CAA'|'SSHFP'|'HTTPS'|'SVCB'|'DS'
type DnsRecord = { id: string; name: string /* FQDN */; host: string /* '' = apex */; type: DnsRecordType;
                   content: string; ttl: number; prio: number | null; notes: string | null }
type DnsRecordInput = { host: string; type: DnsRecordType; content: string; ttl?: number; prio?: number; notes?: string }
type Cached<T> = { data: T; fetchedAt: number; stale: boolean }
type ApiError = { code: string; message: string; hint?: string; url?: string; retryable: boolean; requestId?: string }
type WriteResult<T = unknown> = { ok: true; data: T; warnings: string[]; auditId: number } | { ok: false; error: ApiError }
type DryRun = { wouldSucceed: boolean; warnings: string[]; error?: ApiError }
```

Porkbun returns numbers as strings and flags as `0`/`1`; the client converts them, so no
other file deals with that.

**API routes**: all JSON, under `/api/porkbun`, behind the existing auth and same-origin
check. `:d` is the domain.

| Route | Owner | Purpose |
| --- | --- | --- |
| `GET /api/porkbun/status` | P0 | `PorkbunStatus` |
| `GET /api/porkbun/audit?domain=` | P0 | Activity list |
| `GET /api/porkbun/domains`, `GET …/domains/:d` | P1 | List and detail, with renewal price |
| `PUT …/domains/:d/auto-renew`, `PUT /api/porkbun/auto-renew` | P1 | One domain, or many |
| `GET /api/porkbun/account` | P1 | Balance and API spend settings |
| `GET, POST …/domains/:d/dns`, `PUT, DELETE …/dns/:id`, `POST …/dns/preview`, `POST …/dns/batch`, `POST …/dns/import`, `GET …/dns/export` | P2 | Records. `preview` is the dry run; `batch` applies a reviewed list of creates, edits and deletes in order and reports per item |
| `GET …/domains/:d/history`, `GET …/history/:id/diff`, `POST …/history/:id/restore`, `GET …/preflight?intent=` | P3 | Restore points and the safety check |
| `GET, PUT …/domains/:d/nameservers`, `GET, POST …/glue`, `PUT, DELETE …/glue/:host`, `GET, POST …/dnssec`, `DELETE …/dnssec/:keytag` | P3 | Registry settings |
| `GET, POST …/domains/:d/forwards`, `DELETE …/forwards/:id`, `GET …/ssl`, `GET …/ssl/download?part=chain\|key` | P4 | URL forwarding and the SSL bundle |
| `GET /api/porkbun/caddy` | P5 | Whether Caddy has the plugin, which sites use DNS-01, and the site-to-record cross-check |
| `POST /api/porkbun/caddy/records` | P5 | Create or fix the record a site needs |

**SQLite** (migration 3, owned by P0; later Porkbun tables are appended by the workstream
that needs them, one migration each, never by editing migration 3)

```sql
CREATE TABLE porkbun_cache (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE porkbun_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, author TEXT NOT NULL,
  domain TEXT NOT NULL, action TEXT NOT NULL, request_json TEXT NOT NULL, before_json TEXT,
  ok INTEGER NOT NULL, result_json TEXT NOT NULL, request_id TEXT);
```

**Pages and file ownership.** P0 creates the route tree with the layout, the tab bar and a
placeholder page per tab. After P0 merges, each workstream only edits its own folders.

| Path (under `apps/ui/src/`) | Owner |
| --- | --- |
| `lib/server/porkbun/**`, `lib/api/porkbun.ts`, `lib/server/env.ts`, `lib/server/db/migrations.ts`, `lib/nav.ts`, `hooks.server.ts` | P0 |
| `lib/porkbun/components/**` (shared UI: `ReviewDialog`, `TypedConfirm`, `ScopeGate`, `PorkbunNotice`, `RecordValue`) | P0 |
| `routes/domains/+layout*`, `routes/domains/[domain]/+layout*`, `routes/api/porkbun/status`, `routes/api/porkbun/audit`, `routes/domains/activity` | P0 |
| `routes/domains/+page*`, `routes/domains/[domain]/+page*` (Overview tab), `routes/api/porkbun/domains/+server.ts`, `…/domains/[domain]/+server.ts`, `…/auto-renew`, `…/account` | P1 |
| `routes/domains/[domain]/dns/**`, `routes/api/porkbun/domains/[domain]/dns/**`, `lib/porkbun/records/**` (per-type forms, validation, zone file parser) | P2 |
| `routes/domains/[domain]/history/**`, `routes/domains/[domain]/registry/**`, the matching `routes/api/porkbun/domains/[domain]/{history,preflight,nameservers,glue,dnssec}/**` | P3 |
| `routes/domains/[domain]/forwarding/**`, `routes/domains/[domain]/ssl/**`, the matching API folders | P4 |
| `packages/caddy-schema/**` (plugin entry), `lib/visual/forms/**`, `lib/server/caddy/**`, `routes/sites/**`, `routes/api/porkbun/caddy/**`, `routes/domains/[domain]/caddy/**` | P5 |
| `deploy/**`, `Dockerfile`, `.github/workflows/**`, `docs/**`, `README.md` | P6 (P7 adds its own CI job at the end, after P6 is merged) |
| `e2e/**` | P7 |

`DECISIONS.md` and `TODO-USER.md` are append-only for everyone; a merge conflict there is
resolved by keeping both sides.

## 4. Tie-in with Caddy and `caddy-dns/porkbun`

The plugin's Caddyfile syntax, per site or globally:

```
tls {
	dns porkbun {
		api_key {env.PORKBUN_API_KEY}
		api_secret_key {env.PORKBUN_API_SECRET_KEY}
	}
}
```

```
{
	acme_dns porkbun {
		api_key {env.PORKBUN_API_KEY}
		api_secret_key {env.PORKBUN_API_SECRET_KEY}
	}
}
```

P5 must check this against the plugin's README before building the form (this session
could not open that repository).

- **Detect the plugin.** `POST /adapt` (through `adminFetch`) with a three-line Caddyfile
  that uses `acme_dns porkbun`. An "module not registered" error means the running Caddy
  lacks the plugin. Cached until Caddy restarts. Nothing is loaded, so this is safe.
- **Guided forms.** The `tls` form's "DNS provider" becomes a picker: Porkbun (shown first
  when detected) or "other" (today's free text). Choosing Porkbun writes the block above
  with the `{env.…}` placeholders. The Globals page gets the same for `acme_dns`.
- **No keys in the Caddyfile.** A literal value in `api_key` or `api_secret_key` gets a
  warning diagnostic in both editors ("this puts the key in the file and in History; use
  `{env.PORKBUN_API_KEY}`"). It is a warning, not a block.
- **Site to DNS cross-check.** For every site address under a Porkbun domain, the Sites
  list and the site page show whether a record exists and whether it points at this
  server's public IP (from `/ping`). Missing or wrong: one action creates or fixes it,
  through the review step.
- **Wildcards.** A `*.example.com` site without DNS-01 gets a hint that offers to add the
  `tls { dns porkbun … }` block. A site with DNS-01 on a domain that is not at Porkbun, or
  whose nameservers are not Porkbun's, gets a warning.
- **New site flow.** Adding a site whose host is under a Porkbun domain offers "also
  create the DNS record" as a second, separate review step after the Caddyfile is applied.
- **Challenge records.** `_acme-challenge` TXT records are labelled "managed by Caddy".
  Stale ones (older than a day, no certificate order in progress) can be cleaned up in
  one action.

## 5. Workstreams

Model and effort as in PLAN.md §5. Fable is used where a mistake is expensive or the
design is hard: the client that holds the keys and that every other thread builds on, the
record editor, and the Caddy tie-in.

| ID | Workstream | Model | Effort | Starts when | Produces |
| --- | --- | --- | --- | --- | --- |
| P0 | Foundations | Fable | high | this plan is merged | Everything marked P0 in §3.2: env, client for every endpoint in §2, errors, cache, audit, fake + fixtures, migration 3, shared types, shared components, nav entry "Domains", the route tree with placeholders, status and audit routes, the not-configured and misconfigured states |
| P1 | Domains list and overview | Opus | high | P0 merged | Domains index (search, sort, filter by expiring soon, auto-renew, API access; expiry countdown; bulk auto-renew), per-domain Overview tab (status, dates, lock, privacy, renewal price, nameserver summary, counts linking to the other tabs), account credit |
| P2 | DNS records | Fable | xhigh | P0 merged | Records table (group by host, filter by type, search), a form per record type with validation, add, edit, delete, multi-select, a pending-changes tray that reviews and applies a batch, dry run in the review, conflict and duplicate handling, notes, import from a zone file or JSON, export as a zone file, the "managed by Caddy" and "used by site" marks (reads P5's data when present, works without it) |
| P3 | Undo and registry settings | Opus | high | P0 merged | History tab (restore points, diff, restore with and without prune, dry run), preflight panel, Registry tab (nameservers with Porkbun defaults, glue, DNSSEC), all under the §3.1 rules |
| P4 | URL forwarding and SSL bundle | Sonnet | medium | P0 merged | Forwarding tab (list, add with 301/302/307/masked, path and wildcard options, delete), SSL tab (certificate subject, issuer, expiry, chain download, key download behind the env switch, `no-store` responses, nothing cached) |
| P5 | Caddy tie-in | Fable | high | P0 merged | Everything in §4 |
| P6 | Deploy and docs | Sonnet | medium | this plan is merged (drafts); final after P1–P5 | `deploy/caddy/Dockerfile` (the xcaddy build with a pinned Caddy version), compose example with the keys passed to both services, `docs/porkbun.md` (set-up, key scopes, sandbox, every tab, safety rules, troubleshooting by error code), updates to `docs/configuration.md`, `docs/install.md`, `docs/faq.md`, README, the TODO-USER steps, a CI job that builds the plugin Caddy image once and offers it to other jobs |
| P7 | Integration and QA | Opus | medium | P1–P5 merged | A fake Porkbun HTTP server for e2e (`e2e/support/porkbun-fake.mjs`, same fixtures as P0), Playwright flows for every tab, an e2e run against the plugin Caddy for §4, axe pass, the performance budget extended to the new pages, an optional CI job against Porkbun's sandbox that runs only when sandbox secrets exist, new README screenshots |

Parallelism: P0 and the drafts half of P6 start at once. When P0 merges, P1, P2, P3, P4
and P5 start together beside P6: six threads, the limit in COORDINATOR.md. P7 closes.
P0 is deliberately the only thread that edits shared files, so the five after it cannot
collide; §3.2 lists who owns what.

Inside a thread, subagents may be used for independent pieces (for example P2's per-type
forms, or P0's endpoint groups) as long as each subagent owns separate files.

### 5.1 Definition of done

- P0: every endpoint in §2 has a client method with a unit test against the fake; no test
  touches the network; the key values appear in no error, log line, audit row or response
  (tested); with the keys unset the app behaves exactly as v1.0.0 plus one nav entry;
  `pnpm lint`, typecheck and unit tests are green.
- P1: the list renders 1,000 domains within the performance budget; every flag on the page
  matches `/domain/get`; bulk auto-renew reports per-domain results.
- P2: each of the 14 types can be created, edited and deleted against the fake, with
  invalid input refused before any call; a batch of mixed changes applies in order and
  reports partial failure clearly; exporting a zone and importing it into an empty zone
  reproduces the same records.
- P3: a nameserver change is refused while preflight reports a blocker; a restore shows
  its dry run first and reports `failed` records; a restore can be undone from
  `previousStateSavedAs`.
- P4: a forward round-trips; the private key is never served unless the env switch is on,
  and never appears in a cache row or log (tested).
- P5: with the plugin Caddy, a wildcard site with the Porkbun block adapts cleanly through
  the forms; with stock Caddy the UI says the plugin is missing; the cross-check is right
  for apex, subdomain, wildcard, CNAME and "not at Porkbun" cases; every Caddy call goes
  through `adminFetch` (lint rule or test).
- P6: a reader can go from the stock compose file to working Domains pages using only the
  docs; the compose example passes `docker compose config`.
- P7: e2e green in CI on both Caddy versions; axe reports no serious violations on the new
  pages.

## 6. Design

Fishnet as in PLAN.md §6; colour and font tokens only. New nav group entry **Domains**
(Lucide `Network`) between Sites and the Caddyfile group. Pages: Domains (list),
Domain (tabs: Overview, DNS, History, Registry, Forwarding, SSL, Caddy), Activity.
Tables are Fishnet `DataTable`; dates show local time with the zone named; record values
and IPs are in JetBrains Mono; destructive buttons use the error tokens. Empty, stale and
error states follow Fishnet, and every page has an `AsOf` readout because the data is
cached.

## 7. Risks

- **A wrong DNS write takes sites or email down.** Review step, dry run, typed confirms,
  preflight, Porkbun's restore points, the audit log with "before", and read-only mode.
- **The keys leak.** Server-only, header auth, env-only, redaction tests, a warning on
  literal keys in the Caddyfile. The docs recommend a dedicated key with the "Manage, but
  no purchases" preset, restricted to the server's IP.
- **The key cannot do something.** Scopes come from `/ping`; per-domain API access comes
  from `apiAccess`; both are surfaced with the fix, not as a raw error.
- **Rate limits and outages.** Cache with stale serving; one polite retry on reads;
  writes are never retried automatically except with the same `Idempotency-Key`.
- **The API changes.** v3 is additive by contract. Unknown record types and unknown fields
  are shown read-only instead of dropped. The spec version read is recorded in
  `lib/server/porkbun/SPEC_VERSION`; a scheduled CI job (P6) compares it with the live
  `info.version` and opens nothing, only fails visibly, so someone looks.
- **CI cannot call Porkbun.** Unit and e2e tests use the fake. The sandbox job is optional.

## 8. Questions David answered

Both were decided below 70 confidence and put to him on 18 Nov 2026. He chose the defaults.

1. Renewals, WHOIS contacts and email forwarding: **left out**. No P8 workstreams.
2. Dynamic DNS (keeping A/AAAA records on the server's public IP): **left out**. No P9.

Do not ask again and do not build these unless he brings them up.

## 9. Milestones

1. P0 merged: Domains nav entry, connection status, all contracts in place.
2. P1–P5 merged: the full Domains area and the Caddy tie-in.
3. P6 final and P7 green: docs complete, e2e covers it. Release as v1.1.0 (David tags it;
   cloud sessions cannot push tags).
