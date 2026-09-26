#!/usr/bin/env bash
# Gate-2 real no Compose: 1 omp-rpc (opencode-go) + 7 CLIs Linux via
# scripts/agent-cli-adapter.mjs. Consome quota real: rode só com autorização.
# Os logins existentes do usuário são montados SÓ no sidecar; nada é copiado.
#
#   test/compose/gate2.sh                # sobe, roda os 8 motores, derruba
#   ONLY="real-rpc real-cursor" test/compose/gate2.sh
#   KEEP=1 test/compose/gate2.sh         # deixa o stack de pé
#   test/compose/gate2.sh down
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${PROJECT:-omp-gate2}"
PORT="${PORT:-18280}"
OMP_HOME="${OMP_GATE2_HOME:-$HOME/.omp/agent}"
CLIS="${OMP_GATE2_CLIS:-$HOME/.local}"
QA="${QA_DIR:-$(mktemp -d -t omp-gate2.XXXXXX)}"
ALL="real-rpc real-codex real-claude real-droid real-cursor real-grok real-devin real-muse"
ONLY="${ONLY:-$ALL}"

step() { printf '\n== %s\n' "$*"; }
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }

export OMP_GATE2_PORT="$PORT" OMP_GATE2_ORIGIN="http://127.0.0.1:$PORT" \
  OMP_GATE2_TOKEN_FILE="$QA/access-token" OMP_GATE2_BACKENDS="$QA/backends.json"
dc() { docker compose -p "$PROJECT" -f "$REPO/test/compose/gate2.yaml" -f "$QA/logins.yaml" "$@"; }

if [ "${1:-}" = down ]; then
  mkdir -p "$QA"; : > "$QA/access-token"; : > "$QA/backends.json"; echo "services: {}" > "$QA/logins.yaml"
  dc down -v >/dev/null 2>&1 || true
  rm -rf "$QA"
  echo "gate2 down"
  exit 0
fi

[ "$(id -u)" = 1000 ] || fail "UID $(id -u): o sidecar roda como node (1000) e não leria os logins"
[ -f "$OMP_HOME/agent.db" ] || fail "sem agent.db em $OMP_HOME"
[ -d "$CLIS/bin" ] || fail "sem CLIs em $CLIS/bin"

mkdir -p "$QA"; chmod 700 "$QA"
umask 077
openssl rand -base64 48 | tr -d '\n' > "$QA/access-token"
chmod 0644 "$QA/access-token"   # descartável; o container (UID 1000) precisa ler
printf 'Authorization: Bearer %s\n' "$(cat "$QA/access-token")" > "$QA/auth-header"
# backends.json usa /home/node como marcador do HOME do usuário.
sed "s|/home/node|$HOME|g" "$REPO/test/compose/gate2.backends.json" > "$QA/backends.json"; chmod 0644 "$QA/backends.json"

# Override: o sidecar usa o mesmo caminho de HOME do host, num tmpfs privado,
# com os logins existentes montados por cima (só caminhos; nada é copiado).
# Os instaladores deixam symlinks absolutos (~/.local/bin/grok -> $HOME/.grok/...).
{
  echo "services:"
  echo "  agent-worker:"
  echo "    environment:"
  echo "      HOME: \"$HOME\""
  echo "      PATH: \"$HOME/.local/share/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\""
  echo "    tmpfs:"
  echo "      - /tmp"
  echo "      - \"$HOME:uid=1000,gid=1000,mode=0700\""
  # Pais dos mounts aninhados; sem isso o Docker os cria como root. O OMP
  # extrai o addon nativo em ~/.omp/natives e o carrega (exec).
  echo "      - \"$HOME/.omp:uid=1000,gid=1000,mode=0700,exec\""
  echo "      - \"$HOME/.config:uid=1000,gid=1000,mode=0700\""
  echo "    volumes:"
  echo "      - \"$OMP_HOME:$HOME/.omp/agent:rw\""
  # Devin e Muse gravam logs/locks em ~/.local; ele fica rw (fronteira de confiança, decisão 11).
  echo "      - \"$CLIS:$HOME/.local:rw\""
  for login in .codex .claude .claude.json .cursor .config/cursor .grok .factory .config/devin .config/muse; do
    if [ -e "$HOME/$login" ]; then echo "      - \"$HOME/$login:$HOME/$login:rw\""; else echo "    # ausente: ~/$login" >&2; fi
  done
} > "$QA/logins.yaml"

