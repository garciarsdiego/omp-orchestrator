#!/usr/bin/env bash
# Local Compose smoke for the two-service preview (Linux + Docker Compose v2).
#
# Covers: bearer auth and health/readiness, token absent from the sidecar,
# pinned OMP in the image, a fake command-json agent job executed by the
# sidecar, idempotency, restart persistence, sidecar restart while a job runs
# (must end "interrupted", no replay), abort, and backup/restore of SQLite plus
# a CAS artifact into a fresh volume.
#
# Loopback only, fake engines only: no provider credentials, quota or network
# exposure. It creates its own Compose project, volumes and throwaway token,
# and removes them at the end unless KEEP=1 (then prints how to tear down).
#
# Usage: test/compose/smoke.sh [down]    Env: PORT RESTORE_PORT IMAGE PROJECT ROUNDS KEEP
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${PROJECT:-omp-smoke}"
PORT="${PORT:-18180}"
RESTORE_PORT="${RESTORE_PORT:-18181}"
IMAGE="${IMAGE:-omp-orchestrator:smoke}"
ROUNDS="${ROUNDS:-3}"
KEEP="${KEEP:-0}"
QA="${QA_DIR:-$HOME/.cache/omp-orchestrator-smoke/$PROJECT}"
RESTORE_VOLUME="$PROJECT-restore"
RESTORED="$PROJECT-restored"

