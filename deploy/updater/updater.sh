#!/usr/bin/env bash
# caddy-ui updater sidecar.
#
# Checks for a new caddy-ui build every CADDY_UI_UPDATE_INTERVAL (and on a webhook when
# CADDY_UI_UPDATE_WEBHOOK_PORT is set), redeploys only the caddy-ui service, and rolls
# back to the previous image if the new container does not become healthy.
#
# The Settings page of the UI talks to this script through two files in a shared directory (D13, no new
# port, no Docker socket in the UI): the UI writes control.json (interval, "check now"); this script reads
# it every CADDY_UI_UPDATE_POLL seconds and writes status.json (and last-run.json) next to it.
#
# Usage: updater.sh [loop|once]     (default: loop)
set -euo pipefail

SERVICE="${CADDY_UI_UPDATE_SERVICE:-caddy-ui}"
SOURCE="${CADDY_UI_UPDATE_SOURCE:-ghcr}"
INTERVAL_RAW="${CADDY_UI_UPDATE_INTERVAL:-1h}"
WEBHOOK_PORT="${CADDY_UI_UPDATE_WEBHOOK_PORT:-}"
HEALTH_TIMEOUT="${CADDY_UI_UPDATE_HEALTH_TIMEOUT:-90}"
GIT_URL="${CADDY_UI_UPDATE_GIT_URL:-https://github.com/Kex1016/caddy-ui.git}"
GIT_BRANCH="${CADDY_UI_UPDATE_GIT_BRANCH:-main}"
GIT_DIR="${CADDY_UI_UPDATE_GIT_DIR:-/var/lib/caddy-ui-updater/src}"
LOCK="${CADDY_UI_UPDATE_LOCK:-/tmp/caddy-ui-updater.lock}"
CHANNEL="${CADDY_UI_UPDATE_CHANNEL_DIR:-./caddy-ui/updater}"
POLL="${CADDY_UI_UPDATE_POLL:-5}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '%s updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# "30s" "5m" "1h" "2d" or bare seconds -> seconds
parse_interval() {
  local v="$1"
  case "$v" in
    *[!0-9smhd]* | "" ) return 1 ;;
  esac
  local n="${v%[smhd]}" u="${v: -1}"
  case "$u" in
    s) echo "$n" ;;
    m) echo $((n * 60)) ;;
    h) echo $((n * 3600)) ;;
    d) echo $((n * 86400)) ;;
    *) echo "$v" ;;
  esac
}

INTERVAL="$(parse_interval "$INTERVAL_RAW")" || { log "bad CADDY_UI_UPDATE_INTERVAL '$INTERVAL_RAW' (use 30s, 5m, 1h, 1d)"; exit 2; }
[ "$INTERVAL" -ge 30 ] || { log "CADDY_UI_UPDATE_INTERVAL must be at least 30s"; exit 2; }
case "$POLL" in *[!0-9]* | "") log "bad CADDY_UI_UPDATE_POLL '$POLL' (whole seconds)"; exit 2 ;; esac
[ "$POLL" -ge 1 ] || { log "CADDY_UI_UPDATE_POLL must be at least 1"; exit 2; }

now() { echo "${CADDY_UI_UPDATE_NOW:-$(date +%s)}"; }
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }

# Result of the last check, set by the update_* functions and recorded by check_once.
RESULT="" DETAIL="" LATEST_VERSION="" LATEST_ID=""

compose() { docker compose "$@"; }

service_image_ref() { compose config --images "$SERVICE" 2>/dev/null | head -n1; }
image_id()          { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }
container_id()      { compose ps -q "$SERVICE" 2>/dev/null | head -n1; }

# healthy | unhealthy | running (no healthcheck) | missing
container_state() {
  local cid; cid="$(container_id)"
  [ -n "$cid" ] || { echo missing; return; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing
}

wait_healthy() {
  local waited=0 s
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    s="$(container_state)"
    case "$s" in healthy | running) return 0 ;; esac
    sleep 3; waited=$((waited + 3))
  done
  return 1
}

image_version() { docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true; }

# Sets RESULT/DETAIL. Returns 0 if a new version was deployed (or rolled back), 1 if nothing changed.
update_ghcr() {
  local ref old new
  ref="$(service_image_ref)"
  if [ -z "$ref" ]; then
    log "cannot resolve image for service '$SERVICE'"
    RESULT=failed DETAIL="cannot resolve the image for service '$SERVICE'"
    return 1
  fi
  old="$(image_id "$ref")"
  if ! compose pull --quiet "$SERVICE" >/dev/null 2>&1; then
    log "pull of $ref failed"
    RESULT=failed DETAIL="pulling $ref failed"
    return 1
  fi
  new="$(image_id "$ref")"
  LATEST_ID="$new"
  LATEST_VERSION="$(image_version "$ref")"
  if [ -n "$old" ] && [ "$old" = "$new" ]; then
    log "up to date ($ref)"
    RESULT=up-to-date DETAIL="$ref is the newest image"
    return 1
  fi
  log "new image for $ref: ${old:-none} -> $new"
  redeploy "$old" "$ref"
}

