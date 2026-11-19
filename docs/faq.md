# FAQ

## The UI says Caddy is unreachable.
Check `CADDY_ADMIN_URL` and that Caddy's global options include `admin 0.0.0.0:2019` (or
another address the UI can reach). Both containers must share a network. Do not publish the
admin port to the internet. Settings lists the URL in use and has a
**Test** button for it.

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

## Domains says Porkbun is not set up.
The `caddy-ui` container needs `PORKBUN_API_KEY` and `PORKBUN_API_SECRET_KEY` in its own
`environment:`; Caddy's copy is not visible to it. See [porkbun.md](porkbun.md).

## Does the Porkbun plugin for Caddy do what the Domains pages do?
No. The plugin only lets Caddy answer ACME DNS-01 challenges (wildcard certificates). The
Domains pages manage DNS records, nameservers and the rest through the Porkbun API. They
share the same two environment variables.

## Can the UI register or renew domains?
No. It manages domains you already own and never spends money.

## Overview or Sites is slow.
Open the page with the browser's developer tools on the Network tab, pick the document
request and look at its Timing: the `Server-Timing` entries say which step took the time
(see [stats.md](stats.md#how-the-pages-stay-fast)). Loads over 500 ms are also logged by the
container (`docker compose logs caddy-ui | grep "slow load"`). Include those lines when you
report it.

## I changed a setting in Settings but compose says something else.
A value saved in Settings wins over the environment. Press "Use the environment's value" next to
the field to go back, or start the UI with `CADDY_UI_SETTINGS_IGNORE=true` to ignore every saved
value at once. See [configuration.md](configuration.md#settings-and-the-environment).

## How do I move my settings to a new install?
Settings → Export and import → **Download settings file**, then on the new instance choose the
file, press **Review changes** and **Apply**. The file holds saved settings, display preferences,
per-site probe options and notification settings. The Discord webhook URL is in it only if you
tick the box; the Porkbun keys, the sign-in and every other environment value are set in compose
and never travel in the file.

## The bare address opens Sites (or another page), not Overview.
That is the landing page in Settings → Preferences. Overview is one click away in the sidebar, and
`/?home` always shows it.

## Where do I report problems?
Open an issue on the GitHub repository.
