# Handoff: continuidade do OMP Orchestrator por outro provider

Atualizado em 26/09/2026 à noite (America/Sao_Paulo), ao fim da rodada 13 na branch `codex/omp-postmerge`. Detalhes de cada rodada: `docs/IMPLEMENTATION-5-PHASES.md`.

## Objetivo

Acompanhar o OMP atual. CLIs e agentes controlam o Orchestrator (CLI JSON, MCP, HTTP) e também são motores executados por ele (`omp-rpc` e `command-json` via `scripts/agent-cli-adapter.mjs`). Distribuição stand-alone Linux/VPS para uma pessoa ou equipe confiável.

## Estado confirmado

- **Worktree:** `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-postmerge`, criada de `origin/main` depois do merge do PR #3 (`556caf6`). Não mexa em `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator` (`codex/omp-five-phases`, `75cf897`, com não rastreados preservados).
- **PR:** [garciarsdiego/omp-orchestrator#4](https://github.com/garciarsdiego/omp-orchestrator/pull/4), aberto, sem auto-merge. O merge é decisão do usuário.
- **Commits desta branch** (`git log --oneline origin/main..HEAD`): `59db6be`, `23fbb93`, `989309a` (rodada 12) e `91ec86c`, `1c04345`, `3ed04ba`, `3897111`, `851b89b`, `fcb2270` + docs (rodada 13).
- **Versões:** pacote `0.8.0-preview.2`, schema SQLite v4, OMP `v18.3.2` fixado por SHA-256 na imagem.

### Gates

| Gate | Situação | Evidência |
|---|---|---|
| 1. Motores reais no container Linux (`test/compose/gate2.sh`) | **parcial, 4/8** | omp-rpc `opencode-go/muse-spark-1.3-contributor --thinking high`, Codex, Claude, Muse `succeeded`. Grok, Devin, Cursor e Droid **sem login Linux no WSL** (erros exatos no item 13). |
| 2. Browser do console (`docs/BROWSER-QA.md`) | concluído | browser embutido, item 13 |
| 3. Observabilidade prática (`docs/OBSERVABILITY.md`) | concluído com ressalvas | Prometheus 3.5.0 real, alertas em `pending`; nenhum `firing`, `OmpReadyzFailing` sem blackbox |
| 4. Docs + merge do #4 | docs feitos; merge pendente (usuário) | |
| 5. Limpeza | feita nesta rodada | stacks, QA, `omp-prom`, volume vazio antigo |
| VPS/TLS | fora desta rodada | |
| Isolamento multi-tenant | fora do escopo | |

### Para fechar o gate 1

O usuário precisa logar as quatro CLIs **no WSL** (não no Windows), de forma interativa:

- Grok: `grok login --device-code`;
- Cursor: `cursor-agent login`;
- Devin: login da CLI Linux;
- Droid: login que crie `~/.factory`. A alternativa, passar `FACTORY_API_KEY` ao sidecar, é outra forma de credencial e precisa de autorização própria.

Depois: `ONLY="real-grok real-devin real-cursor real-droid" test/compose/gate2.sh` no WSL. O Cursor real valida também a partição inclusiva de cache, que nunca rodou com quota.

### Não validado

- Cursor real com `cursor-inclusive-cache-partition`;
- Grok com prompt começando por `-` (vai como valor de `-p`);
- alertas em `firing` e `OmpReadyzFailing`;
- VPS e TLS reais; isolamento para workloads não confiáveis.

### Ambiente local

- WSL Ubuntu, Docker 29.8.1, usuário `diego` UID 1000. CLIs Linux em `~/.local/bin` (symlinks absolutos para `/home/diego/...`); logins em `~/.codex`, `~/.claude`, `~/.claude.json`, `~/.cursor`, `~/.grok`, `~/.config/devin`, `~/.config/muse`, `~/.omp/agent` (config do handle em `config.yml`, credencial em `agent.db`).
- O `HOME` da imagem é `/var/lib/omp-orchestrator`. O `gate2.sh` usa o caminho de HOME do host no sidecar para os symlinks e as configs resolverem.
- Grok instala com `https://x.ai/cli/install.sh -s 1.0.41`.
- `.impeccable/` é cache de hook do editor: não commitar.
- Tags Docker locais: `omp-orchestrator:check`, `:gate2`, `:smoke`, `:push`, `:local`, `:local-preview`; imagem `prom/prometheus:v3.5.0`.

## Proteção de estado

Não use reset, checkout ou clean destrutivos. Se o #4 for mergeado, crie branch nova de `origin/main` sem reescrever histórico. Push, merge, release, VPS/TLS, quota e credenciais exigem autorização explícita **na sessão corrente**; autorizações anteriores não valem.

## Decisões que devem ser preservadas

1. O Orchestrator é a camada de política, estado e execução. Contratos de CLI/API/MCP e adapters de motores convergem no mesmo núcleo. Não duplique regras de autorização, orçamento, eventos, cancelamento ou persistência por interface.
2. Clientes externos e motores plugáveis são requisitos separados, e ambos precisam ser validados.
3. OMP fixado em `v18.3.2` com artefato e SHA-256 verificados. Não use `latest` nem download sem pin/hash.
4. `command-json` é configurado pelo operador, sem segredos no catálogo, com limites de processo, cancelamento e isolamento de diretório. O prompt vai por stdin ou por arquivo temporário 0600. **Exceção codificada na rodada 13:** Codex, Cursor e Grok recebem o prompt por argumento (o `codex exec` 0.155.1 anexa stdin ao prompt; Cursor e Grok não leem stdin). Ele fica visível na lista de processos local durante o job, e isso é declarado em `promptDelivery`. Prompt posicional sempre depois de `--`.
5. A preview VPS é para uma pessoa ou equipe confiável. O worker compartilha SQLite, workspaces e credenciais, então não é sandbox forte nem multi-tenant.
6. Tokens e credenciais nunca vão em argumentos, logs, imagens ou arquivos versionados. O token HTTP não chega ao container worker, e as credenciais dos motores não chegam ao serviço HTTP.
7. Evidência sintética não prova acesso a provider, quota, VPS pública ou TLS.
8. Retentativa em `SQLITE_BUSY` fica restrita à inicialização do banco (`getDatabase`). Operações normais dependem de `busy_timeout` e `BEGIN IMMEDIATE`.
9. Todo ponto que grava `workerPid` grava também `workerIdentity`, e toda decisão de vida ou sinal usa `processAlive`/`processReused` de `mcp/process-identity.mjs`.
10. Uso desconhecido nunca vira zero. No `command-json`, é omitido. Custos informados são estimativas equivalentes de API, não fatura.
11. `envInherit` lista só nomes de variáveis. Herdar `HOME`/`USERPROFILE` dá à CLI o login local dela, aceitável só dentro da fronteira de confiança.
12. Toda migração de schema precisa ser compatível com a imagem anterior; rode `test/compose/upgrade-rollback.sh` antes de publicar.
13. O ator vem do transporte via `mcp/request-context.mjs`. Auditoria e atestação ficam no núcleo.

Nota operacional (não é decisão nova): o arquivo de token é montado como arquivo único e deve ser rotacionado **no lugar**, nunca com `mv` (`docs/OBSERVABILITY.md`).

## Como continuar

1. Leia este arquivo, `docs/IMPLEMENTATION-5-PHASES.md` (itens 11–13), `docs/DEPLOY-VPS.md`, `docs/OBSERVABILITY.md`, `docs/BROWSER-QA.md` e `docs/audit-2026-09-25/AUDITORIA.md`.
2. Confira branch, HEAD, `git status`, `git worktree list`, `gh pr view 4` e `gh run list --branch codex/omp-postmerge` antes de editar.
3. Antes de cada push: `npm run lint`, `npm test`, `docker build -t omp-orchestrator:check . && docker run --rm omp-orchestrator:check npm test`; `test/compose/smoke.sh` para o stack; `upgrade-rollback.sh` se houver migração.
4. Commits pequenos e convencionais; registre a rodada em `IMPLEMENTATION-5-PHASES.md` e aqui. Sem segredos, capturas ou `.impeccable/`.
5. Próximos passos: logins Linux das quatro CLIs e o resto do gate 1; merge do #4 pelo usuário; depois VPS/TLS com autorização.
