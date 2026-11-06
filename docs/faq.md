# FAQ

## The UI says Caddy is unreachable.
Check `CADDY_ADMIN_URL` and that Caddy's global options include `admin 0.0.0.0:2019` (or
another address the UI can reach). Both containers must share a network. Do not publish the
admin port to the internet. The About page lists the URL in use.

## Per-site charts are empty.
Per-site request and latency charts need `metrics { per_host }` in global options. Charts for
top paths and client IPs need a JSON access log written where `CADDY_LOG_PATH` points, and
that directory mounted into the UI container. An empty chart names the missing piece. See
[stats.md](stats.md) and [install.md](install.md#1-prepare-caddy).

## A site or upstream shows as down but works.
Sites are probed through Caddy from the UI container, so the UI must reach Caddy on the
shared network. Upstreams are probed directly from the UI container; one that only the Caddy
container can reach (a different network, or `localhost` from Caddy's view) shows as down.
Put the UI on that network too.

## There are no certificate dates.
Mount Caddy's data volume read-only and set `CADDY_DATA_PATH` so that `certificates/` is
directly below it. See [install.md](install.md#2-add-the-service).

## Does saving restart Caddy?
No. The UI validates, copies the old file to a backup, writes the new one and loads it through
the admin API. If the load fails, Caddy keeps running the last good config. A save that only
changes layout does not reload Caddy at all.

## Why did my first save re-indent the whole file?
Every save is written in `caddy fmt` style, which was your choice for this project. Comments
stay; indentation and spacing are rewritten. The review diff shows exactly what will land.

## I edited the Caddyfile by hand. Will the UI overwrite it?
The UI notices within a couple of seconds and, when you apply, refuses with a conflict. You
can compare your edits with the file on disk or drop them.

## A directive from a Caddy plugin has no proper form.
Plugin directives get a form generated from the schema when the schema knows them, and show
as raw text otherwise. Raw rows round-trip unchanged. Use text mode for anything unusual.

## A site disappeared after I disabled it.
Disabling comments the block out under a `# caddy-ui:disabled lines=N` line. Enable it again
from the Sites page, or delete the `# ` prefixes by hand and the marker line.

## What does leaving auth off cost?
`CADDY_UI_AUTH_MODE=none` lets anyone who can reach the UI rewrite your proxy config. Use it
only on a trusted network, or use `forward` behind your auth proxy, with the port unpublished.

## I keep getting signed out.
Set `CADDY_UI_SESSION_SECRET`. Without it a new secret is generated at every start.

## Can the UI see my containers?
No. It never uses the Docker socket. Only the optional updater sidecar does, to redeploy
`caddy-ui`.

## Where do I report problems?
Open an issue on the GitHub repository.
