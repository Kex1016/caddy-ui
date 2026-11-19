# TODO-USER

Things only David can do. Threads append here; David strikes items through when done.
Newest at the bottom. Format: date · workstream · what · why.

- [x] 2026-11-05 · Plan · Approve [PLAN.md](PLAN.md) (merge the planning PR or say so in
  the project chat) · the coordinator launches workstreams only after approval. Done 6 Nov:
  PR #1 merged.
- [x] 2026-11-05 · Plan · Answer the five visual editor questions · done 6 Nov: tree +
  inspector, Visual | Text switch, normalise on save, bespoke forms for all 41, comment
  out to disable (docs/visual-editor-options.md).
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
- [ ] 2026-11-05 · W9 · When 1.0 is tagged, swap the two zackwag services for `caddy-ui` ·
  the goal of the project; exact steps are the last item in this file.
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
- [x] 2026-11-05 · W10 · Pick the license for the first release (the README says MIT, to
  be added) · the repo has no LICENSE file yet. Done 6 Nov: MIT, LICENSE added by W11.
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
- [ ] 2026-11-05 · W8 · Try the Sites page on your real Caddyfile once the image is up: add, duplicate, disable,
      re-enable and delete a throwaway site (for example `test.example.com`). Each change is validated by Caddy and
      kept in History, so a mistake is one click to undo · the unit tests cover the file edits, but only your
      Caddyfile proves they sit well with its comments and layout.
- [ ] 2026-11-06 · W5a · Open your real Caddyfile in the visual editor, expand every block, change nothing, press
      "Format" and then "Review and apply" (the button stays disabled until the text differs from the file): the diff should only re-indent (every save is written in `caddy fmt` style, as you chose)
      and keep every comment; afterwards "Format" should find nothing to change. Then edit one site through its form and
      check the text mode shows exactly the change you expect · the sample copy of your Caddyfile round-trips in
      the tests, but only the real file proves it, and anything the forms do not model shows under "Other lines".

- [ ] 2026-11-06 · W11 · Glance at the theme once more: to pass the accessibility check, faint text (section
      labels in the sidebar, captions, line numbers) is a little darker in light mode and lighter in dark mode, and
      the light accent text is a shade darker (DECISIONS.md, W11). Nothing else changed · if you would rather keep
      Fishnet's lighter grey, say so and pick a colour that still has 4.5:1 contrast.
- [ ] 2026-11-06 · W10 · **Swap `caddy-ui-backend` and `caddy-ui-frontend` for `caddy-ui` in
  your compose file** (do this last; it is the end of the project). `v1.0.0` was tagged on
  12 Nov and its images are on GHCR, so you can do it now. Both
  packages were still private on 12 Nov (anonymous pulls are refused), so step 1 is needed.
  1. Check that `ghcr.io/kex1016/caddy-ui` and `ghcr.io/kex1016/caddy-ui-updater` are public
     (GitHub profile → Packages → the package → Package settings → Change visibility), or run
     `docker login ghcr.io` on the server. A private package cannot be pulled.
  2. Back up `Caddyfile` and the directories the old backend used (`cp -a` is enough).
  3. Generate a session secret: `openssl rand -hex 32`. Keep it in `.env` next to your compose
     file as `CADDY_UI_SESSION_SECRET=...`, together with `CADDY_UI_PASSWORD=...`. Do not
     commit `.env`.
  4. In `compose.yml`, delete the `caddy-ui-backend` and `caddy-ui-frontend` services. Delete
     `JWT_SECRET` wherever it is set.
  5. Add this service (it is `deploy/compose.example.yml` trimmed to what you run; keep your
     own network name, which the plan assumes is `caddy-ui`):

     ```yaml
     caddy-ui:
       image: ghcr.io/kex1016/caddy-ui:1.0.0
       restart: unless-stopped
       depends_on: [caddy]
       ports: ['9876:3001']
       environment:
         TZ: Europe/Budapest
         CADDY_ADMIN_URL: http://caddy:2019
         CADDYFILE_PATH: /etc/caddy/Caddyfile
         CADDY_LOG_PATH: /var/log/caddy/access.log
         CADDY_DATA_PATH: /data/caddy
         CADDY_UI_USER: admin
         CADDY_UI_PASSWORD: ${CADDY_UI_PASSWORD:?set it in .env}
         CADDY_UI_SESSION_SECRET: ${CADDY_UI_SESSION_SECRET:?set it in .env}
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile
         - ./data:/data:ro
         - ./logs:/var/log/caddy:ro
         - ./caddy-ui:/etc/caddy-ui
       healthcheck:
         test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3001/api/health >/dev/null || exit 1']
         interval: 15s
         timeout: 5s
         retries: 5
         start_period: 20s
       networks: [caddy-ui]
     ```

     Adjust the left side of `./data:/data:ro` so Caddy's `certificates/` folder ends up at
     `/data/caddy/certificates` inside the container (if your `./data` holds `certificates/`
     directly, use `./data:/data/caddy:ro`). Use your old `CADDY_UI_USER` if you want the
     same login.
  6. Optional, for automatic updates: add the `caddy-ui-updater` service from
     `deploy/compose.example.yml` and set `CADDY_UI_COMPOSE_DIR` to the absolute path of the
     directory holding your compose file. It mounts the Docker socket, which is
     root-equivalent on the host; skip it if you would rather update by hand.
  7. Run `docker compose config` to check the file, then `docker compose up -d`. The old
     services are removed with `docker compose up -d --remove-orphans`.
  8. Open `http://<server>:9876`, sign in, and open Sites. If anything in your proxy pointed
     at the old frontend port 9877, change it to 9876.
  9. Rollback if needed: put the two old services back, remove `caddy-ui`, run
     `docker compose up -d --remove-orphans`. Your Caddyfile is the same file; the UI keeps
     its backups in `./caddy-ui/backups/`.
