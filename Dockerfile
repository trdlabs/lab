# syntax=docker/dockerfile:1.7

# Single image for the trading-lab runtime. No build step. The `migrate`,
# `ingress`, and `worker` compose services run this image with a different
# command; ingress/worker override the entrypoint to run
# `node --experimental-transform-types` (the default CMD below is unused by compose).
FROM node:22-bookworm-slim

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable
WORKDIR /app

# Install deps first for layer caching. The vendored SDK tarball referenced by
# package.json (file:./vendor/...) must be present before install.
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
COPY --from=trading_backtester /packages/client/package.json /trading-backtester/packages/client/package.json
COPY --from=trading_backtester /packages/client/dist /trading-backtester/packages/client/dist
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# App source (src, migrations, drizzle.config.js, scripts, tsconfig.json, ...)
COPY . .

# Default command; overridden by each compose service.
CMD ["pnpm", "ingress"]
