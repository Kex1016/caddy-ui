# Configuration

All configuration is by environment variables, read once at start. A bad value stops the UI
with a message naming the variable. The UI never logs their values; the About page shows
secrets only as set or unset.

## Variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `CADDY_UI_PORT` | `3001` | Port the UI listens on inside the container |
| `CADDY_ADMIN_URL` | `http://caddy:2019` | Caddy admin API |
| `CADDYFILE_PATH` | `/etc/caddy/Caddyfile` | The file to edit |
| `CADDY_LOG_PATH` | `/var/log/caddy/access.log` | JSON access log to tail (optional) |
| `CADDY_DATA_PATH` | `/data/caddy` | Caddy data dir, for certificate expiry (optional) |
| `CADDY_UI_DATA` | `/etc/caddy-ui` | Where the SQLite database and backups live |
| `CADDY_UI_USER`, `CADDY_UI_PASSWORD` | unset | Local login; both unset disables local auth |
| `CADDY_UI_AUTH_MODE` | `local` | `local`, `forward` or `none` |
| `CADDY_UI_SESSION_SECRET` | random at boot | Cookie signing; set it to keep sessions across restarts |
| `CADDY_UI_PROBE_INTERVAL` | `30s` | Site and upstream probes (minimum 1s) |
| `CADDY_UI_SCRAPE_INTERVAL` | `15s` | Caddy `/metrics` scrape (minimum 1s) |
| `CADDY_UI_RETENTION_DAYS` | `90` | Days of probe results and metric samples kept |
| `CADDY_UI_PUBLIC_URL` | unset | Used in links |
| `CADDY_UI_UPDATE_INTERVAL` | `1h` | Updater poll period (minimum 1m in the UI; 30s in the sidecar) |
| `CADDY_UI_UPDATE_WEBHOOK_PORT` | unset | Updater listens for a push webhook when set |
| `CADDY_UI_UPDATE_SOURCE` | `ghcr` | `ghcr` (pull image) or `git` (clone and build) |
| `PORKBUN_API_KEY`, `PORKBUN_API_SECRET_KEY` | unset | Porkbun key pair for the Domains area; same names as the Caddy plugin uses. See [porkbun.md](porkbun.md) |
| `PORKBUN_API_URL` | `https://api.porkbun.com/api/json/v3` | Porkbun API base URL (`api-ipv4.porkbun.com` forces IPv4) |
| `CADDY_UI_PORKBUN_READONLY` | `false` (`true` with auth mode `none`) | Disables every write to Porkbun |
| `CADDY_UI_PORKBUN_CACHE_TTL` | `60s` | How long Porkbun reads are cached |
| `CADDY_UI_PORKBUN_SSL_KEY_DOWNLOAD` | `false` | Allows downloading the private key of the Porkbun-issued certificate |
| `TZ` | `UTC` | Display timezone (an IANA name such as `Europe/Budapest`) |

The two Porkbun keys are secrets like the session secret: keep them in `.env`, never in
the compose file or the Caddyfile. They are shown only as set or unset.

Durations use `30s`, `5m`, `1h` style. The `CADDY_UI_UPDATE_*` variables are read by the
updater sidecar; the full list is in [`deploy/updater/README.md`](../deploy/updater/README.md).

The example compose file also reads `CADDY_UI_TAG`, `CADDY_UI_HOST_PORT` and
`CADDY_UI_COMPOSE_DIR`; those are compose variables, not settings of the app.

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
