#!/usr/bin/env bash
# Minimal HTTP handler run by socat for each connection. Accepts POST /update from a
# GitHub push webhook (or curl) and triggers one update check in the background.
#
# If CADDY_UI_UPDATE_WEBHOOK_SECRET is set, requests must carry a valid
# X-Hub-Signature-256 (GitHub) or an `Authorization: Bearer <secret>` header.
# Without a secret the endpoint still only triggers a check of the configured source,
# never runs caller-supplied input, but you should not expose it to the internet.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRET="${CADDY_UI_UPDATE_WEBHOOK_SECRET:-}"

reply() { printf 'HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$1" "${#2}" "$2"; }

read -r request_line || exit 0
method="${request_line%% *}"; rest="${request_line#* }"; path="${rest%% *}"
length=0 sig="" auth=""
while IFS= read -r line; do
  line="${line%$'\r'}"
  [ -n "$line" ] || break
  k="${line%%:*}"; v="${line#*: }"
  case "${k,,}" in
    content-length) length="$v" ;;
    x-hub-signature-256) sig="$v" ;;
    authorization) auth="$v" ;;
  esac
done
body=""
[[ "$length" =~ ^[0-9]+$ ]] || length=0
[ "$length" -gt 1048576 ] && { reply "413 Payload Too Large" "too large"; exit 0; }
[ "$length" -gt 0 ] && body="$(head -c "$length")"

if [ "$method" = "GET" ] && [ "$path" = "/healthz" ]; then reply "200 OK" "ok"; exit 0; fi
if [ "$method" != "POST" ] || [ "$path" != "/update" ]; then reply "404 Not Found" "POST /update"; exit 0; fi

if [ -n "$SECRET" ]; then
  expected="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)"
  if [ "$sig" != "$expected" ] && [ "$auth" != "Bearer $SECRET" ]; then
    reply "401 Unauthorized" "bad signature"; exit 0
  fi
fi

( CADDY_UI_UPDATE_TRIGGER=webhook "$SELF_DIR/updater.sh" once >/proc/1/fd/1 2>&1 & ) 
reply "202 Accepted" "update check started"
