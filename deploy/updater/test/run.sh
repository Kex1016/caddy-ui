#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2329,SC1091  # out/resp and the helpers are used inside eval in check(); sources are dynamic
# Behavioural tests for updater.sh using a fake docker. Run: deploy/updater/test/run.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
export FAKE_DIR; FAKE_DIR="$(mktemp -d)"
bin="$FAKE_DIR/bin"; mkdir -p "$bin"; cp "$here/fake-docker.sh" "$bin/docker"; chmod +x "$bin/docker"
export PATH="$bin:$PATH" CADDY_UI_UPDATE_HEALTH_TIMEOUT=3 CADDY_UI_UPDATE_LOCK="$FAKE_DIR/lock"
export CADDY_UI_UPDATE_CHANNEL_DIR="$FAKE_DIR/channel"
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FAIL - $1"; fail=1; fi; }
reset() { rm -rf "$FAKE_DIR"/*_id* "$FAKE_DIR"/calls.log "$FAKE_DIR"/pull_fails "$FAKE_DIR/channel"; echo 1.0.0 > "$FAKE_DIR/version"; echo sha256:old > "$FAKE_DIR/local_id"; echo sha256:old > "$FAKE_DIR/running_id"; echo sha256:old > "$FAKE_DIR/remote_id"; }
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

# --- channel with the UI: status.json, control.json, polling ---------------------------------------------------
ch="$FAKE_DIR/channel"
st() { jq -r "$1" "$ch/status.json"; }
lr() { jq -r "$1" "$ch/last-run.json"; }
ctl() { mkdir -p "$ch"; printf '%s' "$1" > "$ch/control.json"; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }

reset; out="$(CADDY_UI_UPDATE_TRIGGER=webhook run)"
check "up to date is recorded for the UI" "[ \"\$(lr .result)\" = up-to-date ] && [ \"\$(lr .trigger)\" = webhook ]"

reset; echo sha256:new > "$FAKE_DIR/remote_id"; echo 1.1.0 > "$FAKE_DIR/version"; out="$(run)"
check "an update records the new version as latest" "[ \"\$(lr .latest.version)\" = 1.1.0 ] && [ \"\$(lr .result)\" = updated ]"

reset; echo sha256:new > "$FAKE_DIR/remote_id"; echo sha256:new > "$FAKE_DIR/unhealthy_id"; out="$(run)"
check "a rollback is recorded" "[ \"\$(lr .result)\" = rolled-back ]"

reset; touch "$FAKE_DIR/pull_fails"; out="$(run)"
check "a failed pull is recorded, not reported as up to date" "[ \"\$(lr .result)\" = failed ] && ! grep -q 'up to date' <<<\"\$out\""

# poll_once with a fake clock: each call is one poll of the loop, state carried in a file between calls.
poll() { ( export CADDY_UI_UPDATE_NOW="$1" CADDY_UI_UPDATE_INTERVAL="${2:-1h}"; source "$here/../updater.sh"; set +e
    [ -f "$FAKE_DIR/state" ] && source "$FAKE_DIR/state"
    poll_once >/dev/null 2>&1
    declare -p NEXT_CHECK CUR_INTERVAL CUR_FROM HANDLED LAST_CHECK_AT > "$FAKE_DIR/state" ); }
pulls() { grep -c 'compose pull' "$FAKE_DIR/calls.log" 2>/dev/null || echo 0; }

reset; rm -f "$FAKE_DIR/state"; T=1000000
poll $T 1h
check "the first poll shows the interval from the environment" "[ \"\$(st .intervalSeconds)\" = 3600 ] && [ \"\$(st .intervalFrom)\" = env ]"
check "the first poll does not check yet" "[ \"\$(pulls)\" = 0 ]"
poll $((T+5)) 1h
check "no check before the interval is up" "[ \"\$(pulls)\" = 0 ]"
ctl '{"version":1,"interval":"5m","checkNow":null}'
poll $((T+10)) 1h
check "a changed interval is picked up within one poll" "[ \"\$(st .intervalSeconds)\" = 300 ] && [ \"\$(st .intervalFrom)\" = control ]"
check "and it moves the next check" "[ \"\$(st .nextCheckAt)\" = \"\$(iso $((T+300)))\" ]"
ctl '{"version":1,"interval":"5m","checkNow":"abc"}'
poll $((T+15)) 1h
check "check now runs a check within one poll" "[ \"\$(pulls)\" = 1 ] && [ \"\$(st .checkNowHandled)\" = abc ] && [ \"\$(st .lastRun.trigger)\" = check-now ]"
poll $((T+20)) 1h
check "the same check-now token does not run twice" "[ \"\$(pulls)\" = 1 ]"
ctl '{"version":1,"interval":"5m","checkNow":"def"}'
poll $((T+25)) 1h
check "a new check-now token runs again" "[ \"\$(pulls)\" = 2 ]"
poll $((T+25+301)) 1h
check "the timer runs a check when the interval is up" "[ \"\$(pulls)\" = 3 ] && [ \"\$(st .lastRun.trigger)\" = timer ]"
ctl '{"version":1,"interval":"banana","checkNow":"def"}'
poll $((T+25+302)) 1h
check "a bad interval from the UI is ignored with a warning" "[ \"\$(st .intervalFrom)\" = env ] && [ \"\$(st .warning)\" != null ]"
ctl '{"version":1,"interval":"10s","checkNow":"def"}'
poll $((T+25+303)) 1h
check "an interval under 30s from the UI is ignored" "[ \"\$(st .intervalSeconds)\" = 3600 ]"
ctl '{"version":1,"interval":null,"checkNow":"def"}'
poll $((T+25+304)) 30m
check "removing the UI interval falls back to the environment" "[ \"\$(st .intervalSeconds)\" = 1800 ] && [ \"\$(st .intervalFrom)\" = env ]"
printf 'not json' > "$ch/control.json"
poll $((T+25+305)) 30m
check "a malformed control file is survived" "[ \"\$(st .intervalSeconds)\" = 1800 ]"

rm -rf "$FAKE_DIR"; exit $fail
