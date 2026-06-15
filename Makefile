# Thin wrappers around the documented docker compose commands.
.PHONY: demo local vps down smoke config

demo: .env.demo
	docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up --build

local: .env.local
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local up --build

vps: .env.vps
	docker compose -f docker-compose.yml -f docker-compose.vps.yml --env-file .env.vps up --build -d

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

# Validate all three merges against the committed examples.
config:
	docker compose -f docker-compose.yml -f docker-compose.demo.yml  --env-file .env.demo.example  config >/dev/null && echo "demo OK"
	docker compose -f docker-compose.yml -f docker-compose.local.yml --env-file .env.local.example config >/dev/null && echo "local OK"
	docker compose -f docker-compose.yml -f docker-compose.vps.yml   --env-file .env.vps.example   config >/dev/null && echo "vps OK"
