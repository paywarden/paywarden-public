FROM node:20-alpine AS base
RUN npm install -g pnpm@10.33.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Build dashboard frontend
FROM base AS dashboard
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY dashboard/ ./
RUN pnpm build

# Build checkout frontend
FROM base AS checkout
WORKDIR /app/checkout
COPY checkout/package.json checkout/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY checkout/ ./
RUN pnpm build

# Runtime image: lean, production-deps only, no dev tooling.
# Healthcheck uses the liveness endpoint (no business-state coupling).
#
# IMPORTANT: this is NOT the last stage in the Dockerfile (the migrate stage
# below is). Plain `docker build .` therefore defaults to building `migrate`,
# not `runtime`. Always pass `--target runtime` explicitly when you want the
# app server image:
#   docker build --target runtime -t paywarden:<tag> .
FROM base AS runtime
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=dashboard /app/dashboard/dist ./dashboard/dist
COPY --from=checkout /app/checkout/dist ./checkout/dist
COPY package.json ./
RUN mkdir -p vault events && chown node:node vault events

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/api/v1/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# Dedicated migration image. Ships drizzle-kit + migration SQL + config so
# deployments can run migrations explicitly without pulling source code.
# Build with: docker build --target migrate -t paywarden-migrate:<tag> .
FROM base AS migrate
ARG GIT_REVISION=unknown
LABEL org.opencontainers.image.revision=$GIT_REVISION
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json drizzle.config.ts ./
COPY src/db/ ./src/db/
USER node
CMD ["pnpm", "exec", "drizzle-kit", "migrate"]
