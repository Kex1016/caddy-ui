# Configuration

Configuration comes from environment variables, read once at start. A bad value stops the UI
with a message naming the variable. The UI never logs their values; secrets are shown only as
set or unset.

Seven of the variables can also be changed while the UI runs, from Settings (or
`PATCH /api/settings`). A value saved there wins over the environment; see
[Settings and the environment](#settings-and-the-environment).

## Variables

| Variable | Default | Meaning | In Settings |
| --- | --- | --- | --- |
| `CADDY_UI_PORT` | `3001` | Port the UI listens on inside the container | Shown, environment only |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy admin API | Shown, environment only |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | The file to edit | Shown, environment only |
| `CADDY_LOG_PATH` | `/var/log/caddy/access.log` | JSON access log to tail (optional) | Shown, environment only |
| `CADDY_DATA_PATH` | `/data/caddy` | Caddy data dir, for certificate expiry (optional) | Shown, environment only |
| `CADDY_UI_DATA` | `/etc/caddy-ui` | Where the SQLite database and backups live | Shown, environment only |
| `CADDY_UI_USER`, `CADDY_UI_PASSWORD` | unset | Local login; both unset disables local auth | Shown, environment only |
| `CADDY_UI_AUTH_MODE` | `local` | `local`, `forward` or `none` | Shown, environment only |
| `CADDY_UI_SESSION_SECRET` | random at boot | Cookie signing; set it to keep sessions across restarts | Shown, environment only |
| `CADDY_UI_PROBE_INTERVAL` | `30s` | Site and upstream probes (minimum 1s) | Editable, applies at once |
| `CADDY_UI_SCRAPE_INTERVAL` | `15s` | Caddy `/metrics` scrape (minimum 1s) | Editable, applies at once |
| `CADDY_UI_RETENTION_DAYS` | `90` | Days of probe results and metric samples kept | Editable, applies at once |
| `CADDY_UI_PUBLIC_URL` | unset | Used in links | Editable, applies at once |
| `CADDY_UI_UPDATE_INTERVAL` | `1h` | How often the updater looks for a new version: `30s`, `5m`, `1h`, `1d`, at least 30s. The updater takes a changed value within a few seconds | Editable (needs the updater's shared folder, below) |
| `CADDY_UI_UPDATER_DIR` | `<CADDY_UI_DATA>/updater` | The folder this UI shares with the updater sidecar (`control.json`, `status.json`) | Shown, environment only |
| `CADDY_UI_UPDATE_WEBHOOK_PORT` | unset | Updater listens for a push webhook when set | Shown, environment only |
| `CADDY_UI_UPDATE_SOURCE` | `ghcr` | `ghcr` (pull image) or `git` (clone and build) | Shown, environment only |
| `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` | unset | Porkbun key pair for the Domains area; same names as the Caddy plugin uses. See [porkbun.md](porkbun.md) | Shown, environment only |
| `PORKBUN_API_URL` | `https://api.porkbun.com/api/json/v3` | Porkbun API base URL (`api-ipv4.porkbun.com` forces IPv4) | Shown, environment only |
| `CADDY_UI_PORKBUN_READONLY` | `false` (`true` when the UI has no sign-in: auth mode `none`, or `local` with no user and password) | Disables every write to Porkbun | Editable, applies at once |
| `CADDY_UI_PORKBUN_CACHE_TTL` | `60s` | How long Porkbun reads are cached | Editable, applies at once |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | `false` | Allows downloading the private key of the Porkbun-issued certificate | Shown, environment only |
| `TZ` | `UTC` | Display timezone (an IANA name such as `Europe/Budapest`) | Editable, applies at once |
| `CADDY_UI_SETTINGS_IGNORE` | `false` | `true` runs on environment values and defaults only; saved settings are kept but not used | Shown, environment only |

The two Porkbun keys are secrets like the session secret: keep them in `.env`, never in
the compose file or the Caddyfile. They are shown only as set or unset.

Durations use `30s`, `5m`, `1h` style. The `CADDY_UI_UPDATE_*` variables are read by the
updater sidecar; the full list is in [`deploy/updater/README.md`](../deploy/updater/README.md).

The example compose file also reads `CADDY_UI_TAG`, `CADDY_UI_HOST_PORT` and
`CADDY_UI_COMPOSE_DIR`; those are compose variables, not settings of the app.

## The Settings page

Settings (in the sidebar under System) has these sections, each saved on its own:

- **Monitoring**: probe interval, metrics interval and retention. Lowering retention says,
  before you save, how many probe results and metric samples the next hourly clean-up deletes
  and about how much space that is. The database file does not shrink; the space is reused.
  Below the fields: the database size, the free space on the volume that holds
  `CADDY_UI_DATA`, the oldest probe result, and the size and row count of every table. Table
  sizes are measured in the background (it reads the whole database) and remembered for 15
  minutes; **Measure again** measures now.
- **Display**: time zone and public address.
- **Domains**: the Porkbun read-only switch and cache lifetime, both keys as set or not set,
  the API address, the private key download switch, and **Test connection**, which asks
  Porkbun's `/ping` with the keys.
- **Connections**: `CADDY_ADMIN_URL` with a **Test** button, and each path with a check:
  the Caddyfile must be readable and writable, the access log readable (missing is only a
  warning, since logging is optional), Caddy's data directory readable, and `CADDY_UI_DATA`
  writable. Also the port and listener variables.
- **Sign-in**: the mode in use and whether the user, password and session secret are set.
- **Updates**: the running version, the newest version the updater found, the result and time
  of its last check, the next check, and the interval it uses (and whether that came from here
  or from its own environment). **Check now** asks the updater to check at once, and the
  interval is a field like the others. The source, the webhook port and the shared folder are
  shown for reference; they are set in compose. See [Updates and the updater](#updates-and-the-updater).
- **Recent changes**: the last 50 values saved or reset, with who and when.

Each editable field says where its value comes from: **Saved here**, **From the environment**
or **Default**. When a saved value differs from the environment, the field shows the
environment's value next to **Use the environment's value**.

With `CADDY_UI_SETTINGS_IGNORE=true`, every page shows a banner, the fields show the values in
force, and saving is off; **Use the environment's value** still removes a saved value.

## Updates and the updater

The UI never touches Docker. The updater sidecar does, and the two talk through two small
files in one folder that both containers can reach:

- `control.json`, written by the UI: the interval saved in Settings (or `null` when nothing is
  saved, so the updater's own `CADDY_UI_UPDATE_INTERVAL` applies) and a "check now" token.
- `status.json` (and `last-run.json`), written by the updater: its version of what is in
  force, the newest version it found, the last check and its result, and the next check.

The updater looks at `control.json` every `CADDY_UI_UPDATE_POLL` seconds (default 5), so a new
interval or a **Check now** is picked up within one poll. Nothing opens a port.

The folder is `CADDY_UI_UPDATER_DIR` for the UI (default `<CADDY_UI_DATA>/updater`) and
`CADDY_UI_UPDATE_CHANNEL_DIR` for the updater (default `./caddy-ui/updater` inside the compose
directory). With the example compose file both are the same folder on the host, because the
UI's data folder is `./caddy-ui` there. If your data folder is somewhere else, set
`CADDY_UI_UPDATE_CHANNEL_DIR` on the updater to the host path of `<your data folder>/updater`.
Without a shared folder the Updates section says so, the interval is saved but the updater
keeps its own, and **Check now** does nothing.

## Settings and the environment

The editable variables are `CADDY_UI_PROBE_INTERVAL`, `CADDY_UI_SCRAPE_INTERVAL`,
`CADDY_UI_RETENTION_DAYS`, `TZ`, `CADDY_UI_PUBLIC_URL`, `CADDY_UI_PORKBUN_READONLY`,
`CADDY_UI_PORKBUN_CACHE_TTL` and `CADDY_UI_UPDATE_INTERVAL`. For each of them the value in force is:

1. the value saved in Settings, if there is one;
2. otherwise the environment variable, if it is set;
3. otherwise the default in the table above.

So the environment is the starting value, and a value saved in the UI overrides it, also
after a restart and after changing compose. "Use the environment's value" in Settings (or
`null` in `PATCH /api/settings`) removes the saved value, and the environment applies again.
A change takes effect at once, without a restart: the probe and scrape timers are re-armed,
retention is read at the next prune, the Porkbun cache uses the new lifetime from its next
lookup, and pages show times in the new time zone. `TZ` set in Settings changes only how the
UI displays times; the process's own clock and log timestamps keep the environment's `TZ`.

Saved values are checked with the same rules, and get the same messages, as the environment
variables. A saved value that no longer passes (for example after going back to an older
image) is ignored with a warning in the log and in Settings; it never stops the container.
Only a bad environment variable does.

Every other variable is environment-only: sign-in (`CADDY_UI_AUTH_MODE`, `CADDY_UI_USER`,
`CADDY_UI_PASSWORD`, `CADDY_UI_SESSION_SECRET`), the paths, `CADDY_ADMIN_URL`, the port,
`PORKBUN_API_URL`, `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` and the updater's variables. Settings
shows them with their values; secrets and the Porkbun keys only as set or unset, never the
values. The Porkbun keys can never be entered in the UI.

`CADDY_UI_PORKBUN_READONLY` can always be turned on in Settings, but turned off only while
the UI has a sign-in (forward auth, or local auth with a user and password). If the sign-in
goes away later, a saved "off" is ignored and the default (read-only) applies.

Every change is recorded with who made it, when, and the old and new saved values; Settings
lists the latest ones.

**The way back.** Because compose can no longer override a saved value, starting the
container with `CADDY_UI_SETTINGS_IGNORE=true` runs it on environment values and defaults
only. Nothing is deleted; Settings says that saved values are not in force, refuses new
ones, and still lets you remove them. Remove the variable again to use the saved values.

**API.** `GET /api/settings` returns every variable above with its value in force, its
source (`saved`, `env` or `default`), the environment's value, whether it is editable, any
saved value that is being ignored and why, and the latest changes. `PATCH /api/settings`
takes `{ "CADDY_UI_PROBE_INTERVAL": "1m", "TZ": null }`: a string saves a value, `null`
removes the saved one. All keys are checked first and saved together, or none is; a refusal
answers 400 with a message per key (403 for loosening Porkbun without a sign-in, 409 while
`CADDY_UI_SETTINGS_IGNORE` is on). Both need a signed-in request, like every other route.

## Authentication

- **`local`** (default): username and password from `CADDY_UI_USER` and `CADDY_UI_PASSWORD`.
  If only one of the two is set, the UI refuses everyone rather than run open. Sessions are
  signed cookies lasting 7 days; set `CADDY_UI_SESSION_SECRET` so they survive restarts.
  Changing the user or the secret signs everyone out. Failed sign-ins are limited to 10 per
  15 minutes per client address.
- **`forward`**: trust the `Remote-User` header set by a forward-auth provider such as
  tinyauth. Anyone who can reach the port directly can send that header, so do not publish
  the port on the host; reach the UI only through Caddy with `forward_auth`.
- **`none`**: no login. Only for a network you trust.

### Forward auth on the Caddy side

For `forward` mode, put the UI behind Caddy with `forward_auth`, the same way as your other
protected sites:

1. In compose, set `CADDY_UI_AUTH_MODE: forward` and delete the `ports:` mapping of
   `caddy-ui` so the UI is reachable only from the Docker network. Caddy must be on the same
   network (`caddy-ui` in the example). `CADDY_UI_USER` and `CADDY_UI_PASSWORD` are not used
   in this mode; remove them, along with the `:?` guards in the example.
2. Add a site block that authenticates, then proxies to the service name and its container
   port:

   ```caddyfile
   (tinyauth_forwarder) {
   	forward_auth tinyauth:3000 {
   		uri /api/auth/caddy
   		copy_headers Remote-User Remote-Name Remote-Email Remote-Groups
   	}
   }

   caddy.example.com {
   	import tinyauth_forwarder
   	reverse_proxy caddy-ui:3001
   }
   ```

   If you already have a snippet like this, import it instead of adding a new one. Use your
   auth provider's own address and verify path.
3. Reload Caddy and open the site. tinyauth must accept the new hostname (it has to sit under
   the cookie domain tinyauth serves).

The UI shows the name from `Remote-User` as the signed-in user. Caddy drops a client-sent
`Remote-User` when the auth response does not set it, so the header cannot be spoofed
through Caddy. That is why the port must stay unpublished: a direct connection skips Caddy.

`GET /api/health` is always unauthenticated so health checks work.

## Volumes

See the mount table in [install.md](install.md#2-add-the-service). The UI writes only to the
Caddyfile and to `CADDY_UI_DATA`. Before every write the old file is copied to
`CADDY_UI_DATA/backups/`, and each applied version is kept as a revision (see History).

## Behaviour worth knowing

- **Saving normalises the file** to `caddy fmt` style: comments are kept, indentation and
  spacing are rewritten. If the normalised text would change the config Caddy builds, the UI
  saves your text as typed and warns.
- **Outside edits** are noticed within a couple of seconds (the file is polled). The UI asks
  before overwriting.
- **Caddy 2.11 and later** enforce the admin origin check. The UI talks to the admin API in a
  way that passes it; no change to `admin` is needed beyond a reachable address.