base="http://127.0.0.1:$PORT"
call() { curl -s -H @"$QA/auth-header" -H 'Content-Type: application/json' -X POST "$base/api/call" -d "$1"; }
field() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then echo "KEEP=1: PROJECT=$PROJECT QA_DIR=$QA $0 down"; return; fi
  dc down -v >/dev/null 2>&1 || true
  rm -rf "$QA"
}
trap 'status=$?; [ $status -ne 0 ] && dc logs --tail 40 || true; cleanup' EXIT

step "build + up ($PROJECT, porta $PORT)"
dc up --build -d >/dev/null
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H @"$QA/auth-header" "$base/readyz" || true)
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || fail "readyz $code"
pass "readyz 200"
[ -z "$(dc exec -T orchestrator sh -c "ls -A '$HOME' /home/node/.omp 2>/dev/null")" ] || fail "credencial visível no serviço HTTP"
dc exec -T agent-worker test ! -e /run/omp-orchestrator/access-token || fail "token HTTP visível no sidecar"
pass "credenciais só no sidecar, token só no HTTP"

if [[ " $ONLY " == *" real-rpc "* ]]; then
  step "omp models no sidecar (opencode-go)"
  dc exec -T agent-worker omp models --json > "$QA/models.json" 2>"$QA/models.err" || { tail -5 "$QA/models.err"; fail "omp models"; }
  grep -q 'opencode-go' "$QA/models.json" || fail "opencode-go ausente"
  pass "opencode-go visível"
fi

run_job() {
  local backend="$1" key="$2" prompt="$3" id status=queued start
  start=$(date +%s)
  id=$(call "{\"name\":\"omp_agent_create\",\"arguments\":{\"backend\":\"$backend\",\"workspace\":\"gate2\",\"prompt\":\"$prompt\",\"idempotencyKey\":\"$key\",\"timeoutMs\":600000,\"confirmQuota\":true}}" | field id)
  [ -n "$id" ] || fail "create $backend"
  for _ in $(seq 1 130); do
    status=$(call "{\"name\":\"omp_agent_get\",\"arguments\":{\"id\":\"$id\"}}" | field status)
    case "$status" in succeeded|failed|cancelled|limit_exceeded|interrupted) break;; esac
    sleep 5
  done
  call "{\"name\":\"omp_agent_result\",\"arguments\":{\"id\":\"$id\"}}" > "$QA/$backend.result.json"
  printf '%s %s %ss %s\n' "$backend" "$status" "$(( $(date +%s) - start ))" \
    "$(grep -o '"total_tokens":[0-9]*' "$QA/$backend.result.json" | head -1)" | tee -a "$QA/summary.txt"
  [ "$status" = succeeded ] || { call "{\"name\":\"omp_agent_get\",\"arguments\":{\"id\":\"$id\"}}" | grep -o '"code":"[^"]*"' | head -1
    call "{\"name\":\"omp_agent_events\",\"arguments\":{\"id\":\"$id\"}}" | grep -o '"type":"agent.failed"[^}]*' | cut -c1-900; return 1; }
  grep -q "GATE2-$backend-OK" "$QA/$backend.result.json" || { echo "saída inesperada em $backend"; return 1; }
}

step "motores reais: $ONLY"
failed=""
for b in $ONLY; do
  run_job "$b" "gate2-$b-$(date +%s)" "Reply with exactly: GATE2-$b-OK. Do not use tools." || failed="$failed $b"
done
echo; cat "$QA/summary.txt"
[ -z "$failed" ] || fail "motores com falha:$failed"
echo "GATE2 OK"