- [x] 2026-11-18 · Porkbun plan · Answer the two open questions in
  [docs/porkbun-plan.md](docs/porkbun-plan.md) §8 · done 18 Nov: renewals, WHOIS contacts and
  email forwarding stay out, no dynamic DNS.
- [ ] 2026-11-18 · Porkbun plan · At https://porkbun.com/account/api, check the key the server
  uses: permissions should cover DNS and domain settings but not purchases (the "Manage, but
  no purchases" preset), and if the key has an IP allowlist it must include the server's
  public IP. Each domain you want to manage needs "API access" switched on · the UI can only
  do what the key may do, and it shows which of these is missing.
- [ ] 2026-11-18 · Porkbun plan · P6 · When the Domains pages are in the image you run
  (v1.1.0, or a `main` build), give the UI the Porkbun keys. In the compose file that holds
  your `caddy-ui` service:
  1. Keep `PORKBUN_API_KEY` and `PORKBUN_API_SECRET_KEY` in `.env` next to it (they already
     are, for the `caddy` service). Do not put the values in the compose file.
  2. Add two lines to the `environment:` of `caddy-ui`, the same names `caddy` uses:
     `PORKBUN_API_KEY: ${PORKBUN_API_KEY:?set PORKBUN_API_KEY}` and
     `PORKBUN_API_SECRET_KEY: ${PORKBUN_API_SECRET_KEY:?set PORKBUN_API_SECRET_KEY}`.
  3. `docker compose config` to check, then `docker compose up -d caddy-ui`.
  4. Open Domains in the UI. The header shows the connection and the key's scopes. If it
     says changes are disabled (read-only), see the `CADDY_UI_PORKBUN_READONLY` item below.
  [docs/porkbun.md](docs/porkbun.md) has the details and a troubleshooting table · the UI is a
  separate container and does not see Caddy's environment, and the Domains area and the
  Caddy tab's DNS checks both need the keys there. Steps confirmed against the merged code
  on 19 Nov.
- [ ] 2026-11-18 · Porkbun plan · Optional: create a sandbox key pair at Porkbun (public key
  starts with `pk1_sb_`) and add both halves as GitHub Actions secrets
  `PORKBUN_SANDBOX_API_KEY` and `PORKBUN_SANDBOX_API_SECRET_KEY` · lets CI run the
  integration against Porkbun's sandbox, where nothing real is changed; without them that
  one job is skipped.
- [ ] 2026-11-18 · Porkbun plan · Replace the coordinator goal in the project's instructions
  with the block in [COORDINATOR.md](COORDINATOR.md) · the current goal ends at v1.0.0.
- [ ] 2026-11-18 · P0 · Nothing to do unless you run the UI without its own sign-in
  (`CADDY_UI_AUTH_MODE=none`, or `local` with no user and password, for example because
  tinyauth in front does the sign-in): the Domains area is then read-only by default. Add
  `CADDY_UI_PORKBUN_READONLY: "false"` to the `caddy-ui` service to allow changes. With
  `CADDY_UI_AUTH_MODE=forward` or a local user, changes are allowed without it · an open UI
  should not be able to change DNS by accident. Settings shows the value in use, and can switch it there too.
- [ ] 2026-11-19 · Settings and speed plan · When
  [docs/settings-and-perf-plan.md](docs/settings-and-perf-plan.md) should start, merge its
  PR and replace the coordinator goal in the project's instructions with the block in
  [COORDINATOR.md](COORDINATOR.md); every question in the plan is answered. For Discord notifications later: create a webhook in the
  channel that should get them (Channel settings, Integrations, Webhooks) and paste its URL
  into Settings once S5 is merged · nothing is built until then.
- [ ] 2026-11-19 · S0 · When the S0 pull request is merged, run the new build and check the page times on your
  server. `main` publishes `ghcr.io/kex1016/caddy-ui:edge` within a few minutes of the merge:
  1. Set `CADDY_UI_TAG=edge` for the `caddy-ui` service (or change its `image:` tag to `edge`) and run
     `docker compose pull caddy-ui && docker compose up -d caddy-ui`. The database upgrades itself on start
     (a second or two at most); nothing else in compose changes.
  2. Wait one minute, so the first probe cycle has run, then open Overview and Sites with the browser's
     developer tools on the Network tab. Click the document request and open its Timing: the `Server-Timing`
     entries list each step and `total`. Expected: `total` well under 100 ms, and the page complete in under a
     second.
  3. If either page is still slow, send the Timing entries and the output of
     `docker compose logs caddy-ui | grep "slow load"` in the project chat · this is how we confirm the fix on
     your disk and CPU before any Settings work starts (docs/settings-and-perf-plan.md §1.3). Go back to your
     usual tag at the v1.2.0 release.
- [ ] 2026-11-19 · S2 · Nothing is required. When the S2 build is running, open Settings once and look at
  Connections: each path has a check, and the admin API a **Test** button. A warning on the access log only means
  Caddy's JSON access log is not at `CADDY_LOG_PATH` yet (see the W4 item above) · it is the quickest way to see
  that the mounts in compose are what the UI expects.
- [ ] 2026-11-19 · S4 · To use the Updates section on your server, give the updater the shared folder. In your
  compose file, on the `caddy-ui-updater` service add one environment line (the path is the same folder your
  `caddy-ui` service mounts as its data folder, plus `/updater`; with the example compose that is
  `<compose dir>/caddy-ui/updater`):
  `CADDY_UI_UPDATE_CHANNEL_DIR: ${CADDY_UI_COMPOSE_DIR}/caddy-ui/updater`
  Then pull the new updater image (`docker compose pull caddy-ui-updater && docker compose up -d caddy-ui-updater`)
  along with the new caddy-ui. Open Settings, Updates: within a few seconds it shows the updater's last check. If
  your caddy-ui data folder is not `./caddy-ui`, point the line at `<that folder>/updater` instead · until you do,
  the section says the updater has not reported and nothing breaks.

- [ ] 2026-11-19 · S6 · Nothing is required. After the display-preferences build is running, open Settings →
  Preferences once and pick the clock, date format, landing page and default range you want. They are saved on the
  server, so they apply in every browser; a browser where you used the theme button keeps its own theme until you
  press **Use the saved default here**.
- [ ] 2026-11-19 · S3 · Nothing is required. After deploying, open Settings and press **Check everything** once:
  anything marked Problem or Check links to its fix. If it says metrics are not per host or the access log is not
  found, **Caddy helpers** turns each on as a reviewed Caddyfile change. The access log helper writes Caddy's log to
  `CADDY_LOG_PATH`, so the `caddy` and `caddy-ui` services must mount the same log directory at that path (the
  example compose file does: `/var/log/caddy`) and Caddy must be able to write there · otherwise the status-code
  and top-path charts stay empty.
- [ ] 2026-11-19 · S6 · Optional, after the v1.2.0 build is running: open Settings → Export and import and download a
  settings file once. Keep it somewhere safe; it is the quickest way to restore your settings on a new install
  (Import → Review changes → Apply). Tick the box for secrets only if you want the Discord webhook URL in it.
- [ ] 2026-11-19 · S5 · When the S5 build is running (`edge` after the merge, or v1.2.0), set up Discord notifications;
  nothing changes in compose:
  1. In Discord, open the channel's settings, **Integrations → Webhooks → New Webhook**, and press **Copy Webhook
     URL**. Treat it like a password: do not paste it into the chat, a commit or the compose file.
  2. In the UI, **Settings → Notifications**, paste it into **Discord webhook** and press **Save webhook**.
  3. Open **Site down → Edit message** and press **Send test**; the message lands in the channel marked as a test.
  4. Optional: set **Public address** (Settings → Display) to the address you open the UI at, so messages get an
     "Open site" button; and put a role in **Mention** (for example `<@&role id>`) if you want to be pinged.
  · the webhook can only be entered in the UI (D19); docs/notifications.md has the details.
- [ ] 2026-11-19 · Release · Last item: release v1.2.0. On GitHub open **Actions → release → Run workflow**, enter
  `1.2.0` as the version and run it (the notes come from `docs/releases/v1.2.0.md`). Do it after the S5 and S4 items
  above are read (the updater mount in compose is the only compose change) and CI on `main` is green. Then pull the
  new images on your server; the settings migrations run by themselves and are instant.
