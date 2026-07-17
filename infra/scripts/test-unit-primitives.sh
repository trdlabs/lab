#!/usr/bin/env bash
# test-unit-primitives.sh — contract tests for the U6 deploy primitives (F5a):
# unit-deploy.sh / unit-health.sh. Mirrors
# ../../../platform/infra/scripts/test-unit-primitives.sh's approach: a fake `docker`
# executable on PATH records every invocation's argv (never touches a real Docker daemon)
# and returns just enough canned output for the scripts' happy paths to complete.
# Assertions grep the recorded argv log.
#
#   Usage:  bash infra/scripts/test-unit-primitives.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

FAIL=0
step() { printf '[test-unit-primitives] %s\n' "$1"; }
ok()   { printf '  OK: %s\n' "$1"; }
bad()  { printf '  FAIL: %s\n' "$1" >&2; FAIL=1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

MOCK_BIN="$TMP_DIR/bin"
mkdir -p "$MOCK_BIN"
CALLS="$TMP_DIR/calls.log"
: > "$CALLS"

# Fake docker: logs argv, then returns just enough canned data for the happy-path plumbing
# in unit-health.sh / unit-deploy.sh to proceed without a real daemon.
#   - `docker compose ...` (pull/up) always succeeds UNLESS FAKE_MIGRATE_FAIL=1 and the
#     invocation is the migrate-only run-to-completion step (never the ingress/worker
#     recreate, which always contains "-d").
#   - `docker ps -a -q --filter ...` -> one fake container id.
#   - `docker inspect --format ... <cid>` -> canned Health/State/Image fields.
#   - `docker exec <cid> node -e "..."` -> succeeds UNLESS FAKE_EXEC_FAIL=1.
cat > "$MOCK_BIN/docker" <<'FAKEDOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_CALLS"
case "$1" in
  compose)
    case "$*" in
      *"--force-recreate migrate"*)
        # The migrate-only (non -d) run-to-completion step. Never matches the
        # ingress/worker recreate, which always has "-d ... ingress worker".
        if [ "${FAKE_MIGRATE_FAIL:-0}" = "1" ]; then exit 1; fi
        ;;
    esac
    exit 0
    ;;
  ps)
    echo "fakecid0001"
    ;;
  inspect)
    case "$*" in
      *Health.Status*) echo "healthy" ;;
      *State.Status*)  echo "exited" ;;
      *State.ExitCode*) echo "${FAKE_MIGRATE_EXIT_CODE:-0}" ;;
      *Config.Image*)  echo "ghcr.io/trdlabs/lab@sha256:$(printf 'e%.0s' {1..64})" ;;
      *)               echo "running" ;;
    esac
    ;;
  exec)
    if [ "${FAKE_EXEC_FAIL:-0}" = "1" ]; then exit 1; fi
    ;;
esac
exit 0
FAKEDOCKER
chmod +x "$MOCK_BIN/docker"

export FAKE_DOCKER_CALLS="$CALLS"
export PATH="$MOCK_BIN:$PATH"

# unit-deploy.sh requires .env.vps to exist (bootstrap guard) — point it at a throwaway
# fixture dir instead of depending on a real (gitignored, never-committed) .env.vps.
FIXTURE_REPO="$TMP_DIR/repo"
mkdir -p "$FIXTURE_REPO"
: > "$FIXTURE_REPO/docker-compose.yml"
: > "$FIXTURE_REPO/docker-compose.vps.yml"
: > "$FIXTURE_REPO/.env.vps"
export LAB_REPO_DIR="$FIXTURE_REPO"

DEPLOY_ID="11111111-1111-1111-1111-111111111111"
GOOD_DIGEST="ghcr.io/trdlabs/lab@sha256:$(printf 'a%.0s' {1..64})"
BAD_DIGEST_TAG="ghcr.io/trdlabs/lab:sha-abcdef1"

# ---------------------------------------------------------------------------
step "1/12 unit-deploy.sh: targeted U6 recreate (migrate -> ingress+worker)"
: > "$CALLS"
if OUT="$(bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$GOOD_DIGEST" --deploy-id "$DEPLOY_ID")"; then
  ok "unit-deploy.sh exited 0"
