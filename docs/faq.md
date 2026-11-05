# FAQ

> **Draft.** Answers are based on the plan; real error messages are added once the app
> runs.

## The UI says Caddy is unreachable.
Check `CADDY_ADMIN_URL` and that Caddy's global options include `admin 0.0.0.0:2019` (or
another address the UI can reach). Both containers must share a network. Do not publish the
admin port to the internet.

## Per-site charts are empty.
Per-site request and latency charts need `metrics { per_host }` in global options. Charts
for top paths and client IPs need a JSON access log written to `CADDY_LOG_PATH`. Settings
shows the exact snippet for each. See [stats.md](stats.md).

## Does saving restart Caddy?
No. The UI validates, stores a backup, writes the file and loads the new config through the
admin API. If the load fails, Caddy keeps running the last good config.

## I edited the Caddyfile by hand. Will the UI overwrite it?
The UI detects the change and asks before overwriting.

## Will it keep my comments?
Yes. The editor works on a syntax tree that keeps comments and whitespace, and unchanged
input prints back byte for byte.

## A directive from a Caddy plugin shows as a raw row.
Expected. Raw rows round-trip unchanged but have no form. Edit them in the text editor.

## What does it cost to leave auth off?
`CADDY_UI_AUTH_MODE=none` lets anyone who can reach the UI rewrite your proxy config. Use it
only on a trusted network, or use `forward` behind your auth proxy.

## How do I lose sessions less often?
Set `CADDY_UI_SESSION_SECRET`. Without it a new secret is generated at every start.

## Is the Docker socket required?
No. It is an optional extra for container state and logs and is off by default.

## Where do I report problems?
Open an issue on the GitHub repository.
