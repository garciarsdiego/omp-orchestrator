# Handoff: continuidade do OMP Orchestrator por outro provider

Atualizado em 26/09/2026, fim da noite (America/Sao_Paulo), ao fim da rodada 14 na branch `codex/omp-round14`. Detalhes de cada rodada: `docs/IMPLEMENTATION-5-PHASES.md`.

## Objetivo

Acompanhar o OMP atual. CLIs e agentes controlam o Orchestrator (CLI JSON, MCP, HTTP) e também são motores executados por ele (`omp-rpc` e `command-json` via `scripts/agent-cli-adapter.mjs`). Distribuição stand-alone Linux/VPS para uma pessoa ou equipe confiável.

## Estado confirmado

- **Worktree:** `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-round14`, criada de `origin/main` depois do merge do PR #4 (`b978e19`). Não mexa em `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator` (`codex/omp-five-phases`, `75cf897`, com não rastreados preservados).
- **Commits desta branch** (`git log --oneline origin/main..HEAD`): `251c715`, `929114a`, `3f6f5e4`, `fbfb397`, `b076035`, `eff0227`, `f5cf554`, `2fb6cd9` + docs. O PR fica aberto sem auto-merge; o merge é do usuário.
- **Versões:** pacote `0.8.0-preview.3`, schema SQLite v4, OMP `v18.3.2` (a última release em 26/09/2026) fixado por SHA-256.

### Gates

| Gate | Situação | Evidência |
|---|---|---|
| 1. Motores reais no container Linux (`test/compose/gate2.sh`) | **concluído, 8/8 numa única execução** | tabela do item 14 |
| 2. Browser do console | concluído | item 13 |
| 3. Observabilidade prática | concluído com ressalvas | item 13: alertas em `pending`, nenhum `firing`; `OmpReadyzFailing` sem blackbox |
| 4. Docs + merge do #4 | concluído | `b978e19` |
| 5. Limpeza | feita | stacks e QA removidos a cada rodada |
| VPS/TLS | adiado pelo usuário | |
| Isolamento multi-tenant | fora do escopo | |

### Respostas do usuário na rodada 14 (direção, não autorização futura)

- Motores "suportados": todos os que rodarem, mesmo sem uso reportado (Devin, Muse).
- O gate 1 exige os 8 motores.
- Limite de tokens: só observação por enquanto (`tokenLimitEnforced: false`).
- Ficam para depois: VPS, forma de entregar os motores na VPS, alertas (Telegram), backups, clientes MCP reais e usuários da VPS.

### Não validado

- `upgrade-rollback.yml` no GitHub (só dispara quando um PR muda `SCHEMA_VERSION`);
- alertas em `firing` e `OmpReadyzFailing`;
- clientes reais (Claude Code, Codex) controlando o Orchestrator por MCP HTTP;
- VPS e TLS reais; isolamento para workloads não confiáveis.

### Ambiente local

- WSL Ubuntu, Docker 29.8.1, usuário `diego` UID 1000. CLIs Linux em `~/.local/bin` (symlinks absolutos para `/home/diego/...`).
- Logins no WSL: `~/.codex`, `~/.claude`, `~/.claude.json`, `~/.cursor`, `~/.config/muse` e `~/.omp/agent` (handle `opencode-go/muse-spark-1.3-contributor` em `config.yml`, credencial em `agent.db`).
- Copiados do Windows na rodada 14, com autorização: `~/.grok/auth.json`, `~/.config/cursor/auth.json` e `~/.local/share/devin/credentials.toml`.
- O Droid usa `FACTORY_API_KEY` de `C:\Users\Diego\.omp\agent\.env`, passado com `OMP_GATE2_ENV_FILE=/mnt/c/Users/Diego/.omp/agent/.env` e filtrado por nome.
- Se um lado renovar um refresh token rotativo, o outro pode precisar de novo login.
- A conta do Cursor está sem cota no modelo padrão; o gate usa `--model auto`.
- O `HOME` da imagem é `/var/lib/omp-orchestrator`; o `gate2.sh` usa o caminho de HOME do host no sidecar.
- Grok instala com `https://x.ai/cli/install.sh -s 1.0.41`.
- `.impeccable/` é cache de hook do editor: não commitar.
- Tags Docker locais: `omp-orchestrator:check`, `:gate2`, `:smoke`, `:upgrade-old`, `:push`, `:local`, `:local-preview`; imagem `prom/prometheus:v3.5.0`.

Comando completo do gate 1 no WSL:

