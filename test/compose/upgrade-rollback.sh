#!/usr/bin/env bash
# Upgrade/rollback rehearsal for the two-service preview (Linux + Compose v2).
#
#   1. OLD image: create an agent job and a run with an artifact; take a
#      backup package (the documented pre-upgrade step).
#   2. NEW image on the same volumes: migrations run, the automatic
#      orchestrator.sqlite.bak-v<N> copy exists and passes integrity_check,
#      and every record is still readable.
#   3. Image-only rollback: OLD image on the migrated database still serves
#      the records and accepts new work (forward-compatible schema).
#   4. Full rollback: restore the pre-upgrade package into a fresh volume with
#      the OLD image; the pre-upgrade schema and records come back.
#
# Fake engines, loopback, throwaway token; removes everything at the end.
# Usage: OLD_IMAGE=... NEW_IMAGE=... test/compose/upgrade-rollback.sh
#   OLD_REF=<git ref> builds OLD_IMAGE with `git archive` when it is missing.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${PROJECT:-omp-upgrade}"
PORT="${PORT:-18190}"
RESTORE_PORT="${RESTORE_PORT:-18191}"
OLD_IMAGE="${OLD_IMAGE:-omp-orchestrator:upgrade-old}"
NEW_IMAGE="${NEW_IMAGE:-omp-orchestrator:upgrade-new}"
QA="${QA_DIR:-$HOME/.cache/omp-orchestrator-smoke/$PROJECT}"
RESTORE_VOLUME="$PROJECT-restore"
RESTORED="$PROJECT-restored"

step() { printf '\n== %s\n' "$*"; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

if ! docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
  [ -n "${OLD_REF:-}" ] || fail "OLD_IMAGE $OLD_IMAGE missing; set OLD_REF to build it"
  git -C "$REPO" archive --format=tar "$OLD_REF" | docker build -q -t "$OLD_IMAGE" - >/dev/null
fi
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || docker build -q -t "$NEW_IMAGE" "$REPO" >/dev/null

rm -rf "$QA"; mkdir -p "$QA"; chmod 700 "$QA"
( umask 077
  openssl rand -base64 48 | tr -d '\n' > "$QA/access-token"
  printf 'Authorization: Bearer %s\n' "$(cat "$QA/access-token")" > "$QA/auth-header" )
cat > "$QA/backends.json" <<'EOF'
{ "backends": [ { "id": "fake-command", "type": "command-json", "executable": "/usr/local/bin/node",
  "args": ["/opt/omp-orchestrator/fixtures/command-json-fake.mjs", "success"] } ] }
EOF
# The image is interpolated at `up` time, so swapping OMP_UPGRADE_IMAGE
# recreates both services on the same named volumes.
cat > "$QA/override.yaml" <<EOF
services:
  orchestrator:
    image: \${OMP_UPGRADE_IMAGE}
    environment: { OMP_ORCHESTRATOR_BACKENDS_FILE: /run/omp-orchestrator/backends.json }
    volumes: [ "$QA/backends.json:/run/omp-orchestrator/backends.json:ro" ]
  agent-worker:
    image: \${OMP_UPGRADE_IMAGE}
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
field() { grep -o "\"$1\":\"\\?[^\",}]*" | head -1 | sed 's/.*:"\?//'; }
wait_ready() { for _ in $(seq 1 60); do [ "$(code -H @"$QA/auth-header" "$1/readyz")" = 200 ] && return 0; sleep 1; done; return 1; }
use_image() { OMP_UPGRADE_IMAGE="$1" dc up -d --pull never >/dev/null 2>&1; wait_ready "$base"; }
schema() { call "$1" '{"name":"omp_storage_status","arguments":{}}' | field schemaVersion; }
run_status() { call "$1" "{\"name\":\"omp_run_get\",\"arguments\":{\"id\":\"$run_id\"}}" | field status; }
job_output() { call "$1" "{\"name\":\"omp_agent_result\",\"arguments\":{\"id\":\"$2\"}}" | grep -q "received:$3"; }
new_job() { # base key prompt -> id, waits until succeeded
  local id s
  id=$(call "$1" "{\"name\":\"omp_agent_create\",\"arguments\":{\"backend\":\"fake-command\",\"workspace\":\"upgrade\",\"prompt\":\"$3\",\"idempotencyKey\":\"$2\",\"timeoutMs\":60000,\"confirmQuota\":true}}" | field id)
  for _ in $(seq 1 80); do s=$(call "$1" "{\"name\":\"omp_agent_get\",\"arguments\":{\"id\":\"$id\"}}" | field status)
    [ "$s" = succeeded ] && { echo "$id"; return 0; }; case "$s" in queued|running) sleep 0.25;; *) break;; esac; done
  echo "job $id ended $s" >&2; return 1; }
