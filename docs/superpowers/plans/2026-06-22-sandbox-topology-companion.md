# Sandbox Topology Companion (trading-lab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the trading-lab demo stack for DooD sandbox execution (host socket + shared named volume) and add a minimal-docker dev orchestration (`make dev` via mprocs) that runs the app services on the host with the backtester's sandbox running natively.

**Architecture:** Two independent deliverables. (A) `docker-compose.demo.yml` gives the containerized `backtester` a path to the host Docker daemon (mount `/var/run/docker.sock`) and a shared named volume `btx-sandbox` (pinned name) mounted at `/sandbox-shared`, plus the two overlay-volume env vars Part A reads. (B) A dev loop: `docker-compose.dev.yml` publishes infra ports to `127.0.0.1`, `.env.dev.example` carries host-localhost wiring, `mprocs.yaml` runs ingress/worker/backtester/office-server/office-web as host processes, and `make dev` launches it.

**Tech Stack:** Docker Compose (host 29.5.3), mprocs, Node `--experimental-transform-types`, npm (trading-office) + pnpm (trading-lab/backtester).

## Global Constraints

- **Contract from Part A (verbatim):** volume name `btx-sandbox`; backtester mountpoint `/sandbox-shared`; socket `/var/run/docker.sock`; env vars `BACKTESTER_SANDBOX_OVERLAY_VOLUME=btx-sandbox`, `BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT=/sandbox-shared`.
- **Volume name MUST be pinned** with `name: btx-sandbox` in the compose `volumes:` block — otherwise compose creates `<project>_btx-sandbox` and the backtester's `docker run --mount src=btx-sandbox` (host daemon) resolves to a different, empty volume.
- **Dev host services use `node --experimental-transform-types`, NOT `--strip-types`** (current source uses TS parameter properties strip-types can't parse; compose already overrides `pnpm ingress`/`pnpm worker` for this reason). office-server/web have their own `tsx watch` / `vite` dev scripts.
- **Dev backtester runs bind-mode:** the dev env must NOT set `BACKTESTER_SANDBOX_OVERLAY_VOLUME*` (absence → bind mode → native host docker, no DooD).
- **Demo compose must stay valid:** the existing `make config` (demo merge against `.env.demo.example`) must keep passing.
- **Do not modify sibling repos** (`../trading-office`, `../trading-backtester`) — consume them as-is via `TRADING_OFFICE_PATH` / `TRADING_BACKTESTER_PATH`.
- All host port publishes bind to `127.0.0.1` only.
- Work from the worktree root: `/home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring`.

---

### Task 1: Demo DooD wiring (`docker-compose.demo.yml`)

**Files:**
- Modify: `docker-compose.demo.yml` (the `backtester` service + a new top-level `volumes:` block)

**Interfaces:**
- Produces: a `backtester` service that mounts the host socket + the `btx-sandbox` volume at `/sandbox-shared` and sets the two overlay-volume env vars; a top-level volume `btx-sandbox` with `name: btx-sandbox`.

- [ ] **Step 1: Write the failing checks**

`docker compose config` normalizes short mount/port syntax to long form, so assert on the **raw file** (deterministic proof the wiring was authored) and separately on `config -q` (proof the merge stays valid). Run these now to confirm the file checks FAIL before the edit.

```bash
cd /home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring
F=docker-compose.demo.yml
grep -q 'docker.sock:/var/run/docker.sock' $F && echo OK-socket || echo FAIL-socket
grep -q 'btx-sandbox:/sandbox-shared' $F && echo OK-volmount || echo FAIL-volmount
grep -q 'BACKTESTER_SANDBOX_OVERLAY_VOLUME:' $F && echo OK-volenv || echo FAIL-volenv
grep -q 'BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT:' $F && echo OK-mpenv || echo FAIL-mpenv
grep -Eq '^[[:space:]]*name: btx-sandbox' $F && echo OK-volname || echo FAIL-volname
```

- [ ] **Step 2: Run to verify they fail**

Run the block above.
Expected: `FAIL-socket`, `FAIL-volmount`, `FAIL-volenv`, `FAIL-mpenv`, `FAIL-volname` (none of the wiring exists yet).

- [ ] **Step 3: Edit `docker-compose.demo.yml`**

In the `backtester:` service, add a `volumes:` key and two env entries. The service currently ends its `environment:` block with `BACKTESTER_MOCK_PLATFORM_TOKEN: "${MOCK_OPS_TOKEN:-}"` and has `expose:`/`ports:` after it. Change the `environment:` block to add the two vars, and insert a `volumes:` block right after `environment:` (before `expose:`):

```yaml
    environment:
      BACKTESTER_HOST: "0.0.0.0"
      BACKTESTER_PORT: "8080"
      BACKTESTER_AUTH_TOKEN: "${BACKTESTER_AUTH_TOKEN:-demo-backtester-token}"
      BACKTESTER_ENABLE_OVERLAY_ENGINE: "true"
      BACKTESTER_DATA_SOURCE: "mock"
      BACKTESTER_MOCK_PLATFORM_URL: "http://mock-platform:8839"
      BACKTESTER_MOCK_PLATFORM_TOKEN: "${MOCK_OPS_TOKEN:-}"
      # DooD sandbox: deliver per-run bundle + harness through a shared named volume so the
      # sandbox `docker run` (host daemon) sees the same content the backtester writes.
      BACKTESTER_SANDBOX_OVERLAY_VOLUME: "btx-sandbox"
      BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT: "/sandbox-shared"
    volumes:
      # DooD: the sandbox runner spawns sibling containers on the host daemon.
      - /var/run/docker.sock:/var/run/docker.sock
      - btx-sandbox:/sandbox-shared
```

Then add a top-level `volumes:` block at the end of the file (the demo overlay currently has none):

```yaml
volumes:
  # Pin the real volume name: the backtester references `btx-sandbox` literally via `docker run
  # --mount src=btx-sandbox` against the HOST daemon. Without `name:`, compose would create
  # `<project>_btx-sandbox` and the sandbox would mount a different, empty volume.
  btx-sandbox:
    name: btx-sandbox
```

- [ ] **Step 4: Run the checks to verify they pass + demo config still valid**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring
F=docker-compose.demo.yml
grep -q 'docker.sock:/var/run/docker.sock' $F && echo OK-socket
grep -q 'btx-sandbox:/sandbox-shared' $F && echo OK-volmount
grep -q 'BACKTESTER_SANDBOX_OVERLAY_VOLUME:' $F && echo OK-volenv
grep -q 'BACKTESTER_SANDBOX_OVERLAY_VOLUME_MOUNTPOINT:' $F && echo OK-mpenv
grep -Eq '^[[:space:]]*name: btx-sandbox' $F && echo OK-volname
# merged result still valid + the values survive normalization as source/target/name:
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config -q && echo CONFIG-VALID
make config
```
Expected: `OK-socket`, `OK-volmount`, `OK-volenv`, `OK-mpenv`, `OK-volname`, `CONFIG-VALID`, and `make config` prints `demo OK`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.demo.yml
git commit -m "feat(demo): DooD wiring — host socket + pinned btx-sandbox volume on backtester"
```

---

### Task 2: Dev env example + gitignore (`.env.dev.example`, `.gitignore`)

**Files:**
- Create: `.env.dev.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `.env.dev.example` carrying host-localhost wiring for every dev host process; `.env.dev` (generated from it) ignored by git.

- [ ] **Step 1: Create `.env.dev.example`**

```bash
cat > .env.dev.example <<'EOF'
# Dev (minimal-docker) env — app services run as HOST processes; only postgres + redis +
# mock-platform run in docker (ports published to 127.0.0.1 by docker-compose.dev.yml).
# Copy to .env.dev (make dev does this) and review. NEVER set BACKTESTER_SANDBOX_OVERLAY_VOLUME*
# here: their absence keeps the host backtester in bind mode (native docker, no DooD).

# --- sibling repo paths ---
TRADING_BACKTESTER_PATH=../trading-backtester
TRADING_OFFICE_PATH=../trading-office

# --- infra (host → dockerized infra on 127.0.0.1) ---
DATABASE_URL=postgres://lab:lab@localhost:5432/trading_lab
REDIS_URL=redis://localhost:6379

# --- mock-platform ---
MOCK_OPS_TOKEN=demo-ops-token-change-me
# sha256-hex of MOCK_OPS_TOKEN above (mock-platform validates the hash, not the raw value):
MOCK_OPS_TOKENS=6dd4bdc53b914f84f0b3a25d4b2417e3b160008b7aa63502877b23903d3f247b
MOCK_SNAPSHOT_REF=fixtures/2026-06-12-real-top5
MOCK_REPLAY_MODE=loop
MOCK_REPLAY_SPEED=1

# --- lab ingress/worker (host) ---
INGRESS_PORT=3000
READ_API_PORT=3100
LAB_BOT_RESULTS_INTEGRATION=http
LAB_OPS_READ_URL=http://localhost:8839
LAB_OPS_READ_TOKEN=demo-ops-token-change-me
TRADING_PLATFORM_INTEGRATION=backtester
BACKTESTER_API_URL=http://localhost:8080
BACKTESTER_API_TOKEN=demo-backtester-token
TRADING_LAB_CALLBACK_PUBLIC_URL=http://localhost:3000
TRADING_LAB_READ_TOKEN=
TRADING_LAB_CHAT_TOKEN=
TRADING_LAB_TASK_TOKEN=
TRADING_LAB_CALLBACK_TOKEN=
MODEL_PROVIDER=anthropic
STRATEGY_ANALYST_ADAPTER=fake
RESEARCHER_ADAPTER=fake
CRITIC_ADAPTER=fake
BUILDER_ADAPTER=fake
INTENT_CLASSIFIER_ADAPTER=fake
ANTHROPIC_API_KEY=

# --- backtester (host, BIND mode — no DooD; native docker for the sandbox) ---
BACKTESTER_HOST=127.0.0.1
BACKTESTER_PORT=8080
BACKTESTER_AUTH_TOKEN=demo-backtester-token
BACKTESTER_ENABLE_OVERLAY_ENGINE=true
BACKTESTER_DATA_SOURCE=mock
BACKTESTER_MOCK_PLATFORM_URL=http://localhost:8839
BACKTESTER_MOCK_PLATFORM_TOKEN=demo-ops-token-change-me

# --- office (host) ---
OFFICE_CONNECTOR_MODE=trading-lab
OFFICE_SERVER_PORT=8787
OFFICE_CORS_ORIGIN=http://localhost:5173
TRADING_LAB_READ_URL=http://localhost:3100
TRADING_LAB_CHAT_URL=http://localhost:3000
OFFICE_PLATFORM_ENABLED=true
TRADING_PLATFORM_READ_URL=http://localhost:8839
TRADING_PLATFORM_READ_TOKEN=demo-ops-token-change-me
OPERATOR_DOWNSTREAM_BACKTESTS=true
VITE_OFFICE_GATEWAY_URL=http://localhost:8787
EOF
```

- [ ] **Step 2: Add `.env.dev` to `.gitignore`**

Check whether `.env.dev` is already covered:

```bash
git check-ignore .env.dev && echo "already ignored" || echo "needs entry"
```

If it prints `needs entry`, append the rule (match the existing `.env.*` style if present; otherwise add an explicit line):

```bash
printf '\n# dev orchestration env (generated from .env.dev.example)\n.env.dev\n' >> .gitignore
```

If it prints `already ignored`, make no change to `.gitignore`.

- [ ] **Step 3: Verify the example is git-tracked and `.env.dev` is ignored**

```bash
git check-ignore .env.dev.example && echo "BAD: example ignored" || echo "OK: example tracked"
cp .env.dev.example .env.dev
git check-ignore .env.dev && echo "OK: .env.dev ignored" || echo "BAD: .env.dev tracked"
git status --porcelain | grep -q '\.env\.dev$' && echo "BAD: .env.dev shows in status" || echo "OK: .env.dev not in status"
```
Expected: `OK: example tracked`, `OK: .env.dev ignored`, `OK: .env.dev not in status`.

- [ ] **Step 4: Commit**

```bash
git add .env.dev.example .gitignore
git commit -m "feat(dev): .env.dev.example (host-localhost wiring) + ignore .env.dev"
```

---

### Task 3: Dev compose overlay (`docker-compose.dev.yml`)

**Files:**
- Create: `docker-compose.dev.yml`

**Interfaces:**
- Consumes: `.env.dev.example` (Task 2) for config validation; service definitions from base + demo (postgres/redis in base, mock-platform in demo).
- Produces: a `127.0.0.1` port publish for postgres `5432`, redis `6379`, mock-platform `8839`. MUST be merged on top of base **and** demo (mock-platform is defined in demo).

- [ ] **Step 1: Create `docker-compose.dev.yml`**

```bash
cat > docker-compose.dev.yml <<'EOF'
# Dev overlay (minimal-docker): publish stateful-infra ports to 127.0.0.1 so the host app
# processes (run via mprocs / `make dev`) can reach them. App services are NOT started here —
# the dev loop runs ingress/worker/backtester/office on the host. mock-platform is defined in
# docker-compose.demo.yml, so always merge as: -f docker-compose.yml -f docker-compose.demo.yml
# -f docker-compose.dev.yml.
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
  redis:
    ports:
      - "127.0.0.1:6379:6379"
  mock-platform:
    ports:
      - "127.0.0.1:8839:8839"
EOF
```

- [ ] **Step 2: Verify the dev merge parses + ports present**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring
# Raw-file proof of the authored ports (config output normalizes ports to long form):
grep -q '127.0.0.1:5432:5432' docker-compose.dev.yml && echo OK-pg || echo FAIL-pg
grep -q '127.0.0.1:6379:6379' docker-compose.dev.yml && echo OK-redis || echo FAIL-redis
grep -q '127.0.0.1:8839:8839' docker-compose.dev.yml && echo OK-mock || echo FAIL-mock
# Merged dev stack is valid (mock-platform comes from demo, so all three -f are required):
docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev.example config -q && echo OK-parse || echo FAIL-parse
```
Expected: `OK-pg`, `OK-redis`, `OK-mock`, `OK-parse`. (Only `.env.dev.example` is needed — created in Task 2.)

- [ ] **Step 3: Commit**

```bash
git add docker-compose.dev.yml
git commit -m "feat(dev): docker-compose.dev.yml — publish infra ports to 127.0.0.1"
```

---

### Task 4: mprocs config + dependency (`mprocs.yaml`, `package.json`)

**Files:**
- Create: `mprocs.yaml`
- Modify: `package.json` (add `mprocs` devDependency)

**Interfaces:**
- Consumes: `.env.dev` (sourced per-proc), `docker-compose.dev.yml` (Task 3), sibling dev commands — backtester `pnpm start`; office `npm run dev:server` / `npm run dev:web:connected`.
- Produces: `mprocs.yaml` with six procs: `infra`, `ingress`, `worker`, `backtester`, `office-server`, `office-web`.

- [ ] **Step 1: Create `mprocs.yaml`**

Each app proc sources `.env.dev` (exporting all vars via `set -a`) before exec. The `infra` proc passes the env file to compose directly.

```bash
cat > mprocs.yaml <<'EOF'
# Dev orchestration: stateful infra in docker, app services on the host (watch). The host
# backtester runs in BIND mode (no BACKTESTER_SANDBOX_OVERLAY_VOLUME* in .env.dev) so its
# sandbox `docker run` hits the host daemon natively — no DooD in dev.
#
# Run via `make dev` (creates .env.dev from the example first). Requires sibling repos present
# with deps installed: ../trading-backtester (pnpm) and ../trading-office (npm).
procs:
  infra:
    shell: "docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev up postgres redis mock-platform"

  ingress:
    shell: "set -a && . ./.env.dev && exec node --watch --experimental-transform-types src/ingress/server.ts"

  worker:
    shell: "set -a && . ./.env.dev && exec node --watch --experimental-transform-types src/worker/worker.ts"

  backtester:
    shell: "set -a && . ./.env.dev && cd \"$TRADING_BACKTESTER_PATH\" && exec pnpm start"

  office-server:
    shell: "set -a && . ./.env.dev && cd \"$TRADING_OFFICE_PATH\" && exec npm run dev:server"

  office-web:
    shell: "set -a && . ./.env.dev && cd \"$TRADING_OFFICE_PATH\" && exec npm run dev:web:connected"
EOF
```

- [ ] **Step 2: Add `mprocs` as a devDependency and install**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring
pnpm add -D mprocs
```
This updates `package.json` + `pnpm-lock.yaml` and installs the `mprocs` binary into `node_modules/.bin`.

- [ ] **Step 3: Verify mprocs is installed and the config is valid YAML with all six procs**

```bash
pnpm exec mprocs --version && echo OK-bin || echo FAIL-bin
node -e "const y=require('js-yaml'); const d=y.load(require('fs').readFileSync('mprocs.yaml','utf8')); const p=Object.keys(d.procs); const want=['infra','ingress','worker','backtester','office-server','office-web']; const miss=want.filter(w=>!p.includes(w)); if(miss.length){console.error('MISSING',miss);process.exit(1)} console.log('OK-procs',p.join(','))"
grep -q 'experimental-transform-types' mprocs.yaml && echo OK-flag || echo FAIL-flag
grep -q 'experimental-strip-types' mprocs.yaml && echo BAD-stripflag || echo OK-no-stripflag
```
Expected: `OK-bin`, `OK-procs infra,ingress,worker,backtester,office-server,office-web`, `OK-flag`, `OK-no-stripflag`.

(If `js-yaml` is not resolvable, install it transiently for the check: `pnpm exec node -e "..."` works because js-yaml is a common transitive dep; otherwise validate with `pnpm exec mprocs --config mprocs.yaml --help` which parses the file, or `python3 -c "import yaml,sys; d=yaml.safe_load(open('mprocs.yaml')); assert set(['infra','ingress','worker','backtester','office-server','office-web'])<=set(d['procs']); print('OK')"`.)

- [ ] **Step 4: Commit**

```bash
git add mprocs.yaml package.json pnpm-lock.yaml
git commit -m "feat(dev): mprocs.yaml (6 host procs) + mprocs devDependency"
```

---

### Task 5: Makefile `dev` target + `config` dev validation

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Consumes: `.env.dev.example` (Task 2), `docker-compose.dev.yml` (Task 3), `mprocs.yaml` (Task 4), the existing `.env.%` bootstrap rule.
- Produces: `make dev` (bootstraps `.env.dev`, runs `mprocs`); `make config` additionally validates the dev merge.

- [ ] **Step 1: Edit the `.PHONY` line and add the `dev` target**

The current first lines are:
```make
.PHONY: demo local vps down smoke e2e cross-repo-e2e config
```
Change to include `dev`:
```make
.PHONY: demo local vps dev down smoke e2e cross-repo-e2e config
```
Add the `dev` target immediately after the `vps:` target block (before the `.env.%:` rule):
```make
# Dev (minimal-docker): infra in docker, app services on the host via mprocs (watch).
# Requires sibling repos with deps installed: ../trading-backtester, ../trading-office.
dev: .env.dev
	pnpm exec mprocs
```

- [ ] **Step 2: Extend the `config` target to validate the dev merge**

The current `config` target is:
```make
config:
	docker compose -f docker-compose.yml -f docker-compose.demo.yml  --env-file .env.demo.example  config >/dev/null && echo "demo OK"
```
Replace it with:
```make
config:
	docker compose -f docker-compose.yml -f docker-compose.demo.yml  --env-file .env.demo.example  config >/dev/null && echo "demo OK"
	docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.dev.yml --env-file .env.dev.example config >/dev/null && echo "dev OK"
```

- [ ] **Step 3: Verify both targets**

```bash
cd /home/alexxxnikolskiy/projects/trading-lab/.worktrees/feat/sandbox-dood-lab-wiring
make config
make -n dev
```
Expected: `make config` prints both `demo OK` and `dev OK`. `make -n dev` shows the `.env.dev` bootstrap (if absent) and `pnpm exec mprocs` without executing it.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "feat(dev): make dev (mprocs) + make config validates the dev merge"
```

---

## Final verification (after all tasks)

- [ ] `make config` → prints `demo OK` and `dev OK`.
- [ ] Demo DooD wiring present: `docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo.example config | grep -E 'docker.sock|btx-sandbox|name: btx-sandbox|BACKTESTER_SANDBOX_OVERLAY_VOLUME'` shows the socket mount, both volume references, the pinned name, and both env vars.
- [ ] `git status` clean; `.env.dev` not tracked; only the six intended files changed (`docker-compose.demo.yml`, `docker-compose.dev.yml`, `.env.dev.example`, `.gitignore`, `mprocs.yaml`, `package.json`/`pnpm-lock.yaml`, `Makefile`).
- [ ] No sibling repo (`../trading-office`, `../trading-backtester`) was modified.

## Acceptance (initiative DoD — manual, after Part A is on backtester main)

Not part of the automated task verification (requires the full stack + a real model/run), but this is what the change exists to enable:

- **demo:** `make demo` brings up the stack; a research backtest runs end-to-end — the sandbox spawns as a host sibling container via the mounted socket, reads bundle + harness from the `btx-sandbox` volume, the backtester POSTs `backtest-completed`, and trading-lab reaches a real `backtest.completed` → operator proactive message (organically, no `/tasks` injection).
- **dev:** `make dev` brings up infra in docker + app services on the host; submitting a research backtest runs the backtester's sandbox natively (bind mode, no DooD).