```sh
OMP_GATE2_ENV_FILE=/mnt/c/Users/Diego/.omp/agent/.env test/compose/gate2.sh
```

## Proteção de estado

Não use reset, checkout ou clean destrutivos. Depois de cada merge, crie branch nova de `origin/main` sem reescrever histórico. Push, merge, release, VPS/TLS, quota e credenciais exigem autorização explícita **na sessão corrente**; autorizações anteriores não valem.

## Decisões que devem ser preservadas

1. O Orchestrator é a camada de política, estado e execução. Contratos de CLI/API/MCP e adapters de motores convergem no mesmo núcleo. Não duplique regras de autorização, orçamento, eventos, cancelamento ou persistência por interface.
2. Clientes externos e motores plugáveis são requisitos separados, e ambos precisam ser validados.
3. OMP fixado em `v18.3.2` com artefato e SHA-256 verificados. Não use `latest` nem download sem pin/hash.
4. `command-json` é configurado pelo operador, sem segredos no catálogo, com limites de processo, cancelamento e isolamento de diretório. O prompt vai por stdin (Codex, Claude Code) ou por arquivo temporário 0600 (Droid, Grok, Devin, Muse). **Exceção:** o Cursor só aceita o prompt como argumento. Ele vai depois de `--`, fica visível na lista de processos local durante o job e isso aparece em `promptDelivery`. Um teste impede outro perfil de voltar ao argumento.
5. A preview VPS é para uma pessoa ou equipe confiável. O worker compartilha SQLite, workspaces e credenciais, então não é sandbox forte nem multi-tenant.
6. Tokens e credenciais nunca vão em argumentos, logs, imagens ou arquivos versionados. O token HTTP não chega ao container worker, e as credenciais dos motores não chegam ao serviço HTTP.
7. Evidência sintética não prova acesso a provider, quota, VPS pública ou TLS.
8. Retentativa em `SQLITE_BUSY` fica restrita à inicialização do banco (`getDatabase`). Operações normais dependem de `busy_timeout` e `BEGIN IMMEDIATE`.
9. Todo ponto que grava `workerPid` grava também `workerIdentity`, e toda decisão de vida ou sinal usa `processAlive`/`processReused` de `mcp/process-identity.mjs`.
10. Uso desconhecido nunca vira zero; no `command-json`, é omitido. A semântica de cache de cada CLI vem de medição real, não de terceiros (o caso do Cursor na rodada 14). Custos informados são estimativas equivalentes de API, não fatura.
11. `envInherit` lista só nomes de variáveis. Herdar `HOME`/`USERPROFILE` dá à CLI o login local dela, aceitável só dentro da fronteira de confiança.
12. Toda migração de schema precisa ser compatível com a imagem anterior. `upgrade-rollback.yml` ensaia isso no CI quando `SCHEMA_VERSION` muda; rode `test/compose/upgrade-rollback.sh` localmente antes de publicar.
13. O ator vem do transporte via `mcp/request-context.mjs`. Auditoria e atestação ficam no núcleo.

Nota operacional: desde a preview.3 o Compose monta o **diretório** do token (`OMP_ORCHESTRATOR_TOKEN_DIR`). Rotacione com arquivo temporário no mesmo diretório e `mv` (`docs/OBSERVABILITY.md`).

## Como continuar

1. Leia este arquivo, `docs/IMPLEMENTATION-5-PHASES.md` (itens 11–14), `docs/DEPLOY-VPS.md`, `docs/OBSERVABILITY.md`, `docs/BROWSER-QA.md` e `docs/audit-2026-09-25/AUDITORIA.md`.
2. Antes de editar, confira branch, HEAD, `git status`, `git worktree list`, o PR aberto da branch e o CI dela (`gh pr list`, `gh run list --branch <branch>`).
3. Antes de cada push: `npm run lint`, `npm test`, `docker build -t omp-orchestrator:check . && docker run --rm omp-orchestrator:check npm test`; `test/compose/smoke.sh` e `FAKE=1 test/compose/gate2.sh` para o stack; `upgrade-rollback.sh` se houver migração.
4. Commits pequenos e convencionais; registre a rodada em `IMPLEMENTATION-5-PHASES.md` e aqui. Sem segredos, capturas ou `.impeccable/`.
5. Próximos passos sugeridos:
   - métricas por backend (duração, `agent.failed` por código) e alerta de motor falhando;
   - probe do `readyz`;
   - drift de versão das CLIs no relatório de backends;
   - repassar o erro do Droid, que falha sem escrever no stderr;
   - clientes MCP reais;
   - depois, VPS/TLS e release, com autorização.