update_git() {
  local head_old head_new old ref
  if [ ! -d "$GIT_DIR/.git" ]; then
    mkdir -p "$GIT_DIR"
    head_old=""
    if ! git clone --quiet --branch "$GIT_BRANCH" "$GIT_URL" "$GIT_DIR"; then
      RESULT=failed DETAIL="git clone failed"
      return 1
    fi
  else
    head_old="$(git -C "$GIT_DIR" rev-parse HEAD)"
    if ! { git -C "$GIT_DIR" fetch --quiet origin "$GIT_BRANCH" && git -C "$GIT_DIR" reset --quiet --hard "origin/$GIT_BRANCH"; }; then
      RESULT=failed DETAIL="git fetch failed"
      return 1
    fi
  fi
  head_new="$(git -C "$GIT_DIR" rev-parse HEAD)"
  LATEST_ID="$head_new" LATEST_VERSION="git ${head_new:0:9}"
  if [ "$head_old" = "$head_new" ]; then
    log "up to date (git ${head_new:0:9})"
    RESULT=up-to-date DETAIL="git ${head_new:0:9} is the newest commit"
    return 1
  fi
  log "git ${head_old:0:9} -> ${head_new:0:9}, building"
  ref="$(service_image_ref)"
  old="$(image_id "$ref")"
  if ! CADDY_UI_BUILD_CONTEXT="$GIT_DIR" compose build "$SERVICE"; then
    RESULT=failed DETAIL="building git ${head_new:0:9} failed"
    return 1
  fi
  redeploy "$old" "$ref"
}

redeploy() {
  local old_id="$1" ref="$2"
  compose up -d --no-deps "$SERVICE"
  if wait_healthy; then
    log "deployed, $SERVICE is $(container_state)"
    RESULT=updated DETAIL="$SERVICE is $(container_state)${LATEST_VERSION:+ on $LATEST_VERSION}"
    return 0
  fi
  log "$SERVICE not healthy after ${HEALTH_TIMEOUT}s"
  if [ -n "$old_id" ]; then
    log "rolling back to $old_id"
    docker tag "$old_id" "$ref"
    compose up -d --no-deps --force-recreate "$SERVICE"
    if wait_healthy; then
      log "rollback ok"
      RESULT=rolled-back DETAIL="${LATEST_VERSION:-the new version} was not healthy after ${HEALTH_TIMEOUT}s; went back to the previous image"
    else
      log "rollback also unhealthy, needs a human"
      RESULT=needs-attention DETAIL="the new version and the rollback are both unhealthy; $SERVICE needs a look"
    fi
  else
    RESULT=needs-attention DETAIL="$SERVICE was not healthy after ${HEALTH_TIMEOUT}s and there was no previous image to go back to"
  fi
  return 0
}

# --- channel with the UI (control.json in, status.json and last-run.json out) -------------------------------------

LAST_RUN="$CHANNEL/last-run.json"
STATUS="$CHANNEL/status.json"
CONTROL="$CHANNEL/control.json"

# Write a file atomically so the UI never reads half of it.
atomic_write() {
  local target="$1" tmp
  tmp="$(mktemp "$target.XXXXXX")" || return 1
  if cat > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$target"; then return 0; fi
  rm -f "$tmp"; return 1
}

channel_ready() { mkdir -p "$CHANNEL" 2>/dev/null && [ -w "$CHANNEL" ]; }

# control.json fields; empty output for a missing, unreadable or malformed file.
control_field() {
  [ -r "$CONTROL" ] || return 0
  jq -r --arg k "$1" '(.[$k] // empty) | tostring' "$CONTROL" 2>/dev/null || true
}

record_last_run() { # trigger started finished
  channel_ready || return 0
  jq -n --arg trigger "$1" --arg started "$(iso "$2")" --arg finished "$(iso "$3")" \
    --arg result "$RESULT" --arg message "$DETAIL" --arg latestVersion "$LATEST_VERSION" --arg latestId "$LATEST_ID" \
    '{trigger: $trigger, startedAt: $started, finishedAt: $finished, result: $result, message: $message,
      latest: (if $latestId == "" and $latestVersion == "" then null else {version: $latestVersion, id: $latestId} end)}' \
    | atomic_write "$LAST_RUN" || log "could not write $LAST_RUN"
}

