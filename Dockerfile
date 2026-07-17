# syntax=docker/dockerfile:1.7

# Single image for the trading-lab runtime. No build step. The `migrate`,
# `ingress`, and `worker` compose services run this image with a different
# command; ingress/worker override the entrypoint to run
# `node --experimental-transform-types` (the default CMD below is unused by compose).
FROM node:22-bookworm-slim

# pnpm via corepack (version pinned by package.json "packageManager")
RUN corepack enable
WORKDIR /app

# Install deps first for layer caching. Both @trading-platform/sdk and
# @trdlabs/backtester-sdk are fetched from their GitHub Release URLs during install
# (the legacy sibling `packages/client` COPY was dropped in the SDK cutover #55; the
# vendored @trading-platform/sdk tarball was dropped when lab moved to the published 0.5.0 release).
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile

# App source (src, migrations, drizzle.config.js, scripts, tsconfig.json, ...)
COPY . .

# Default command; overridden by each compose service.
CMD ["pnpm", "ingress"]
