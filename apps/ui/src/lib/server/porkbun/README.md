# `$lib/server/porkbun`

The server side of the Domains area (docs/porkbun-plan.md §3). This folder, `$lib/api/porkbun.ts` and
`$lib/porkbun/components` belong to workstream P0. Other workstreams import from them and do not edit them;
if something is missing, ask for it rather than working around it.

## Rules

- Only `client.ts` talks to Porkbun. Routes and pages call `porkbun()` and never `fetch`.
- The two keys never leave this folder. They are not in any error, log line, audit row, cache row or
  response; `secrets.test.ts` checks that, so keep it passing.
- Every route that takes a domain calls `requireDomain(params.domain)` first. It is a 404 for anything that is
  not in the account, so a made-up name never reaches Porkbun.
- Every write goes through `write()`. It checks read-only mode and the key's permission, drops the cached
  reads, and records the write with its result.
- No test reaches the real API. `no-network.setup.ts` makes any request to a `porkbun.com` host fail.

## Reading

```ts
import { cached, porkbun, requireDomain, toResponse } from '$lib/server/porkbun';

export const GET: RequestHandler = async ({ params, url }) => {
	try {
		const domain = await requireDomain(params.domain);
		const zone = await cached(`${domain.domain}:dns`, () => porkbun().dns.list(domain.domain), {
			force: url.searchParams.has('force')
		});
		return json(zone); // Cached<DnsZone>: { data, fetchedAt, stale }
	} catch (err) {
		return toResponse(err);
	}
};
```

Cache keys are `<domain>:<area>` (`example.com:dns`, `example.com:ns`) and `_account:<area>` for things that
belong to no domain (`_account:domains` is taken by `listDomains()`). `invalidate('example.com')` drops every
key of that domain; `invalidate('example.com:dns')` drops one. `stale: true` means Porkbun could not be asked
and the answer is the last good one: show `AsOf` with it. The SSL bundle is never cached (the cache refuses
keys with an `ssl` part).

`toResponse(err)` turns this module's errors into the JSON every `/api/porkbun/*` route answers with
(`PorkbunFailure`). It throws SvelteKit's own errors and anything unknown on, so call it in the `catch` of a
`+server.ts` and return its result.

In a page's `load`, the layouts already give you `data.porkbun` (`PorkbunStatus`) and, under `[domain]`,
`data.domain` (`DomainSummary`). Sub-pages are only reached when both keys are set; the layout redirects to
`/domains` otherwise. In a `+page.server.ts` use `toApiError(err)` to hand a failure to the page and show it
with `PorkbunNotice`.

## Writing

```ts
import { authorOf } from '$lib/server/config/http';
import { porkbun, requireDomain, toResponse, write } from '$lib/server/porkbun';

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const domain = await requireDomain(params.domain);
		const input = parse(await request.json()); // your own validation; answer 400/422 before any call
		const result = await write<{ id: string }>({
			scope: 'dns',
			author: authorOf(locals),
			domain: domain.domain,
			action: 'dns.create',
			request: input,
			run: (pb) => pb.dns.create(domain.domain, input)
		});
		return json(result, { status: result.ok ? 200 : 502 }); // WriteResult<{ id: string }>
	} catch (err) {
		return toResponse(err);
	}
};
```

`write()` returns `{ ok: false, error }` when Porkbun refuses or can not be reached, so a batch can go on
and report per item. It throws only the 403 of read-only mode or a missing permission (`toResponse` passes
that on). Pass `before` when you have read the state the write replaces: that is what makes the Activity
page an undo trail. Scopes: `dns` for records and URL forwards, `domains` for nameservers, glue, DNSSEC and
auto-renew.

Dry runs (`pb.dns.dryRun.*`, `pb.ns.dryRunUpdate`, `pb.dns.restore(…, { dryRun: true })`,
`pb.dns.import(…, { dryRun: true })`) change nothing and are not audited. Call `requireWritable(scope)`
before one, so the review step is not offered for something that will be refused.

## In the browser

`$lib/porkbun/components` has the shared pieces: `ReviewDialog` (the review step of §3.1, with the dry run
and the typed confirmation), `TypedConfirm`, `ScopeGate` (disables a control and says why, by the same rule
the server uses: `writeBlock` in `$lib/api/porkbun.ts`), `PorkbunNotice` (an `ApiError` or Porkbun's
warnings, as written) and `RecordValue`. `explain(error)` in `$lib/porkbun/messages.ts` gives a title and a
fix for the error codes this UI knows.

`routes/domains/[domain]/+layout.svelte` owns the `<h1>` (the domain name), the status tags and the tab bar.
A tab page starts at `<h2>`. Each tab has a placeholder `+page.svelte` using `ComingSoon`; replace the page
of your tab and leave the others.

## Tests

```ts
import { resetPorkbunForTests, useFakePorkbun } from '$lib/server/porkbun/testing';

let ctx: ReturnType<typeof useFakePorkbun>;
beforeEach(() => (ctx = useFakePorkbun()));
afterEach(resetPorkbunForTests);
```

That points the module at `FakePorkbun` (fake.ts) and an in-memory database. The seed (fixtures/seed.json)
has `example.com` (Porkbun nameservers, 11 records, glue, one URL forward, an SSL bundle), `example.net`
(nameservers elsewhere, auto-renew off, a DS record) and `example.org` (API access off). Useful handles:
`ctx.fake.requests` and `ctx.fake.writes` (what was sent), `ctx.fake.scopes` (narrow the key),
`ctx.fake.rateLimitNext(seconds)`, `ctx.fake.throwNext(error)`, `ctx.fake.respondNext(canned)`,
`ctx.fake.records(domain)`. Pass `settings: { readonly: true }` to test read-only mode.

The fake follows Porkbun's spec version in `SPEC_VERSION`; `mock-fixtures.test.ts` runs the client against
the example responses of Porkbun's own mock server in `fixtures/mock/`. Two codes are the fake's own, used
where the spec names none: `SSL_NOT_READY` and `INVALID_RECORD_ID` for an unknown URL forward. Do not branch
on those.

`fake.ts` imports nothing at run time, so the e2e suite can load it with Node and serve
`fake.handle(request)` over HTTP, with `PORKBUN_API_URL` pointing at it.