else
  bad "unit-deploy.sh exited non-zero: $OUT"
fi

if grep -F -- "pull migrate ingress worker" "$CALLS" >/dev/null; then
  ok "compose pull targets migrate ingress worker"
else
  bad "expected 'pull migrate ingress worker' in argv log"
fi

if grep -F -- "up --no-deps --force-recreate migrate" "$CALLS" >/dev/null; then
  ok "compose up runs migrate to completion (no -d)"
else
  bad "expected 'up --no-deps --force-recreate migrate' in argv log"
fi

if grep -F -- "up -d --no-deps --force-recreate ingress worker" "$CALLS" >/dev/null; then
  ok "compose up -d --no-deps --force-recreate targets ingress worker"
else
  bad "expected 'up -d --no-deps --force-recreate ingress worker' in argv log"
fi

if grep -F -- "office" "$CALLS" >/dev/null; then
  bad "'office' must never appear in a U6 command's argv"
else
  ok "'office' never named"
fi

if grep -F -- "--profile" "$CALLS" >/dev/null; then
  bad "unit-deploy.sh must never pass --profile (office would be included)"
else
  ok "no --profile flag ever passed"
fi

if grep -F -- " redis" "$CALLS" >/dev/null || grep -F -- " postgres" "$CALLS" >/dev/null || grep -F -- " phoenix" "$CALLS" >/dev/null; then
  bad "redis/postgres/phoenix must never be named in a U6 command's argv"
else
  ok "redis/postgres/phoenix never named"
fi

if grep -F -- "down" "$CALLS" >/dev/null; then
  bad "unit-deploy.sh must never call 'down' (and never -v)"
else
  ok "no 'down' invocation"
fi

if printf '%s' "$OUT" | grep -Fq '"ok":true'; then
  ok "prints ok:true JSON"
else
  bad "expected ok:true JSON, got: $OUT"
fi
if printf '%s' "$OUT" | python3 -c 'import json,sys; json.load(sys.stdin)' >/dev/null 2>&1; then
  ok "output is valid JSON"
else
  bad "expected valid JSON, got: $OUT"
fi

# Ordering: pull line must precede the migrate-only line must precede the ingress+worker line.
PULL_LINE="$(grep -n -F -- "pull migrate ingress worker" "$CALLS" | head -n1 | cut -d: -f1 || true)"
MIGRATE_LINE="$(grep -n -F -- "up --no-deps --force-recreate migrate" "$CALLS" | head -n1 | cut -d: -f1 || true)"
RECREATE_LINE="$(grep -n -F -- "up -d --no-deps --force-recreate ingress worker" "$CALLS" | head -n1 | cut -d: -f1 || true)"
if [ -n "$PULL_LINE" ] && [ -n "$MIGRATE_LINE" ] && [ -n "$RECREATE_LINE" ] \
   && [ "$PULL_LINE" -lt "$MIGRATE_LINE" ] && [ "$MIGRATE_LINE" -lt "$RECREATE_LINE" ]; then
  ok "sequence order: pull -> migrate (to completion) -> ingress+worker recreate"
else
  bad "sequence order violated (pull=$PULL_LINE migrate=$MIGRATE_LINE recreate=$RECREATE_LINE)"
fi

# ---------------------------------------------------------------------------
step "2/12 unit-deploy.sh: a failed migration aborts BEFORE the ingress/worker recreate"
: > "$CALLS"
FAKE_MIGRATE_FAIL=1
export FAKE_MIGRATE_FAIL
if OUT="$(bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$GOOD_DIGEST" --deploy-id "$DEPLOY_ID" 2>/dev/null)"; then
  bad "unit-deploy.sh must exit non-zero when migrate fails"
else
  ok "unit-deploy.sh exited non-zero on migrate failure"
fi
unset FAKE_MIGRATE_FAIL
if grep -F -- "up -d --no-deps --force-recreate ingress worker" "$CALLS" >/dev/null; then
  bad "ingress/worker must never be recreated after a failed migration"
else
  ok "ingress/worker recreate never reached after migrate failure"
fi
if printf '%s' "$OUT" | grep -Fq '"ok":false'; then
  ok "migrate-failure prints ok:false JSON"
