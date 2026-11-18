# Install

## What you need

- Docker with Compose.
- A running Caddy container whose admin API is reachable from the UI container. Put both on
  a private Docker network and do not publish the admin port on the host.
- Read and write access to the Caddyfile that Caddy uses.

## 1. Prepare Caddy

In the global options block of your Caddyfile, make the admin API reachable on the shared
network:

```caddyfile
{
	admin 0.0.0.0:2019
}
```

Two optional additions unlock more charts (see [stats.md](stats.md)). Add them by hand or
with the visual editor on the Globals page:

```caddyfile
{
	metrics {
		per_host
	}
}

(access_log) {
	log {
		output file /var/log/caddy/access.log
		format json
	}
}
```

Then `import access_log` in the sites you want in the access-log charts, or use a global
`log` block. The log must be JSON and written where the UI can read it.

## 2. Add the service

Take `caddy-ui` from [`deploy/compose.example.yml`](../deploy/compose.example.yml). Mount the
same Caddyfile Caddy reads, and give the UI a directory of its own for its database and
backups. The UI image runs as root because it rewrites the bind-mounted Caddyfile.

| Mount | Purpose | Mode |
| --- | --- | --- |
| Caddyfile → `CADDYFILE_PATH` | The file to edit | read-write |
| Caddy logs dir → dir of `CADDY_LOG_PATH` | Access log for stats | read-only |
| Caddy data dir → `CADDY_DATA_PATH` | Certificate expiry | read-only |
| UI data → `CADDY_UI_DATA` | SQLite database, backups | read-write |

Caddy's official image keeps certificates under `/data/caddy/certificates`. If you mount
Caddy's data volume at `/data` in the UI container, the default `CADDY_DATA_PATH=/data/caddy`
is right. If your host folder holds `certificates/` directly (the old backend mounted it at
`/data/caddy`), mount it at `/data/caddy`, or set `CADDY_DATA_PATH` to wherever
`certificates/` sits.

To manage Porkbun domains from the UI, also pass `PORKBUN_API_KEY` and
`PORKBUN_API_SECRET_KEY` (the same variables Caddy's Porkbun plugin uses) to the `caddy-ui`
service; see [porkbun.md](porkbun.md). Leave them unset and the Domains area stays off.

The service needs `CADDY_UI_PASSWORD` and `CADDY_UI_SESSION_SECRET` (a long random string).
The compose example refuses to start without them.

## 3. Start and sign in

```sh
docker compose up -d caddy-ui
```

Open the published port (9876 in the example) and sign in. For forward auth see
[configuration.md](configuration.md#authentication).

Check that `GET /api/health` answers `ok` (the compose healthcheck does this). The About page
shows the version and which settings are in effect; secrets show only as set or unset.

## 4. First look

1. **Overview** and **Sites** show status after one probe interval (30 s by default).
2. Open **Editor**, expand a few blocks, and press **Format**, then **Review and apply**,
   without changing anything else. (**Review and apply** stays disabled while the text
   matches the file.) The diff only re-indents the file into `caddy fmt` style; comments are
   kept. If the file is already in that style, **Format** finds nothing to do.
3. Sites that sit behind another container's network may show as down; see
   [faq.md](faq.md).

## 5. Updating

The updater sidecar is optional. It checks for a new image every `CADDY_UI_UPDATE_INTERVAL`,
redeploys only `caddy-ui`, and rolls back if the new container is not healthy. It needs the
Docker socket and your compose directory mounted at the same absolute path
(`CADDY_UI_COMPOSE_DIR`). Settings are in [`deploy/updater/README.md`](../deploy/updater/README.md).

To update by hand:

```sh
docker compose pull caddy-ui && docker compose up -d caddy-ui
```

If the `ghcr.io/kex1016/caddy-ui` package is private, log in with `docker login ghcr.io`
first, or make the package public in GitHub's package settings.

## Troubleshooting

See [faq.md](faq.md).