step() { printf '\n== %s\n' "$*"; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

rm -rf "$QA"; mkdir -p "$QA"; chmod 700 "$QA"
( umask 077
  openssl rand -base64 48 | tr -d '\n' > "$QA/access-token"
  # The token reaches curl through a header file, never through argv.
  printf 'Authorization: Bearer %s\n' "$(cat "$QA/access-token")" > "$QA/auth-header" )
cat > "$QA/backends.json" <<'EOF'
{ "backends": [
  { "id": "fake-command", "type": "command-json", "executable": "/usr/local/bin/node",
    "args": ["/opt/omp-orchestrator/fixtures/command-json-fake.mjs", "success"] },
  { "id": "fake-hang", "type": "command-json", "executable": "/usr/local/bin/node",
    "args": ["/opt/omp-orchestrator/fixtures/command-json-fake.mjs", "hang"] } ] }
EOF
cat > "$QA/override.yaml" <<EOF
services:
  orchestrator:
    image: $IMAGE
    environment: { OMP_ORCHESTRATOR_BACKENDS_FILE: /run/omp-orchestrator/backends.json }
    volumes: [ "$QA/backends.json:/run/omp-orchestrator/backends.json:ro" ]
  agent-worker:
    image: $IMAGE
    environment: { OMP_ORCHESTRATOR_BACKENDS_FILE: /run/omp-orchestrator/backends.json }
    volumes: [ "$QA/backends.json:/run/omp-orchestrator/backends.json:ro" ]
EOF
export OMP_ORCHESTRATOR_HOST_PORT="$PORT" OMP_ORCHESTRATOR_TOKEN_FILE="$QA/access-token" \
  OMP_ORCHESTRATOR_PUBLIC_ORIGIN="http://127.0.0.1:$PORT"

dc() { docker compose -p "$PROJECT" -f "$REPO/compose.yaml" -f "$QA/override.yaml" "$@"; }
base="http://127.0.0.1:$PORT"
rbase="http://127.0.0.1:$RESTORE_PORT"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
call() { curl -s -H @"$QA/auth-header" -H 'Content-Type: application/json' -X POST "$1/api/call" -d "$2"; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
agent_get() { call "$1" "{\"name\":\"omp_agent_get\",\"arguments\":{\"id\":\"$2\"}}"; }
agent_create() { # base backend key prompt
  call "$1" "{\"name\":\"omp_agent_create\",\"arguments\":{\"backend\":\"$2\",\"workspace\":\"smoke\",\"prompt\":\"$4\",\"idempotencyKey\":\"$3\",\"timeoutMs\":120000,\"confirmQuota\":true}}" | field id; }
wait_status() { # base id regex seconds -> prints last status
  local s=""; for _ in $(seq 1 $(( $4 * 4 ))); do
    s=$(agent_get "$1" "$2" | field status); [[ "$s" =~ $3 ]] && break; sleep 0.25; done; echo "$s"; }
wait_code() { # url expected seconds [curl args]
  local url="$1" want="$2" secs="$3"; shift 3
  for _ in $(seq 1 "$secs"); do [ "$(code "$@" "$url")" = "$want" ] && return 0; sleep 1; done; return 1; }
worker_pid() { dc exec -T agent-worker node --input-type=module -e "
  const s = await import('/opt/omp-orchestrator/mcp/storage.mjs');
  const row = s.getDatabase().prepare('SELECT payload FROM jobs WHERE id = ?').get('$1');
  console.log(JSON.parse(row.payload).workerPid);"; }

teardown() {
  docker rm -f "$RESTORED" >/dev/null 2>&1 || true
  dc down -v >/dev/null 2>&1 || true
  docker volume rm "$RESTORE_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$QA"
}
if [ "${1:-}" = down ]; then teardown; echo "removed $PROJECT"; exit 0; fi
if [ "$KEEP" != 1 ]; then trap teardown EXIT; fi

step "build and start ($PROJECT on 127.0.0.1:$PORT)"
dc build --quiet orchestrator
dc up -d --pull never >/dev/null 2>&1
check "readyz 200 with token" wait_code "$base/readyz" 200 60 -H @"$QA/auth-header"
check "healthz 200" wait_code "$base/healthz" 200 5
check "api without token 401" wait_code "$base/api/overview" 401 5
check "foreign Origin rejected" wait_code "$base/api/overview" 403 5 -H @"$QA/auth-header" -H "Origin: http://evil.invalid"
check "sidecar has no token file" bash -c "! docker compose -p '$PROJECT' -f '$REPO/compose.yaml' -f '$QA/override.yaml' exec -T agent-worker test -e /run/omp-orchestrator/access-token"
check "pinned OMP 18.3.2 in image" bash -c "docker compose -p '$PROJECT' -f '$REPO/compose.yaml' -f '$QA/override.yaml' exec -T agent-worker omp --version | grep -q 'omp/18.3.2'"

step "fake agent job executed by the sidecar"
id=$(agent_create "$base" fake-command smoke-key-0001 hello-compose)
[ -n "$id" ] || fail "job created"
status=$(wait_status "$base" "$id" '^(succeeded|failed|invalid|interrupted|cancelled)$' 20)
check "job succeeded (status=$status)" test "$status" = succeeded
check "job output" bash -c "$(declare -f call); QA='$QA'; call '$base' '{\"name\":\"omp_agent_result\",\"arguments\":{\"id\":\"$id\"}}' | grep -q received:hello-compose"
check "overview lists job" bash -c "curl -s -H @'$QA/auth-header' '$base/api/overview' | grep -q '$id'"
check "idempotency key returns same job" test "$(agent_create "$base" fake-command smoke-key-0001 hello-compose)" = "$id"

step "synthetic run artifact (backup coverage)"
read -r run_id sha < <(dc exec -T orchestrator node --input-type=module -e '
  const runs = await import("/opt/omp-orchestrator/mcp/run-store.mjs");
  const now = new Date().toISOString(); const id = runs.newRunId();
  runs.writeRun({ id, template: "compose-smoke", status: "awaiting_codex", phase: "attestation", budget: {},
    estimate: {}, usage: {}, nodes: [], artifacts: [], createdAt: now, updatedAt: now, completedAt: null, workerPid: null });
  console.log(id + " " + runs.writeArtifact(id, "smoke.txt", "compose restore evidence").sha256);')
check "artifact written" test "${#sha}" = 64

step "restart both services"
dc restart >/dev/null 2>&1
check "readyz after restart" wait_code "$base/readyz" 200 60 -H @"$QA/auth-header"
check "job still succeeded" test "$(agent_get "$base" "$id" | field status)" = succeeded

step "sidecar restart while a job runs ($ROUNDS rounds)"
for r in $(seq 1 "$ROUNDS"); do
  hid=$(agent_create "$base" fake-hang "smoke-hang-$r-$RANDOM" hang)
  test "$(wait_status "$base" "$hid" '^running$' 20)" = running || fail "round $r: job running"
  old=$(worker_pid "$hid")
  dc restart agent-worker >/dev/null 2>&1
  after=$(wait_status "$base" "$hid" '^(interrupted|failed|succeeded|cancelled)$' 20)
  check "round $r: oldPid=$old -> $after, no replay" test "$after" = interrupted
done
hid=$(agent_create "$base" fake-hang "smoke-abort-$RANDOM" hang)
wait_status "$base" "$hid" '^running$' 20 >/dev/null
call "$base" "{\"name\":\"omp_agent_abort\",\"arguments\":{\"id\":\"$hid\",\"confirm\":true}}" >/dev/null
check "abort ends cancelled" test "$(wait_status "$base" "$hid" '^(cancelled|interrupted|failed)$' 20)" = cancelled

step "backup and restore into a fresh volume"
pkg=$(dc exec -T orchestrator node scripts/backup.mjs --output /var/lib/omp-orchestrator/backups >/dev/null \
  && dc exec -T orchestrator sh -c 'ls -d /var/lib/omp-orchestrator/backups/omp-orchestrator-* | tail -1')
rm -rf "$QA/backup"; mkdir -p "$QA/backup"
dc cp "orchestrator:$pkg/." "$QA/backup/" >/dev/null 2>&1
check "package has sqlite, manifest and artifact" bash -c "[ -f '$QA/backup/orchestrator.sqlite' ] && grep -q '$sha' '$QA/backup/manifest.json'"
chmod -R a+rX "$QA/backup"
docker volume rm -f "$RESTORE_VOLUME" >/dev/null 2>&1 || true
docker volume create "$RESTORE_VOLUME" >/dev/null
docker run --rm --user root -v "$RESTORE_VOLUME:/v" "$IMAGE" chown node:node /v
dc run --rm --no-deps -T -v "$RESTORE_VOLUME:/restore-parent" -v "$QA/backup:/backup:ro" --entrypoint node \
  orchestrator scripts/backup.mjs --restore /backup --state /restore-parent/state \
  --runtime-state /var/lib/omp-orchestrator/state >/dev/null
docker rm -f "$RESTORED" >/dev/null 2>&1 || true
# Stand-alone restored copy: no sidecar, so agent dispatch runs in local mode.
docker run -d --name "$RESTORED" --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  -p "127.0.0.1:$RESTORE_PORT:8080" -v "$RESTORE_VOLUME:/var/lib/omp-orchestrator" \
  -v "$QA/access-token:/run/omp-orchestrator/access-token:ro" \
  -e OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE=/run/omp-orchestrator/access-token \
  -e OMP_ORCHESTRATOR_PUBLIC_ORIGIN="$rbase" "$IMAGE" >/dev/null
check "restored readyz 200" wait_code "$rbase/readyz" 200 30 -H @"$QA/auth-header"
check "restored job result readable" bash -c "$(declare -f call); QA='$QA'; call '$rbase' '{\"name\":\"omp_agent_result\",\"arguments\":{\"id\":\"$id\"}}' | grep -q received:hello-compose"
check "restored artifact content" docker exec "$RESTORED" node --input-type=module -e "
  const runs = await import('/opt/omp-orchestrator/mcp/run-store.mjs');
  if (!runs.readArtifact('$run_id', 'smoke.txt').includes('compose restore evidence')) process.exit(1);"

if [ "$KEEP" = 1 ]; then
  echo
  echo "KEEP=1: stack left running on $base (restored copy on $rbase)."
  echo "Throwaway token file: $QA/access-token"
  echo "Tear down: PROJECT=$PROJECT $0 down"
fi
echo "SMOKE OK"
