# TODO-USER

Things only David can do. Threads append here; David strikes items through when done.
Newest at the bottom. Format: date · workstream · what · why.

- [ ] 2026-11-05 · Plan · Approve [PLAN.md](PLAN.md) (merge the planning PR or say so in
  the project chat) · the coordinator launches workstreams only after approval.
- [ ] 2026-11-05 · Plan · Answer questions 2–5 at the end of
  [docs/visual-editor-options.md](docs/visual-editor-options.md) (text mode, round trip,
  first-release scope, how to disable a site); question 1 is answered: B, tree +
  inspector · W5 waits for them; everything else starts without them.
- [ ] 2026-11-05 · Plan · Confirm the accent tweak in PLAN.md §6 (teal-green instead of
  Fishnet's sea blue) or name another colour · the only design change allowed is colour
  and font, so it should be the one you want.
- [ ] 2026-11-05 · W4 · Add `metrics { per_host }` to the global options block of the
  Caddyfile, or accept the UI's "enable metrics" helper when it ships · per-site request
  and latency charts come from Caddy's metrics and need the host label.
- [ ] 2026-11-05 · W4 · Decide whether to turn on JSON access logging (the UI will offer a
  snippet that writes `/var/log/caddy/access.log`; `CADDY_LOG_PATH` is already set in
  compose but no `log` directive exists) · top paths, client IPs and exact error rates
  come only from the access log.
- [ ] 2026-11-05 · W4 · Decide whether the UI container may mount `/var/run/docker.sock`
  (read-only) · optional: shows container restarts and logs; off by default because it
  grants root-equivalent access to the host.
- [ ] 2026-11-05 · W9 · Make the GitHub Container Registry package
  `ghcr.io/kex1016/caddy-ui` public, or add a pull secret on the server · the updater
  pulls from it.
- [ ] 2026-11-05 · W9 · When 1.0 is tagged, replace `caddy-ui-backend` and
  `caddy-ui-frontend` in `compose.yml` with the `caddy-ui` service from
  `deploy/compose.example.yml`, set `CADDY_UI_SESSION_SECRET`, and remove `JWT_SECRET` ·
  the goal of the project.
- [ ] 2026-11-05 · W0 · Decide `CADDY_UI_AUTH_MODE`: `local` (username/password as today),
  `forward` (put the UI behind tinyauth like your other services), or `none` on a
  trusted network · auth ships with all three; the default is `local`.
- [ ] 2026-11-05 · W9 · After the first publish run, set the new `caddy-ui` and
  `caddy-ui-updater` packages to public (GitHub profile → Packages → Package settings)
  · new GHCR packages start private, so the server cannot pull them without a login.
- [ ] 2026-11-05 · W9 · If you enable the updater webhook, publish its port only on a
  trusted network and set `CADDY_UI_UPDATE_WEBHOOK_SECRET` · the endpoint triggers a
  redeploy check.
- [ ] 2026-11-05 · W9 · The updater needs the Docker socket
  (`/var/run/docker.sock`) and the compose directory mounted at the same absolute path
  as on the host (`CADDY_UI_COMPOSE_DIR`) · that is root-equivalent on the host; skip the
  sidecar and use Watchtower if you do not want that.
- [ ] 2026-11-05 · W10 · Decide whether history and settings from the old zackwag backend
  should be imported into the new UI; the drafts say they are not · an importer is extra
  work and only worth it if you have history you want to keep.
- [ ] 2026-11-05 · W10 · Pick the license for the first release (the README says MIT, to
  be added) · the repo has no LICENSE file yet.
- [ ] 2026-11-05 · W0 · If you pick `CADDY_UI_AUTH_MODE=forward`, do not publish the UI's port on the host
  (drop the `ports:` mapping and reach it only through Caddy with `forward_auth`) · in forward mode the UI
  trusts the `Remote-User` header, and anyone who can reach the port directly could send it.
- [ ] 2026-11-05 · W0 · Look at the theme once a preview runs and veto it if you dislike it: the accent is
  teal-green and `success` (the "up" colour) moved from Fishnet's teal to a leaf green so the two don't clash ·
  only colour and font may differ from Fishnet, so these are the choices to check.
- [ ] 2026-11-05 · W1 · Nothing needed from you. For reference: the parser treats `root /srv`
  (one argument) as a path, matching Caddy ≥ 2.8; if your server runs an older Caddy, write
  `root * /srv` · only matters for the visual editor's matcher field on `root`.
- [ ] 2026-11-05 · W4 · Mount Caddy's log directory and data directory into the UI container read-only
  (`./logs:/var/log/caddy:ro`, `./data:/data/caddy:ro`; if your Caddy mounts `./data` at `/data`, mount it at
  `/data` and set `CADDY_DATA_PATH=/data`) · access-log stats and certificate expiry read these; the UI only
  reads them.
- [ ] 2026-11-05 · W4 · If any site's upstream is only reachable from the Caddy container (not from other
  containers on the `caddy-ui` network), expect it to show as down; tell the thread so the probe can go
  through Caddy instead · upstreams are probed directly from the UI container.
