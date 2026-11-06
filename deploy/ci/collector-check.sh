#!/usr/bin/env bash
# W4 definition of done, shortened for CI: against a real Caddy the overview shows non-zero requests, every
# site has a probe state, and a down upstream shows as down. Expects caddy on localhost:8080 and the UI on
# localhost:3001 (see the collector job in .github/workflows/ci.yml).
set -euo pipefail

api() { curl -fsS "http://localhost:3001$1"; }

echo "Sending traffic through Caddy"
for _ in $(seq 1 40); do
	curl -s -o /dev/null -H 'Host: up.test' http://localhost:8080/ || true
	curl -s -o /dev/null -H 'Host: down.test' http://localhost:8080/ || true
done

echo "Waiting for a closed metrics minute (up to 150s)"
for i in $(seq 1 75); do
	n=$(api '/api/overview?range=1h' | jq '.tiles.requests.value // 0')
	if [ "$n" != "0" ]; then break; fi
	if [ "$((i % 10))" = 0 ]; then curl -s -o /dev/null -H 'Host: up.test' http://localhost:8080/ || true; fi
	sleep 2
done

overview=$(api '/api/overview?range=1h')
sites=$(api /api/sites)
echo "$overview" | jq '{tiles, sources}'
echo "$sites" | jq '[.sites[] | {label, status, upstreams: [.upstreams[] | {address, status}]}]'

fail() { echo "FAIL: $*"; exit 1; }
[ "$(echo "$overview" | jq '.tiles.requests.value')" -gt 0 ] || fail "overview shows no requests"
[ "$(echo "$sites" | jq '[.sites[] | select(.status == "unknown")] | length')" = 0 ] || fail "a site has no probe state"
[ "$(echo "$sites" | jq -r '.sites[] | select(.label == "http://up.test") | .status')" = up ] || fail "up.test is not up"
[ "$(echo "$sites" | jq -r '.sites[] | select(.label == "http://down.test") | .status')" = down ] || fail "down.test is not down"
[ "$(echo "$sites" | jq -r '.sites[] | select(.label == "http://down.test") | .upstreams[0].status')" = down ] ||
	fail "the closed upstream is not down"
[ "$(echo "$overview" | jq '.sources.metrics.ok')" = true ] ||
	fail "Caddy's /metrics could not be read: $(echo "$overview" | jq -r '.sources.metrics.error')"
id=$(echo "$sites" | jq -r '.sites[] | select(.label == "http://up.test") | .id')
stats=$(api "/api/sites/$id/stats?range=1h")
echo "$stats" | jq '{totals, source: .series.requests.source, top}'
[ "$(echo "$stats" | jq '.totals.requests')" -gt 0 ] || fail "up.test stats show no requests"
echo "Collector check passed"
