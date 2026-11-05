# syntax=docker/dockerfile:1
# Caddy UI image. W0 baseline: builds the SvelteKit app and runs it on CADDY_UI_PORT (default 3001).
# W9 owns publishing (.github/workflows/publish.yml), tags and the updater (deploy/updater).

FROM node:22-alpine AS build
WORKDIR /src
# better-sqlite3 is native: prebuilt binaries are used when available, these build it from source otherwise.
RUN apk add --no-cache python3 make g++ && corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
ARG CADDY_UI_VERSION=dev
ENV CADDY_UI_VERSION=${CADDY_UI_VERSION}
RUN pnpm --filter @caddy-ui/ui build \
	&& pnpm --filter @caddy-ui/ui deploy --prod --legacy /out \
	&& cp -r apps/ui/build apps/ui/server.js /out/

FROM node:22-alpine
ARG CADDY_UI_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/Kex1016/caddy-ui" \
	org.opencontainers.image.title="caddy-ui" \
	org.opencontainers.image.description="Web UI for editing and watching a Caddy server" \
	org.opencontainers.image.version="${CADDY_UI_VERSION}"
ENV CADDY_UI_VERSION=${CADDY_UI_VERSION}
WORKDIR /app
ENV NODE_ENV=production \
	CADDY_UI_PORT=3001
COPY --from=build /out/ ./
# Runs as root on purpose: the UI rewrites the bind-mounted Caddyfile, which is usually root-owned on the
# host. Logged in DECISIONS.md; W9 may add a PUID/PGID switch.
EXPOSE 3001
VOLUME ["/etc/caddy-ui"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.CADDY_UI_PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