artifact_ok() { # container
  docker exec "$1" node --input-type=module -e "
    const runs = await import('/opt/omp-orchestrator/mcp/run-store.mjs');
    if (!runs.readArtifact('$run_id', 'upgrade.txt').includes('pre-upgrade artifact')) process.exit(1);"; }

teardown() {
  docker rm -f "$RESTORED" >/dev/null 2>&1 || true
  OMP_UPGRADE_IMAGE="$NEW_IMAGE" dc down -v >/dev/null 2>&1 || true
  docker volume rm "$RESTORE_VOLUME" >/dev/null 2>&1 || true
  rm -rf "$QA"
}
trap teardown EXIT

step "1. old image ($OLD_IMAGE): state and pre-upgrade backup"
check "old image ready" use_image "$OLD_IMAGE"
old_schema=$(schema "$base")
echo "old schema: $old_schema"
job_a=$(new_job "$base" upgrade-key-a before-upgrade) || fail "job before upgrade"
pass "job before upgrade ($job_a)"
run_id=$(dc exec -T orchestrator node --input-type=module -e '
  const runs = await import("/opt/omp-orchestrator/mcp/run-store.mjs");
  const now = new Date().toISOString(); const id = runs.newRunId();
  runs.writeRun({ id, template: "upgrade", status: "awaiting_codex", phase: "attestation", budget: {}, estimate: {},
    usage: {}, nodes: [], artifacts: [], createdAt: now, updatedAt: now, completedAt: null, workerPid: null });
  runs.writeArtifact(id, "upgrade.txt", "pre-upgrade artifact");
  console.log(id);')
check "legacy run written" test "$(run_status "$base")" = awaiting_codex
dc exec -T orchestrator node scripts/backup.mjs --output /var/lib/omp-orchestrator/backups >/dev/null
pkg=$(dc exec -T orchestrator sh -c 'ls -d /var/lib/omp-orchestrator/backups/omp-orchestrator-* | tail -1')
mkdir -p "$QA/pre-upgrade"; dc cp "orchestrator:$pkg/." "$QA/pre-upgrade/" >/dev/null 2>&1
chmod -R a+rX "$QA/pre-upgrade"
check "pre-upgrade package copied" test -f "$QA/pre-upgrade/manifest.json"

step "2. upgrade to $NEW_IMAGE on the same volumes"
check "new image ready" use_image "$NEW_IMAGE"
new_schema=$(schema "$base")
echo "new schema: $new_schema"
check "schema advanced ($old_schema -> $new_schema)" test "$new_schema" -gt "$old_schema"
check "automatic .bak-v$old_schema passes integrity_check" dc exec -T orchestrator node --input-type=module -e "
  const { default: Database } = await import('better-sqlite3');
  const { DATABASE_PATH } = await import('/opt/omp-orchestrator/mcp/storage.mjs');
  const db = new Database(DATABASE_PATH + '.bak-v$old_schema', { readonly: true });
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') process.exit(1);
  if (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v !== $old_schema) process.exit(2);"
check "job from old image readable" job_output "$base" "$job_a" before-upgrade
check "legacy run migrated to awaiting_review" test "$(run_status "$base")" = awaiting_review
check "artifact readable" artifact_ok "$PROJECT-orchestrator-1"
job_b=$(new_job "$base" upgrade-key-b after-upgrade) || fail "job after upgrade"
pass "job after upgrade ($job_b)"

step "3. image-only rollback to $OLD_IMAGE on the migrated database"
check "old image ready on schema $new_schema" use_image "$OLD_IMAGE"
check "old image reports schema $new_schema" test "$(schema "$base")" = "$new_schema"
check "old image reads pre-upgrade job" job_output "$base" "$job_a" before-upgrade
check "old image reads post-upgrade job" job_output "$base" "$job_b" after-upgrade
check "old image reads migrated run" test "$(run_status "$base")" = awaiting_review
check "old image artifact readable" artifact_ok "$PROJECT-orchestrator-1"
job_c=$(new_job "$base" upgrade-key-c after-rollback) || fail "old image accepts new work"
pass "old image accepts new work ($job_c)"

step "4. full rollback: restore the pre-upgrade package with $OLD_IMAGE"
docker volume rm -f "$RESTORE_VOLUME" >/dev/null 2>&1 || true
docker volume create "$RESTORE_VOLUME" >/dev/null
docker run --rm --user root -v "$RESTORE_VOLUME:/v" "$OLD_IMAGE" chown node:node /v
docker run --rm -v "$RESTORE_VOLUME:/restore-parent" -v "$QA/pre-upgrade:/backup:ro" --entrypoint node "$OLD_IMAGE" \
  scripts/backup.mjs --restore /backup --state /restore-parent/state \
  --runtime-state /var/lib/omp-orchestrator/state >/dev/null
docker run -d --name "$RESTORED" --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  -p "127.0.0.1:$RESTORE_PORT:8080" -v "$RESTORE_VOLUME:/var/lib/omp-orchestrator" \
  -v "$QA/access-token:/run/omp-orchestrator/access-token:ro" \
  -e OMP_ORCHESTRATOR_ACCESS_TOKEN_FILE=/run/omp-orchestrator/access-token \
  -e OMP_ORCHESTRATOR_PUBLIC_ORIGIN="$rbase" "$OLD_IMAGE" >/dev/null
check "restored old copy ready" wait_ready "$rbase"
check "restored schema back to $old_schema" test "$(schema "$rbase")" = "$old_schema"
check "restored pre-upgrade job" job_output "$rbase" "$job_a" before-upgrade
check "restored run has pre-upgrade status" test "$(run_status "$rbase")" = awaiting_codex
check "post-upgrade job absent from pre-upgrade restore" bash -c "! grep -q '$job_b' <<<\"\$(curl -s -H @'$QA/auth-header' '$rbase/api/overview')\""
check "restored artifact readable" artifact_ok "$RESTORED"

echo "UPGRADE/ROLLBACK OK"
