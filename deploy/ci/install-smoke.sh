#!/usr/bin/env bash
# W11: follow docs/install.md and the compose swap in TODO-USER.md on a CI runner, against a locally built image.
#
#   1. "Before": a compose project shaped like David's: Caddy plus the two zackwag services (stand-ins that just
#      sleep, with the JWT_SECRET they used), on the caddy-ui network, with his anonymised Caddyfile.
#   2. The swap, step by step: .env with a generated secret (step 3), the old services and JWT_SECRET removed
#      (step 4), the `caddy-ui` service block copied verbatim out of TODO-USER.md (step 5, image swapped for the
#      local build), `docker compose config` and `up -d --remove-orphans` (step 7).
#   3. Checks: the old containers are gone, caddy-ui turns healthy, sign-in works on 9876, Sites lists the
#      Caddyfile's sites, a save through the UI writes the bind-mounted Caddyfile and reaches Caddy (step 8).
#   4. Rollback (step 9): the old services come back, caddy-ui goes, backups are in ./caddy-ui/backups.
#
# Usage: deploy/ci/install-smoke.sh <image>   (default caddy-ui:ci)
set -euo pipefail

IMAGE=${1:-caddy-ui:ci}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
cd "$WORK"
trap 'cd "$WORK"; docker compose logs --no-color > compose.log 2>&1 || true; echo "work dir: $WORK"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() {
	echo "FAIL: $*" >&2
	docker compose ps -a || true
	docker compose logs --no-color --tail 80 || true
	exit 1
}

step "Before: Caddy and the two zackwag services, like David's compose"
# His Caddyfile, anonymised, with certificate requests off and unprivileged ports so a runner can serve it.
node --input-type=module -e "
import { e2eCaddyfile } from '$ROOT/e2e/support/paths.mjs';
process.stdout.write(e2eCaddyfile());
" > Caddyfile
mkdir -p data logs
cat > compose.yml <<'YAML'
name: home
services:
  caddy:
    image: ${CADDY_IMAGE:-caddy:2}
    restart: unless-stopped
    ports: ['18080:18080']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - ./data:/data
      - ./logs:/var/log/caddy
    networks: [caddy-ui]
  caddy-ui-backend:
    image: busybox:1.36
    command: ['sleep', 'infinity']
    environment:
      JWT_SECRET: not-a-real-secret
    networks: [caddy-ui]
  caddy-ui-frontend:
    image: busybox:1.36
    command: ['sleep', 'infinity']
    networks: [caddy-ui]
networks:
  caddy-ui:
    name: caddy-ui
YAML
cp compose.yml compose.before.yml
docker compose up -d --quiet-pull
docker compose ps --services --status running | sort | tr '\n' ' '
echo

step "Step 2: back up the Caddyfile"
cp -a Caddyfile Caddyfile.bak

step "Step 3: .env with a generated session secret and a password"
printf 'CADDY_UI_SESSION_SECRET=%s\nCADDY_UI_PASSWORD=%s\n' "$(openssl rand -hex 32)" 'smoke-password' > .env

