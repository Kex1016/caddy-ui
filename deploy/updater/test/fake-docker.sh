#!/usr/bin/env bash
# Fake `docker` for tests. State lives in $FAKE_DIR as small files.
d="$FAKE_DIR"; echo "docker $*" >> "$d/calls.log"
case "$1" in
  compose)
    shift
    case "$1" in
      config) echo "ghcr.io/kex1016/caddy-ui:edge" ;;
      pull)   [ -f "$d/pull_fails" ] && exit 1; [ -f "$d/remote_id" ] && cp "$d/remote_id" "$d/local_id" ;;
      build)  cp "$d/remote_id" "$d/local_id" ;;
      up)     cp "$d/local_id" "$d/running_id"; echo "new" > "$d/health_phase" ;;
      ps)     echo cid1 ;;
    esac ;;
  image)
    case "$*" in
      *Labels*) cat "$d/version" 2>/dev/null ;;
      *) cat "$d/local_id" 2>/dev/null ;;
    esac ;;
  inspect)
    if [ -f "$d/unhealthy_id" ] && [ "$(cat "$d/running_id")" = "$(cat "$d/unhealthy_id")" ]; then echo unhealthy; else echo healthy; fi ;;
  tag)    cp "$d/local_id" "$d/local_id.bak"; echo "$2" > "$d/local_id" ;;
esac