else
  bad "expected ok:false JSON on migrate failure, got: $OUT"
fi

# ---------------------------------------------------------------------------
step "3/12 unit-deploy.sh: rejects a tag (non-digest) reference"
: > "$CALLS"
if bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$BAD_DIGEST_TAG" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/tag.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject a tag reference"
else
  ok "unit-deploy.sh rejected a tag reference"
fi
if grep -Fq '"ok":false' "$TMP_DIR/tag.out"; then
  ok "tag rejection prints ok:false JSON"
else
  bad "expected ok:false JSON on tag rejection, got: $(cat "$TMP_DIR/tag.out")"
fi
if [ -s "$CALLS" ]; then
  bad "rejected digest must never reach docker"
else
  ok "no docker call reached on rejected digest"
fi

# ---------------------------------------------------------------------------
step "4/12 unit-deploy.sh: rejects an unsupported unit (office is never a U6 command target)"
: > "$CALLS"
if bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit office --digest "$GOOD_DIGEST" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/unit.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject --unit office"
else
  ok "unit-deploy.sh rejected --unit office"
fi
if grep -F -- "office" "$CALLS" >/dev/null; then
  bad "'office' must never appear in argv, even for a rejected attempt"
else
  ok "'office' never named on rejected unit"
fi

# ---------------------------------------------------------------------------
step "5/12 unit-deploy.sh: rejects a digest containing an embedded double-quote, output stays one valid JSON line"
: > "$CALLS"
BAD_DIGEST_QUOTE='ghcr.io/trdlabs/lab@sha256:evil"digest'
if bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$BAD_DIGEST_QUOTE" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/quote.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject a digest containing a double-quote"
else
  ok "unit-deploy.sh rejected a digest containing a double-quote"
fi
if [ "$(wc -l < "$TMP_DIR/quote.out")" -eq 1 ]; then
  ok "quote-digest rejection prints exactly one line"
else
  bad "expected exactly one line of output, got: $(cat "$TMP_DIR/quote.out")"
fi
if python3 -c 'import json,sys; json.load(sys.stdin)' < "$TMP_DIR/quote.out" >/dev/null 2>&1; then
  ok "quote-digest rejection output is valid JSON"
else
  bad "expected valid JSON on quote-digest rejection, got: $(cat "$TMP_DIR/quote.out")"
fi

# ---------------------------------------------------------------------------
step "6/12 unit-deploy.sh: rejects a digest with an embedded newline"
: > "$CALLS"
NEWLINE_DIGEST="$(printf 'ghcr.io/trdlabs/lab@sha256:%s\nextra' "$(printf 'd%.0s' {1..64})")"
if bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$NEWLINE_DIGEST" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/newline.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject a digest with an embedded newline"
else
  ok "unit-deploy.sh rejected a digest with an embedded newline"
fi
if [ "$(wc -l < "$TMP_DIR/newline.out")" -eq 1 ]; then
  ok "newline-digest rejection prints exactly one line"
else
  bad "expected exactly one line of output, got: $(cat "$TMP_DIR/newline.out" | tr '\n' '|')"
fi

# ---------------------------------------------------------------------------
step "7/12 unit-deploy.sh: rejects an uppercase-hex digest"
: > "$CALLS"
UPPER_DIGEST="ghcr.io/trdlabs/lab@sha256:$(printf 'A%.0s' {1..64})"
if bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$UPPER_DIGEST" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/upper.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject an uppercase-hex digest"
else
  ok "unit-deploy.sh rejected an uppercase-hex digest"
fi
if grep -Fq '"ok":false' "$TMP_DIR/upper.out"; then
  ok "uppercase-hex rejection prints ok:false JSON"
else
  bad "expected ok:false JSON on uppercase-hex rejection, got: $(cat "$TMP_DIR/upper.out")"
fi

# ---------------------------------------------------------------------------
step "8/12 unit-health.sh: happy path (all checks pass)"
: > "$CALLS"
if OUT="$(bash "$SCRIPT_DIR/unit-health.sh" --env vps_staging --unit U6 --deploy-id "$DEPLOY_ID")"; then
  ok "unit-health.sh exited 0"
