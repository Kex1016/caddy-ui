#!/usr/bin/env bash
# Behavioural tests for updater.sh using a fake docker. Run: deploy/updater/test/run.sh
set -u
# shellcheck disable=SC2034  # out/resp are read inside eval in check()
here="$(cd "$(dirname "$0")" && pwd)"
export FAKE_DIR; FAKE_DIR="$(mktemp -d)"
bin="$FAKE_DIR/bin"; mkdir -p "$bin"; cp "$here/fake-docker.sh" "$bin/docker"; chmod +x "$bin/docker"
export PATH="$bin:$PATH" CADDY_UI_UPDATE_HEALTH_TIMEOUT=3 CADDY_UI_UPDATE_LOCK="$FAKE_DIR/lock"
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi; }
reset() { rm -f "$FAKE_DIR"/*_id* "$FAKE_DIR"/calls.log; echo sha256:old > "$FAKE_DIR/local_id"; echo sha256:old > "$FAKE_DIR/running_id"; echo sha256:old > "$FAKE_DIR/remote_id"; }
run() { "$here/../updater.sh" once 2>&1; }

reset; out="$(run)"
check "no change -> up to date, no redeploy" "grep -q 'up to date' <<<\"\$out\" && ! grep -q 'compose up' $FAKE_DIR/calls.log"

reset; echo sha256:new > "$FAKE_DIR/remote_id"; out="$(run)"
check "new image -> redeploys only caddy-ui" "grep -q 'compose up -d --no-deps caddy-ui' $FAKE_DIR/calls.log && grep -q 'deployed' <<<\"\$out\""

reset; echo sha256:new > "$FAKE_DIR/remote_id"; echo sha256:new > "$FAKE_DIR/unhealthy_id"; out="$(run)"
check "unhealthy new image -> rolls back" "grep -q 'rolling back to sha256:old' <<<\"\$out\" && grep -q 'docker tag sha256:old' $FAKE_DIR/calls.log"

reset; out="$(CADDY_UI_UPDATE_INTERVAL=5s "$here/../updater.sh" loop 2>&1)"; rc=$?
check "interval under 30s rejected" "[ $rc -eq 2 ]"
out="$(CADDY_UI_UPDATE_INTERVAL=banana "$here/../updater.sh" loop 2>&1)"; rc=$?
check "garbage interval rejected" "[ $rc -eq 2 ]"
out="$(CADDY_UI_UPDATE_SOURCE=nope "$here/../updater.sh" once 2>&1)"; rc=$?
check "unknown source rejected" "[ $rc -eq 2 ]"

# webhook handler
resp="$(printf 'GET /healthz HTTP/1.1\r\n\r\n' | "$here/../webhook-handler.sh")"
check "webhook /healthz 200" "grep -q '200 OK' <<<\"\$resp\""
resp="$(printf 'POST /nope HTTP/1.1\r\nContent-Length: 0\r\n\r\n' | "$here/../webhook-handler.sh")"
check "webhook unknown path 404" "grep -q '404' <<<\"\$resp\""
resp="$(printf 'POST /update HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}' | CADDY_UI_UPDATE_WEBHOOK_SECRET=s3 "$here/../webhook-handler.sh")"
check "webhook bad signature 401" "grep -q '401' <<<\"\$resp\""
body='{}'; sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac s3 -r | cut -d' ' -f1)"
resp="$(printf 'POST /update HTTP/1.1\r\nX-Hub-Signature-256: %s\r\nContent-Length: 2\r\n\r\n{}' "$sig" | CADDY_UI_UPDATE_WEBHOOK_SECRET=s3 "$here/../webhook-handler.sh" 2>/dev/null)"
check "webhook valid signature 202" "grep -q '202' <<<\"\$resp\""

rm -rf "$FAKE_DIR"; exit $fail
