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