# write_status checking nextCheckAt(epoch or empty) handledToken intervalSeconds intervalFrom warning
write_status() {
  channel_ready || return 0
  local last="null"
  [ -r "$LAST_RUN" ] && last="$(jq -c . "$LAST_RUN" 2>/dev/null || echo null)"
  jq -n --argjson last "$last" --arg checking "$1" --arg next "${2:+$(iso "$2")}" --arg handled "$3" \
    --argjson interval "$4" --arg from "$5" --arg warning "$6" --arg source "$SOURCE" --arg service "$SERVICE" \
    --argjson poll "$POLL" --arg now "$(iso "$(now)")" \
    '{version: 1, updatedAt: $now, source: $source, service: $service, pollSeconds: $poll,
      checking: ($checking == "true"), intervalSeconds: $interval, intervalFrom: $from,
      nextCheckAt: (if $next == "" then null else $next end), checkNowHandled: (if $handled == "" then null else $handled end),
      warning: (if $warning == "" then null else $warning end),
      latest: ($last.latest // null), lastRun: ($last | if . == null then null else del(.latest) end)}' \
    | atomic_write "$STATUS" || log "could not write $STATUS"
}

# One check at a time; webhook, timer and "check now" can overlap. Records what happened for the UI.
check_once() {
  local trigger="${1:-timer}" started finished
  exec 9>"$LOCK"
  if ! flock -n 9; then log "another check is running, skipping"; return 0; fi
  RESULT="" DETAIL="" LATEST_VERSION="" LATEST_ID=""
  started="$(now)"
  case "$SOURCE" in
    ghcr) update_ghcr || true ;;
    git)  update_git  || true ;;
    *) log "unknown CADDY_UI_UPDATE_SOURCE '$SOURCE' (ghcr or git)"; return 2 ;;
  esac
  finished="$(now)"
  [ -n "$RESULT" ] || { RESULT=failed; DETAIL="the check ended without a result"; }
  record_last_run "$trigger" "$started" "$finished"
}

# What the loop remembers between polls.
LAST_CHECK_AT="" NEXT_CHECK="" CUR_INTERVAL="" CUR_FROM="" HANDLED="" WARNING="" EFF_SECS="" EFF_FROM=""

# Sets EFF_SECS and EFF_FROM to the interval in force: control.json's when it is a valid duration of at least 30s,
# else the environment's. WARNING says why a value from the UI was ignored.
effective_interval() {
  local raw secs
  WARNING=""
  raw="$(control_field interval)"
  if [ -n "$raw" ]; then
    if secs="$(parse_interval "$raw")" && [ "$secs" -ge 30 ]; then
      EFF_SECS="$secs" EFF_FROM=control; return
    fi
    WARNING="ignored the interval '$raw' from the UI (use 30s, 5m, 1h, 1d; at least 30s)"
  fi
  EFF_SECS="$INTERVAL" EFF_FROM=env
}

# One look at control.json, then a check when one is due or asked for. Safe to call as often as you like.
poll_once() {
  local secs from token t trigger=""
  effective_interval; secs="$EFF_SECS" from="$EFF_FROM"
  LAST_CHECK_AT="${LAST_CHECK_AT:-$(now)}"
  if [ "$secs" != "$CUR_INTERVAL" ] || [ "$from" != "$CUR_FROM" ]; then
    [ -n "$CUR_INTERVAL" ] && log "interval is now ${secs}s ($from)"
    CUR_INTERVAL="$secs" CUR_FROM="$from"
    # A new interval counts from the last check, so shortening it can make a check due at once.
    NEXT_CHECK=$((LAST_CHECK_AT + secs))
  fi
  t="$(now)"
  token="$(control_field checkNow)"
  if [ -n "$token" ] && [ "$token" != "$HANDLED" ]; then
    trigger=check-now; HANDLED="$token"
  elif [ "$t" -ge "$NEXT_CHECK" ]; then
    trigger=timer
  fi
  if [ -n "$trigger" ]; then
    log "checking ($trigger)"
    write_status true "" "$HANDLED" "$CUR_INTERVAL" "$CUR_FROM" "$WARNING"
    check_once "$trigger" || true
    LAST_CHECK_AT="$(now)"
    NEXT_CHECK=$((LAST_CHECK_AT + CUR_INTERVAL))
  fi
  write_status false "$NEXT_CHECK" "$HANDLED" "$CUR_INTERVAL" "$CUR_FROM" "$WARNING"
}

main() {
  case "${1:-loop}" in
    once) check_once "${CADDY_UI_UPDATE_TRIGGER:-manual}"; return ;;
    loop) ;;
    *) echo "usage: $0 [loop|once]" >&2; exit 64 ;;
  esac
  log "starting: source=$SOURCE interval=${INTERVAL}s poll=${POLL}s service=$SERVICE webhook=${WEBHOOK_PORT:-off} channel=$CHANNEL"
  if [ -n "$WEBHOOK_PORT" ]; then
    socat "TCP-LISTEN:${WEBHOOK_PORT},reuseaddr,fork" "EXEC:${SELF_DIR}/webhook-handler.sh" &
    log "webhook listening on :$WEBHOOK_PORT"
  fi
  trap 'log "stopping"; kill 0 2>/dev/null || true; exit 0' TERM INT
  # A "check now" that was already handled before a restart must not run again.
  [ -r "$STATUS" ] && HANDLED="$(jq -r '.checkNowHandled // empty' "$STATUS" 2>/dev/null || true)"
  # The first check runs at start, as before; later ones follow the interval and control.json.
  LAST_CHECK_AT="$(( $(now) - INTERVAL ))"
  channel_ready || log "channel directory $CHANNEL is not writable; the UI cannot talk to the updater"
  while true; do
    poll_once || true
    sleep "$POLL" & wait $!
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
