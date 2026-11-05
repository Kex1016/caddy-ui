# Install

> **Draft** written from [PLAN.md](../PLAN.md). Commands and file names are confirmed when
> the image and `deploy/compose.example.yml` (workstream W9) land.

## What you need

- Docker with Compose.
- A running Caddy container whose admin API is reachable from the UI container. Do not
  publish the admin port on the host; put both containers on a private network.
- Read and write access to the Caddyfile that Caddy uses.

## 1. Prepare Caddy

In the global options block of your Caddyfile, make the admin API reachable on the shared
network:

```caddyfile
{
	admin 0.0.0.0:2019
}
```

Two optional additions unlock more charts (see [stats.md](stats.md)). The UI can also
offer these for you from Settings:

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

## 2. Add the service

Use the example in `deploy/compose.example.yml` (draft excerpt in the
[README](../README.md#quick-start-draft)). Mount the same Caddyfile Caddy reads, and give
the UI a directory of its own for its database and backups.

| Mount | Purpose | Mode |
| --- | --- | --- |
| Caddyfile → `CADDYFILE_PATH` | The file to edit | read-write |
| Caddy logs → `CADDY_LOG_PATH` dir | Access log for stats | read-only |
| Caddy data → `CADDY_DATA_PATH` | Certificate expiry | read-only |
| UI data → `CADDY_UI_DATA` | SQLite database, backups | read-write |

## 3. Start and sign in

```sh
docker compose up -d caddy-ui
```

Open the published port. Sign in with `CADDY_UI_USER` and `CADDY_UI_PASSWORD`, or use
forward auth (see [configuration.md](configuration.md#authentication)).

The first screen loads your current Caddyfile and flags anything that does not match the
running config.

## 4. Updating

The updater sidecar pulls a new image on the `CADDY_UI_UPDATE_INTERVAL` schedule and
redeploys the `caddy-ui` service. To update by hand:

```sh
docker compose pull caddy-ui && docker compose up -d caddy-ui
```

If the registry package is private, give the host a pull secret first.

## Troubleshooting

See [faq.md](faq.md).
