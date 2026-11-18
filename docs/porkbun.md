# Porkbun domains

> **Draft.** Written from [porkbun-plan.md](porkbun-plan.md) before the Domains pages
> exist. Sections marked *(to verify)* describe the planned behaviour and are checked
> against the finished UI in the final docs pass. Set-up, key scopes, sandbox and
> troubleshooting are already accurate.

Caddy UI can manage the domains you own at [Porkbun](https://porkbun.com): list them, edit
DNS records, undo DNS changes, change nameservers, glue and DNSSEC, set up URL forwarding,
read the SSL bundle, and keep the DNS records your Caddy sites need in step with the
Caddyfile. It uses the [Porkbun API v3](https://porkbun.com/api/json/v3/spec).

It manages **existing** domains. It does not register, transfer or renew domains and it does
not touch hosting, mailboxes or other Porkbun products, because those spend money or belong
to another product. Everything is optional: without keys the rest of the UI behaves exactly
as before.

## Set-up

### 1. Create an API key

At <https://porkbun.com/account/api> create a key pair.

- Use a **dedicated key** for Caddy UI, not your main one.
- Choose the permission preset **Manage, but no purchases**, or any set that covers DNS and
  domain settings. Caddy UI never needs the purchase or funding scopes.
- If the key has an IP allowlist, add the public IP of the server that runs Caddy UI. The
  Domains header shows the IP Porkbun sees (from `/ping`) once the connection works.
- For every domain you want to manage, switch **API access** on in the domain's details at
  Porkbun. Without it Porkbun answers `API_ACCESS_DISABLED` for that domain.

### 2. Give the keys to the container

Caddy UI reads the **same two variables** the Porkbun plugin for Caddy reads, so one
`.env` entry serves both containers. The UI is a separate container and does not see
Caddy's environment, so add them to its `environment:` too:

```yaml
  caddy-ui:
    environment:
      PORKBUN_API_KEY: ${PORKBUN_API_KEY:-}
      PORKBUN_API_SECRET_KEY: ${PORKBUN_API_SECRET_KEY:-}
```

Put the values in `.env` next to your compose file (never in the compose file, the
Caddyfile or git):

```sh
PORKBUN_API_KEY=pk1_...
PORKBUN_API_SECRET_KEY=sk1_...
```

Then `docker compose up -d caddy-ui`. [`deploy/compose.example.yml`](../deploy/compose.example.yml)
shows both services.

If only one of the two is set, the Domains page says which one is missing and the rest of
the UI keeps working. If neither is set, the page shows these steps and makes no calls.

### 3. Check the connection

Open **Domains**. The header shows the connection state, whether the key is a sandbox key,
whether the UI is read-only, and the key's scopes. Controls the key cannot use are disabled
with the reason, not hidden.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` | unset | Porkbun key pair. Both unset (or empty): the Domains area is off. |
| `PORKBUN_API_URL` | `https://api.porkbun.com/api/json/v3` | Base URL. Use `https://api-ipv4.porkbun.com/api/json/v3` to force IPv4 (useful with an IPv4-only allowlist). |
| `CADDY_UI_PORKBUN_READONLY` | `false`; `true` when `CADDY_UI_AUTH_MODE=none` | Disables every write. With auth off you must set it to `false` yourself. |
| `CADDY_UI_PORKBUN_CACHE_TTL` | `60s` | How long reads are cached. |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | `false` | Allows downloading the private key of the Porkbun-issued certificate. |

The keys stay on the server. The browser never receives them, they are never written to the
database, a Caddyfile revision, a log line or an error message.

## Sandbox

A key pair whose public key starts with `pk1_sb_` is a Porkbun **sandbox** key (secret
`sk1_sb_`), created on the same page. Nothing real changes: DNS, nameservers and DNSSEC are
simulated against an isolated datastore and nothing is charged. The Domains header shows a
**Sandbox** tag. Use it to try the pages before pointing them at real domains. Forwarding
and other email or hosting features answer `SANDBOX_UNSUPPORTED` there.

## What the pages do *(to verify)*

Domains lists your domains with expiry, auto-renew, lock, privacy and API access. Each
domain has these tabs:

| Tab | What you can do |
| --- | --- |
| Overview | Status, dates, lock, WHOIS privacy, renewal price, nameserver summary, auto-renew (one domain or many) |
| DNS | All 14 record types (A, AAAA, MX, CNAME, ALIAS, TXT, NS, SRV, TLSA, CAA, SSHFP, HTTPS, SVCB, DS), notes, TTL and priority; add, edit, delete, batch review, import from a BIND zone file or JSON, export as a zone file |
| History | Porkbun's DNS restore points, diff against the live zone, restore with or without pruning, preflight check |
| Registry | Nameservers (with "back to Porkbun defaults"), glue records, DNSSEC |
| Forwarding | URL forwards: 301, 302, 307 and masked, with path and wildcard options |
| SSL | Certificate subject, issuer and expiry; chain download; private key download only if enabled |
| Caddy | Which of your Caddy sites live under this domain, whether their DNS records exist and point at this server |

An **Activity** page lists every change the UI made, with the state before it.

Dates show in your timezone (`TZ`), the data on each page is cached for the TTL above, and a
"refreshed 40 s ago · Refresh" control shows its age.

## Safety rules *(to verify)*

DNS mistakes take sites and email down, so every write is deliberately slow:

1. **Review before apply.** Every change shows before and after in a review step. Nothing is
   sent on a single click.
2. **Dry run.** Where Porkbun supports `dryRun` (DNS record writes, nameserver changes,
   restore, import) the review runs it first and shows the result.
3. **Typed confirmation.** Deleting records by name and type, changing nameservers, deleting
   DNSSEC records or glue, bulk deletes and restore with prune need you to type the domain
   name. Deleting a single record asks for a plain confirm.
4. **Preflight.** A nameserver change runs Porkbun's preflight (`move-nameservers`) and is
   refused while it reports blockers, for example active DNSSEC. Adding DNSSEC runs
   `enable-dnssec`.
5. **Warnings are shown as written.** A write that succeeded on a zone that Porkbun's
   nameservers do not serve says so. A domain moved to Cloudflare through Porkbun is listed,
   but its DNS is not managed here.
6. **Records Caddy depends on are marked.** `_acme-challenge` TXT records are labelled
   "managed by Caddy"; records a Caddyfile site resolves through show which sites they
   affect before you edit or delete them.
7. **Undo.** Porkbun keeps restore points for DNS; the History tab restores them, and a
   restore can itself be undone. Where Porkbun has no undo, the Activity page keeps the
   "before" state so you can reverse a change by hand.
8. **Read-only.** `CADDY_UI_PORKBUN_READONLY=true` disables every write.

## Caddy and the Porkbun plugin

The `caddy` container in this project's compose example is built with
[`caddy-dns/porkbun`](https://github.com/caddy-dns/porkbun) (see
[`deploy/caddy/Dockerfile`](../deploy/caddy/Dockerfile)). The plugin lets Caddy solve ACME
DNS-01 challenges at Porkbun, which gives you **wildcard certificates** and certificates for
hosts that cannot be reached on port 80/443. It manages nothing else; the Domains pages are
separate.

Build the image yourself (as you would for any xcaddy build):

```sh
docker build -t caddy-porkbun:local deploy/caddy
# a different Caddy minor version:
docker build --build-arg CADDY_VERSION=2.11 -t caddy-porkbun:local deploy/caddy
```

Rebuild it when you want a newer Caddy or plugin. Then use it in the Caddyfile, per site or
globally, with the keys from the environment so they never land in the file:

```caddyfile
*.example.com {
	tls {
		dns porkbun {
			api_key {env.PORKBUN_API_KEY}
			api_secret_key {env.PORKBUN_API_SECRET_KEY}
		}
	}
}
```

```caddyfile
{
	acme_dns porkbun {
		api_key {env.PORKBUN_API_KEY}
		api_secret_key {env.PORKBUN_API_SECRET_KEY}
	}
}
```

> The syntax above is taken from the plugin's documented usage and is re-checked against its
> README in the final docs pass.

Never paste the key values into the Caddyfile: the file is also stored in History. The
editors warn about literal values. The UI detects whether the running Caddy has the plugin
and says so when it does not (`module not registered: dns.providers.porkbun` is Caddy's own
message for that).

## Troubleshooting

Porkbun returns a machine-readable `code`; the UI shows what to change at Porkbun, with
Porkbun's link when it gives one.

| Code | Meaning and fix |
| --- | --- |
| `API_ACCESS_DISABLED` | API access is off for this domain. Turn on **API access** in the domain's details at Porkbun. |
| `INSUFFICIENT_SCOPE` | The key lacks the permission this action needs (the control is normally disabled first). Create a key with the DNS and domain scopes. |
| `IP_NOT_ALLOWED` | The key has an IP allowlist and the server's IP is not on it. Add the IP shown in the Domains header, or use the IPv4 endpoint (`PORKBUN_API_URL`) if the allowlist is IPv4-only. |
| `DOMAIN_NOT_ALLOWED` | The key is restricted to other domains. Edit the key's domain list at Porkbun. |
| `DUPLICATE_RECORD` | An identical record exists. The UI adopts the existing one instead of failing. |
| `RECORD_CONFLICT` | The new record clashes with existing ones (for example a CNAME beside other records). The conflicting records are listed. |
| `ZONE_RECORD_LIMIT` / `TOO_MANY_RECORDS` | The zone is at Porkbun's record limit. Delete records first. |
| `INVALID_INPUT` / `INVALID_VALUE` | Porkbun rejected a value. The message names the field. |
| `RATE_LIMITED` / `RATE_LIMIT_EXCEEDED` | Too many calls. Cached data is shown with a notice; reads are retried once, writes never. |
| `SANDBOX_UNSUPPORTED` | The feature does not exist in sandbox. |
| `API_KEY_REQUIRED` / `MISSING_SECRETAPIKEY` / `INVALID_USER` | Key missing or wrong. Re-check both variables and that you copied the secret half. |
| `NAMESERVER_CHANGE_REQUIRED` | DNS is served elsewhere, so edits here do not take effect. Point the domain at Porkbun's nameservers or edit DNS where it is served. |
| `UPSTREAM_UNAVAILABLE` | Porkbun is down. Try again later; stale cache is shown meanwhile. |

Other problems:

- **"Domains" says set-up is needed.** Both variables must reach the `caddy-ui` container;
  `docker compose exec caddy-ui printenv | grep -c PORKBUN` should print `2`.
- **Controls are greyed out.** Hover for the reason: a missing scope, read-only mode, or
  `CADDY_UI_AUTH_MODE=none` (which defaults to read-only).
- **Records changed at Porkbun do not appear.** Press Refresh, or wait for the cache TTL.
- **Wildcard certificate fails with a DNS error.** Check that `docker compose exec caddy
  printenv | grep -c PORKBUN` prints `2`, that the image is the plugin build, and that the
  domain's nameservers are Porkbun's.