else
  bad "unit-health.sh exited non-zero: $OUT"
fi
if printf '%s' "$OUT" | grep -Fq '"ok":true'; then
  ok "prints ok:true JSON"
else
  bad "expected ok:true JSON, got: $OUT"
fi
if printf '%s' "$OUT" | grep -Fq '"ingress_healthz":"pass"' && printf '%s' "$OUT" | grep -Fq '"ingress_readyz":"pass"' \
   && printf '%s' "$OUT" | grep -Fq '"worker":"pass"' && printf '%s' "$OUT" | grep -Fq '"migrate":"pass"'; then
  ok "all four checks reported pass"
else
  bad "expected all four checks to report pass, got: $OUT"
fi
if grep -F -- "office" "$CALLS" >/dev/null; then
  bad "'office' must never appear in a U6 health check's argv"
else
  ok "'office' never named in health check"
fi
if grep -F -- "docker compose" "$CALLS" >/dev/null; then
  bad "unit-health.sh must use raw docker ps/inspect/exec, never docker compose (avoids requiring LAB_U6_IMAGE to resolve)"
else
  ok "no 'docker compose' invocation — raw docker ps/inspect/exec only"
fi

# ---------------------------------------------------------------------------
step "9/12 unit-health.sh: reports ok:false when the ingress read-API is unreachable"
: > "$CALLS"
FAKE_EXEC_FAIL=1
export FAKE_EXEC_FAIL
if bash "$SCRIPT_DIR/unit-health.sh" --env vps_staging --unit U6 --deploy-id "$DEPLOY_ID" > "$TMP_DIR/health-fail.out" 2>/dev/null; then
  bad "unit-health.sh must exit non-zero when the ingress read-API is unreachable"
else
  ok "unit-health.sh exited non-zero on unreachable read-API"
fi
unset FAKE_EXEC_FAIL
if grep -Fq '"ok":false' "$TMP_DIR/health-fail.out"; then
  ok "unreachable-read-API prints ok:false JSON"
else
  bad "expected ok:false JSON, got: $(cat "$TMP_DIR/health-fail.out")"
fi

# ---------------------------------------------------------------------------
step "10/12 unit-health.sh: reports ok:false when the migration did not exit 0"
: > "$CALLS"
FAKE_MIGRATE_EXIT_CODE=1
export FAKE_MIGRATE_EXIT_CODE
if bash "$SCRIPT_DIR/unit-health.sh" --env vps_staging --unit U6 --deploy-id "$DEPLOY_ID" > "$TMP_DIR/migrate-fail.out" 2>/dev/null; then
  bad "unit-health.sh must exit non-zero when migrate's last exit code was non-zero"
else
  ok "unit-health.sh exited non-zero on incomplete migration"
fi
unset FAKE_MIGRATE_EXIT_CODE
if grep -Fq '"migrate":"fail"' "$TMP_DIR/migrate-fail.out"; then
  ok "incomplete-migration prints migrate:fail"
else
  bad "expected migrate:fail, got: $(cat "$TMP_DIR/migrate-fail.out")"
fi

# ---------------------------------------------------------------------------
step "11/12 unit-deploy.sh: persists the deployed digest into .env.vps after a successful recreate"
: > "$CALLS"
PERSIST_REPO="$TMP_DIR/persist-repo"
mkdir -p "$PERSIST_REPO"
: > "$PERSIST_REPO/docker-compose.yml"
: > "$PERSIST_REPO/docker-compose.vps.yml"
PERSIST_ENV="$PERSIST_REPO/.env.vps"
{
  printf 'COMPOSE_PROJECT_NAME=trading-vps\n'
  printf 'LAB_U6_IMAGE=ghcr.io/trdlabs/lab@sha256:%s\n' "$(printf '9%.0s' {1..64})"
  printf 'TRADING_OFFICE_PATH=/opt/trading-office\n'
  printf 'SOME_OTHER_KEY=unrelated-value\n'
} > "$PERSIST_ENV"
chmod 640 "$PERSIST_ENV"
BEFORE_MODE="$(stat -c '%a' "$PERSIST_ENV")"
BEFORE_PROJ="$(grep '^COMPOSE_PROJECT_NAME=' "$PERSIST_ENV")"
BEFORE_OFFICE="$(grep '^TRADING_OFFICE_PATH=' "$PERSIST_ENV")"
BEFORE_OTHER="$(grep '^SOME_OTHER_KEY=' "$PERSIST_ENV")"

