# Porkbun domains

Caddy UI can manage the domains you own at [Porkbun](https://porkbun.com): list them, edit
DNS records, undo DNS changes, change nameservers, glue and DNSSEC, set up URL forwarding,
read the SSL bundle, and keep the DNS records your Caddy sites need in step with the
Caddyfile. It uses the [Porkbun API v3](https://porkbun.com/api/json/v3/spec).

It manages **existing** domains. It does not register, transfer or renew domains, it does not
edit WHOIS contacts or email forwarding, it does not keep records on your changing public IP
(dynamic DNS), and it does not touch hosting, mailboxes or other Porkbun products. Those
spend money, hold personal data or belong to another product, and were left out on purpose. Everything is optional: without keys the rest of the UI behaves exactly
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
| `CADDY_UI_PORKBUN_READONLY` | `false`; `true` when the UI has no sign-in of its own | Disables every write. "No sign-in of its own" means `CADDY_UI_AUTH_MODE=none`, or `local` with no `CADDY_UI_USER` and `CADDY_UI_PASSWORD` (for example because an auth proxy in front does the sign-in). With `forward` auth or a local user, writes are on. Set it to `false` yourself to allow changes on an open UI. |
| `CADDY_UI_PORKBUN_CACHE_TTL` | `60s` | How long reads are cached. |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | `false` | Allows downloading the private key of the Porkbun-issued certificate. |

Settings shows both keys only as set or unset, with a **Test connection** button, and the read-only switch
and cache lifetime, which can be changed there.

The keys stay on the server. The browser never receives them, they are never written to the
database, a Caddyfile revision, a log line or an error message.

## Sandbox

A key pair whose public key starts with `pk1_sb_` is a Porkbun **sandbox** key (secret
`sk1_sb_`), created on the same page. Nothing real changes: DNS, nameservers and DNSSEC are
simulated against an isolated datastore and nothing is charged. The Domains header shows a
**Sandbox** tag. Use it to try the pages before pointing them at real domains. Forwarding
and other email or hosting features answer `SANDBOX_UNSUPPORTED` there.

## What the pages do

Domains lists your domains with expiry, auto-renew, lock, privacy and API access. Each
domain has these tabs:

| Tab | What you can do |
| --- | --- |
| Overview | Status, dates, lock, WHOIS privacy, renewal price, nameserver summary, counts that link to the other tabs, auto-renew for one domain. The Domains list also switches auto-renew for many domains at once and shows your account credit. Renewing itself is not offered. |
| DNS | The records of the zone, grouped by host and filterable by type. A form per type for A, AAAA, MX, CNAME, ALIAS, TXT, NS, SRV, TLSA, CAA, SSHFP, HTTPS, SVCB and DS, with notes, TTL and priority. Changes are **staged** in a pending tray, reviewed together and applied in order. Import from a BIND zone file or JSON, export as a zone file or JSON. |
| History | Porkbun's DNS restore points, a diff against the live zone, restore with or without pruning, and the preflight safety check on demand. |
| Registry | Nameservers (with "back to Porkbun defaults"), glue records and DNSSEC. |
| Forwarding | URL forwards: 301, 302, 307 and masked, with path and wildcard options. A second forward for the same name is refused. |
| SSL | Porkbun-issued certificate subject, issuer and expiry, and a chain download. The private key download exists only with `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD=true`. These responses are never cached. |
| Caddy | The Caddy sites under this domain, whether each one has a DNS record and whether it points at this server. See below. |

An **Activity** page lists every change the UI made, with the state before it.

Dates show in your timezone (`TZ`). Reads are cached for the TTL above, and every page shows
how old its data is with a Refresh control.

### Details worth knowing

- **DNS tray.** Staged changes are kept per domain in your browser's session storage, so a
  reload keeps them and closing the tab drops them. One batch holds at most 100 changes.
- **Editing a record** cannot change its type; delete it and add a new one. Record types
  outside the 14 above are shown read-only instead of being dropped.
- **Import** accepts a source of up to 1 MiB and 2000 records. Records already in the zone
  are skipped and anything unusable is left out with the reason. Porkbun takes at most 500
  new records per import, so if more would be created the UI refuses and asks you to split
  the source and import it in parts.
- **Deleting several records at once** needs the domain name typed; the server checks it too.
- **Domains moved to Cloudflare** through Porkbun are listed, and Porkbun's warning is shown
  as written; their DNS is not managed here.

## Safety rules

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

Two separate things use the same keys. The **plugin** lets Caddy itself answer ACME DNS-01
challenges. The **Domains pages** manage DNS through the API. Either works without the other,
but the Caddy tab and the checks below need both: the plugin in Caddy, and the keys on the
`caddy-ui` container (Caddy's own environment is not visible to it).

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

CI builds the plugin image and adapts exactly this syntax on every change, so it is known to
work with the version of Caddy in `deploy/caddy/Dockerfile`.

Never paste the key values into the Caddyfile: the file is also stored in History. The
editors warn about a literal `api_key` or `api_secret_key`.

What the UI adds:

- **Plugin detection.** The UI asks Caddy to adapt a three-line Caddyfile that uses
  `acme_dns porkbun`; nothing is loaded. If Caddy answers `module not registered:
  dns.providers.porkbun`, the UI says the running Caddy lacks the plugin. This works even
  with the Porkbun keys unset.
- **Guided forms.** The `tls` form's DNS provider is a picker (Porkbun, or other with free
  text). Choosing Porkbun writes the block above with the `{env.…}` placeholders. The
  Globals page offers the same for `acme_dns`.
- **Site to DNS cross-check.** For every site address under one of your Porkbun domains, the
  Caddy tab shows whether a record answers for it and whether it points at this server's
  public IP (the address Porkbun sees in `/ping`). If it is missing or wrong, one action
  creates or fixes it through the review step. A site under a domain that is not at Porkbun,
  or whose nameservers are not Porkbun's, is flagged.
- **Wildcards.** A `*.example.com` site without the DNS challenge gets a hint that offers to
  add the `tls` block. A DNS-challenge site on a domain that is not served by Porkbun gets a
  warning.
- **Challenge records.** `_acme-challenge` TXT records are labelled "managed by Caddy", and
  stale ones can be cleaned up in one action. Records a site depends on show which sites an
  edit would affect, and the DNS tab marks them "used by site".

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
