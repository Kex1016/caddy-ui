#!/usr/bin/env bash
# caddy-ui updater sidecar.
#
# Checks for a new caddy-ui build every CADDY_UI_UPDATE_INTERVAL (and on a webhook when
# CADDY_UI_UPDATE_WEBHOOK_PORT is set), redeploys only the caddy-ui service, and rolls
# back to the previous image if the new container does not become healthy.
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

# Returns 0 if a new version was deployed (or rolled back), 1 if nothing changed.
update_ghcr() {
  local ref old new
  ref="$(service_image_ref)"
  [ -n "$ref" ] || { log "cannot resolve image for service '$SERVICE'"; return 1; }
  old="$(image_id "$ref")"
  compose pull --quiet "$SERVICE" >/dev/null
  new="$(image_id "$ref")"
  if [ -n "$old" ] && [ "$old" = "$new" ]; then
    log "up to date ($ref)"
    return 1
  fi
  log "new image for $ref: ${old:-none} -> $new"
  redeploy "$old" "$ref"
}

update_git() {
  local head_old head_new old ref
  if [ ! -d "$GIT_DIR/.git" ]; then
    mkdir -p "$GIT_DIR"
    git clone --quiet --branch "$GIT_BRANCH" "$GIT_URL" "$GIT_DIR"
    head_old=""
  else
    head_old="$(git -C "$GIT_DIR" rev-parse HEAD)"
    git -C "$GIT_DIR" fetch --quiet origin "$GIT_BRANCH"
    git -C "$GIT_DIR" reset --quiet --hard "origin/$GIT_BRANCH"
  fi
  head_new="$(git -C "$GIT_DIR" rev-parse HEAD)"
  if [ "$head_old" = "$head_new" ]; then
    log "up to date (git ${head_new:0:9})"
    return 1
  fi
  log "git ${head_old:0:9} -> ${head_new:0:9}, building"
  ref="$(service_image_ref)"
  old="$(image_id "$ref")"
  CADDY_UI_BUILD_CONTEXT="$GIT_DIR" compose build "$SERVICE"
  redeploy "$old" "$ref"
}

redeploy() {
  local old_id="$1" ref="$2"
  compose up -d --no-deps "$SERVICE"
  if wait_healthy; then
    log "deployed, $SERVICE is $(container_state)"
    return 0
  fi
  log "$SERVICE not healthy after ${HEALTH_TIMEOUT}s"
  if [ -n "$old_id" ]; then
    log "rolling back to $old_id"
    docker tag "$old_id" "$ref"
    compose up -d --no-deps --force-recreate "$SERVICE"
    if wait_healthy; then log "rollback ok"; else log "rollback also unhealthy, needs a human"; fi
  fi
  return 0
}

check_once() {
  # One check at a time; webhook and timer can overlap.
  exec 9>"$LOCK"
  if ! flock -n 9; then log "another check is running, skipping"; return 0; fi
  case "$SOURCE" in
    ghcr) update_ghcr || true ;;
    git)  update_git  || true ;;
    *) log "unknown CADDY_UI_UPDATE_SOURCE '$SOURCE' (ghcr or git)"; return 2 ;;
  esac
}

main() {
  case "${1:-loop}" in
    once) check_once; return ;;
    loop) ;;
    *) echo "usage: $0 [loop|once]" >&2; exit 64 ;;
  esac
  log "starting: source=$SOURCE interval=${INTERVAL}s service=$SERVICE webhook=${WEBHOOK_PORT:-off}"
  if [ -n "$WEBHOOK_PORT" ]; then
    socat "TCP-LISTEN:${WEBHOOK_PORT},reuseaddr,fork" "EXEC:${SELF_DIR}/webhook-handler.sh" &
    log "webhook listening on :$WEBHOOK_PORT"
  fi
  trap 'log "stopping"; kill 0 2>/dev/null || true; exit 0' TERM INT
  while true; do
    check_once || true
    sleep "$INTERVAL" & wait $!
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