if OUT="$(LAB_REPO_DIR="$PERSIST_REPO" bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$GOOD_DIGEST" --deploy-id "$DEPLOY_ID")"; then
  ok "persist-path deploy exited 0"
else
  bad "persist-path deploy exited non-zero: $OUT"
fi
if printf '%s' "$OUT" | grep -Fq '"env_persist":"pass"'; then
  ok "reports checks.env_persist:pass"
else
  bad "expected checks.env_persist:pass, got: $OUT"
fi
if grep -Fxq "LAB_U6_IMAGE=$GOOD_DIGEST" "$PERSIST_ENV"; then
  ok "LAB_U6_IMAGE updated to the deployed digest in .env.vps"
else
  bad "expected LAB_U6_IMAGE=$GOOD_DIGEST in $PERSIST_ENV, got: $(cat "$PERSIST_ENV")"
fi
if grep -Fxq "$BEFORE_PROJ" "$PERSIST_ENV" && grep -Fxq "$BEFORE_OFFICE" "$PERSIST_ENV" \
   && grep -Fxq "$BEFORE_OTHER" "$PERSIST_ENV"; then
  ok "unrelated keys (COMPOSE_PROJECT_NAME/TRADING_OFFICE_PATH/other) byte-identical after persist"
else
  bad "expected unrelated lines untouched, got: $(cat "$PERSIST_ENV")"
fi
AFTER_MODE="$(stat -c '%a' "$PERSIST_ENV")"
if [ "$AFTER_MODE" = "$BEFORE_MODE" ]; then
  ok "file mode unchanged ($AFTER_MODE)"
else
  bad "expected file mode to stay $BEFORE_MODE, got $AFTER_MODE"
fi

# ---------------------------------------------------------------------------
step "12/12 unit-deploy.sh: a rejected deploy leaves .env.vps untouched"
: > "$CALLS"
REJECT_REPO="$TMP_DIR/reject-repo"
mkdir -p "$REJECT_REPO"
: > "$REJECT_REPO/docker-compose.yml"
: > "$REJECT_REPO/docker-compose.vps.yml"
cp -p "$PERSIST_ENV" "$REJECT_REPO/.env.vps"
BEFORE_REJECT_SUM="$(sha256sum "$REJECT_REPO/.env.vps" | cut -d' ' -f1)"
BEFORE_REJECT_MODE="$(stat -c '%a' "$REJECT_REPO/.env.vps")"
if LAB_REPO_DIR="$REJECT_REPO" bash "$SCRIPT_DIR/unit-deploy.sh" --env vps_staging --unit U6 --digest "$BAD_DIGEST_TAG" --deploy-id "$DEPLOY_ID" > "$TMP_DIR/reject-persist.out" 2>/dev/null; then
  bad "unit-deploy.sh must reject a tag reference (persist test)"
else
  ok "rejected deploy exited non-zero"
fi
if grep -Fq '"ok":false' "$TMP_DIR/reject-persist.out"; then
  ok "rejected deploy still prints ok:false JSON"
else
  bad "expected ok:false JSON, got: $(cat "$TMP_DIR/reject-persist.out")"
fi
AFTER_REJECT_SUM="$(sha256sum "$REJECT_REPO/.env.vps" | cut -d' ' -f1)"
AFTER_REJECT_MODE="$(stat -c '%a' "$REJECT_REPO/.env.vps")"
if [ "$BEFORE_REJECT_SUM" = "$AFTER_REJECT_SUM" ] && [ "$BEFORE_REJECT_MODE" = "$AFTER_REJECT_MODE" ]; then
  ok ".env.vps byte-identical and mode unchanged after a rejected deploy"
else
  bad ".env.vps was modified by a rejected deploy"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "" >&2
  echo "[test-unit-primitives] FAILED" >&2
  exit 1
fi
echo ""
echo "[test-unit-primitives] all checks passed"
