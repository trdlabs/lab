# Thin wrappers around the documented docker compose commands.
.PHONY: demo local vps dev down smoke e2e cross-repo-e2e config ghcr-login

# One-time per machine when trdlabs GHCR packages are private (org blocks public visibility):
#   gh auth refresh -h github.com -s read:packages
#   make ghcr-login
ghcr-login:
	chmod +x scripts/ghcr-login.sh
	./scripts/ghcr-login.sh

# demo pulls every first-party image (lab / mock-platform / backtester / office)
# from GHCR — built on CI, nothing compiled locally — then `up`. --ignore-buildable
# is a safety net should any service be switched back to a source build.
demo: .env.demo
	docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo pull --ignore-buildable
	docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up

local: .env.local
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build

vps: .env.vps
	docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d

# Dev (minimal-docker): infra in docker, app services on the host via mprocs (watch).
# Installs lab + backtester deps, brings up infra detached, runs migrations, then launches mprocs.
# Requires sibling repos present: ../trading-backtester (pnpm) + ../trading-office (npm).
dev: .env.dev
	pnpm install --frozen-lockfile
	set -a && . ./.env.dev && pnpm -C "$${TRADING_BACKTESTER_PATH:-../trading-backtester}" install --frozen-lockfile
	docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev up -d --wait postgres redis mock-platform
	set -a && . ./.env.dev && pnpm db:migrate
	pnpm exec mprocs

# Create the real env file from the example on first run.
.env.%:
	cp .env.$*.example .env.$*
	@echo ">> Created .env.$* from .env.$*.example — review it before production use."

down:
	-docker compose -f docker-compose.yml -f docker-compose.demo.yml down
	-docker compose -f docker-compose.yml -f docker-compose.local.yml down
	-docker compose -f docker-compose.yml -f docker-compose.vps.yml down

# Usage: make smoke MODE=demo
smoke:
	./scripts/smoke.sh $(MODE)

# Usage: make e2e [MODE=demo]   — requires running demo stack (make demo)
e2e:
	docker compose -f docker-compose.yml -f docker-compose.$(or $(MODE),demo).yml \
	  --env-file .env.$(or $(MODE),demo) exec -T ingress \
	  node --input-type=module < scripts/e2e.mjs

# Usage: make cross-repo-e2e [MODE=demo] — requires demo stack + backtester host port
cross-repo-e2e:
	chmod +x scripts/cross-repo-e2e.sh
	./scripts/cross-repo-e2e.sh $(or $(MODE),demo)

# Validate all three merges against the committed examples.
config:
	docker compose -f docker-compose.yml -f docker-compose.demo.yml  --env-file .env.demo.example  config >/dev/null && echo "demo OK"
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local.example config >/dev/null && echo "local OK"
	docker compose -f docker-compose.yml -f docker-compose.vps.yml   --env-file .env.vps.example   config >/dev/null && echo "vps OK"
	docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev.example config >/dev/null && echo "dev OK"
