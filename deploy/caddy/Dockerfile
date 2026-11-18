# Caddy with the Porkbun DNS plugin (github.com/caddy-dns/porkbun).
#
# The plugin lets Caddy solve ACME DNS-01 challenges at Porkbun: wildcard certificates, and
# certificates for hosts that cannot be reached on port 80/443. Caddy UI itself does not need
# this image to manage domains; it only needs it for the Caddy tie-in (guided `dns porkbun`
# forms, see docs/porkbun.md).
#
# Build:   docker build -t caddy-porkbun:local deploy/caddy
# Newer Caddy:  docker build --build-arg CADDY_VERSION=2.11 -t caddy-porkbun:local deploy/caddy
# Rebuild after every Caddy release you want to follow; the `caddy:<version>` runtime image
# does not update the plugin build by itself.
ARG CADDY_VERSION=2.11

FROM caddy:${CADDY_VERSION}-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/porkbun

FROM caddy:${CADDY_VERSION}
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