step "Steps 4 and 5: remove the old services and JWT_SECRET, add caddy-ui from TODO-USER.md"
# The yaml block of the swap item in TODO-USER.md, dedented. If the doc changes shape, this fails loudly.
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const doc = readFileSync('$ROOT/TODO-USER.md', 'utf8');
const item = doc.slice(doc.indexOf('Swap \`caddy-ui-backend\` and \`caddy-ui-frontend\`'));
const m = item.match(/\n( *)\`\`\`yaml\n([\s\S]*?)\n *\`\`\`/);
if (!m) { console.error('no yaml block in the compose swap item of TODO-USER.md'); process.exit(1); }
const pad = m[1].length;
process.stdout.write(m[2].split('\n').map((l) => l.slice(pad)).join('\n') + '\n');
" > caddy-ui.service.yml
cat caddy-ui.service.yml
grep -q '^caddy-ui:' caddy-ui.service.yml || fail "the TODO-USER.md block is not a caddy-ui service"
# Only the image changes: the local build stands in for ghcr.io/kex1016/caddy-ui:1.0.0.
sed -i -E "s#image: ghcr.io/kex1016/caddy-ui:[^ ]+#image: $IMAGE#" caddy-ui.service.yml
{
	sed -n '1,/^  caddy-ui-backend:/p' compose.before.yml | sed '$d'
	sed 's/^/  /' caddy-ui.service.yml
	sed -n '/^networks:/,$p' compose.before.yml
} > compose.yml
grep -q JWT_SECRET compose.yml && fail "JWT_SECRET is still in compose.yml"
grep -q 'caddy-ui-backend\|caddy-ui-frontend' compose.yml && fail "an old service is still in compose.yml"

step "Step 7: docker compose config, then up -d --remove-orphans"
docker compose config -q
docker compose up -d --remove-orphans --quiet-pull
for svc in caddy-ui-backend caddy-ui-frontend; do
	[ -z "$(docker compose ps -a -q "$svc" 2>/dev/null)" ] || fail "$svc is still there after --remove-orphans"
done
cid=$(docker compose ps -q caddy-ui)
for i in $(seq 1 60); do
	state=$(docker inspect -f '{{.State.Health.Status}}' "$cid")
	[ "$state" = healthy ] && break
	[ "$i" = 60 ] && fail "caddy-ui is $state after 120 s"
	sleep 2
done
echo "caddy-ui is healthy"

step "Step 8: open :9876, sign in, open Sites"
BASE=http://localhost:9876
curl -fsS "$BASE/api/health"
echo
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/sites")
[ "$code" = 303 ] || [ "$code" = 302 ] || fail "/sites without a session answered $code, expected a redirect to sign-in"
# Accept: text/html, as a browser sends; with curl's */* SvelteKit answers a form action with JSON and a 200.
code=$(curl -s -o /dev/null -w '%{http_code}' -c jar -H "Origin: $BASE" -H 'Accept: text/html' \
	--data-urlencode 'user=admin' --data-urlencode 'password=smoke-password' "$BASE/login")
[ "$code" = 303 ] || [ "$code" = 302 ] || fail "sign-in answered $code"
sites=$(curl -fsS -b jar "$BASE/sites")
for host in auth.example.com prox.example.com yt.example.net; do
	grep -q "$host" <<<"$sites" || fail "Sites does not list $host"
done
echo "Sites lists the Caddyfile's sites"
status=$(curl -fsS -b jar "$BASE/api/caddy/status")
echo "$status"
jq -e '.reachable == true' <<<"$status" >/dev/null || fail "the UI cannot reach Caddy's admin API"

step "A save through the UI writes the bind-mounted Caddyfile and reloads Caddy"
doc=$(curl -fsS -b jar "$BASE/api/caddyfile")
hash=$(jq -r .hash <<<"$doc")
text=$(jq -r .text <<<"$doc" | sed 's/reverse_proxy 10.0.0.101:11004/reverse_proxy 10.0.0.101:11005/')
jq -n --arg text "$text" --arg hash "$hash" '{text: $text, baseHash: $hash, note: "install smoke"}' |
	curl -fsS -b jar -X PUT -H 'content-type: application/json' -H "Origin: $BASE" --data @- "$BASE/api/caddyfile" |
	jq -e '.changed == true' >/dev/null || fail "the save was not applied"
grep -q '10.0.0.101:11005' Caddyfile || fail "the Caddyfile on the host was not rewritten"
docker compose exec -T caddy wget -qO- http://127.0.0.1:2019/config/ | grep -q '10.0.0.101:11005' ||
	fail "Caddy did not load the saved config"
echo "saved, on the host and in Caddy"

step "Step 9: rollback to the old services"
cp compose.before.yml compose.yml
docker compose up -d --remove-orphans --quiet-pull
[ -z "$(docker compose ps -a -q caddy-ui 2>/dev/null)" ] || fail "caddy-ui is still there after the rollback"
running=$(docker compose ps --services --status running | sort | tr '\n' ' ')
[ "$running" = "caddy caddy-ui-backend caddy-ui-frontend " ] || fail "after the rollback running: $running"
ls caddy-ui/backups | grep -q . || fail "no backups in ./caddy-ui/backups"
echo "old services back; backups kept in ./caddy-ui/backups: $(ls caddy-ui/backups | wc -l)"

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
echo
echo "install and compose swap: OK"
