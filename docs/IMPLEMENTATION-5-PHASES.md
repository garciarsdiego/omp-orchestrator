# Implementação em cinco fases

Base: `main` em `1f304720fce254e2bee0901dfcb96b16028b018a`; trabalho em `codex/omp-five-phases`. Auditoria: `docs/audit-2026-09-25/AUDITORIA.md`.

## Escopo confirmado

O Orchestrator deve aceitar clientes de qualquer CLI/agente por interfaces abertas e executar motores de agente além do OMP. Entregar versão stand-alone para Linux/VPS. Perfil inicial de VPS: uma pessoa/equipe confiável como premissa enquanto a resposta do usuário não vier; multicliente isolado mudaria materialmente autorização, persistência e isolamento.

## Fases e gates

1. Corrigir as falhas P1/P2 atuais de persistência, execução, orçamento, MCP e provider, e deixar baseline/pacote coerentes. Gate: reproduções da auditoria passam e testes existentes continuam verdes.
2. Extrair núcleo de operações e abrir interfaces para clientes: CLI JSON + MCP local/remoto com semântica e validação explícitas. Gate: dois clientes exercitam o mesmo ciclo sem desvio de regra.
3. Integrar OMP recente como motor de agente via RPC, com sessão/eventos/steer/abort e preservação do backend de inferência. Gate: fixture e sessão real sem quota só se disponível, com semântica `prompt_result` versus `session_settled` verificada.
4. Integrar motor independente via protocolo aberto (ACP ou CLI headless estruturada), documentar interface de adaptação e provar um segundo motor. Gate: fluxo completo sem dependência do OMP para esse motor.
5. Entregar distribuição stand-alone Linux/VPS: imagem/compose, API/UI operacional mínima, autenticação, isolamento de workspace, volume/backup/health/readiness e runbook. Gate: ambiente Linux limpo sobe, autentica, executa cenário fake sem quota, reinicia/recupera e restaura backup.

## Histórico das frentes de implementação

- Agente `storage`: `mcp/storage.mjs`, `mcp/run-store.mjs`, `mcp/job-store.mjs`, `mcp/migration.mjs` e testes próprios. Corrige lock/migração inicial, lost update, segredos em payload e migração JSON com eventos. Não editar outros arquivos de produto.
- Agente `execution`: `mcp/budget.mjs`, `mcp/jobs.mjs`, `mcp/job-worker.mjs`, `mcp/run-manager.mjs`, `mcp/run-worker.mjs`, `mcp/recovery.mjs` e testes próprios. Corrige limites, cancelamento, recovery e provider composto; coordenar com storage se precisar de função de store. Não editar servidor MCP/packaging.
- Raiz: protocolo MCP, contratos HTML, prontidão/doctor, distribuição e as fases 2–5, além de testes integrados.

## Estado em 25/09/2026, America/Sao_Paulo

1. **Base:** concorrência de stores, migração, dados sensíveis, orçamento/retry/recovery, seleção de provider e protocolo MCP corrigidos. Revisão exige hash do artefato. Suíte integrada e probes sintéticos executados.
2. **Clientes:** catálogo compartilhado por CLI JSON, MCP stdio legado/moderno, HTTP autenticado e console web. O fluxo de agente fictício foi exercitado por CLI, HTTP e browser.
3. **OMP agente:** adapter JSONL RPC integrado aos agent jobs persistentes com eventos, steer e abort. Fake cobre o ciclo; handshake read-only `get_state` passou no OMP local 18.3.0 e no OMP 18.3.2 da imagem. Nenhum prompt real ou quota foi consumido.
4. **Motor independente:** command-json configurado somente pelo operador, com prompt em stdin, output JSON, limites de processo e cancelamento. Fake cobre fluxo completo; nenhuma CLI externa específica foi instalada/testada.
5. **Stand-alone/VPS:** servidor HTTP/UI e worker de agente em containers separados; token só no servidor, imagem Linux x64, Compose loopback, volumes, health/readiness e pacote backup/restore SQLite+CAS. Docker disponível no WSL/Ubuntu construiu a imagem e subiu o Compose: `/healthz` e `/readyz` 200, acesso sem token 401, job fake concluiu no sidecar, arquivo de token ausente nele; backup com artifact foi restaurado e lido em outro mount. Nenhuma VPS foi indicada para deploy.

**Verificações executadas:** Windows `npm test` 92 passaram, 2 específicos de Linux omitidos; imagem Linux `npm test` 94/94; `docker compose config`; build com OMP18.3.2 verificado por SHA-256; Compose com dois serviços saudáveis e execução fake; browser local autenticado; restauração real de artifact em mount distinto. O audit de 44 dependências retornou zero vulnerabilidades conhecidas. Capturas de QA locais ficam em `docs/` no workspace e não entram no pacote de distribuição.

**Gates ainda abertos:** provisionar uma credencial OMP e executar um prompt real com limite aprovado; exercitar TLS e uma VPS real; validar isolamento contra workloads não confiáveis. O sidecar não tem o bearer HTTP, mas compartilha SQLite/workspaces e credenciais OMP: esta preview é para uma pessoa ou equipe confiável, não uma plataforma multi-tenant ou sandbox forte. Nenhum push, deploy externo ou gasto com provedor foi realizado. `docs/audit-2026-09-25/` é o resultado anterior preservado.

## Continuação em 26/09/2026 (branch `codex/omp-handoff`)

Worktree separada `..\OMP-Orchestrator-handoff`, criada a partir de `75cf897`. A worktree original (`codex/omp-five-phases`) foi preservada com suas alterações locais e arquivos não rastreados, sem modificações.

Os gates abertos acima dependem de credencial OMP, VPS/TLS real ou decisão de isolamento, e não foram autorizados nesta rodada. O trabalho ficou em regressões verificáveis na base (fase 1 e fase 5), que invalidavam resultados declarados.

### `2c4d818` — fix(jobs): restaura import de `listJobs`

- **Problema:** `omp_job_list` (`mcp/jobs.mjs`) chamava `listJobs` sem importá-lo de `job-store.mjs`. `GET /api/overview`, usado pelo console web, retornava HTTP 500 (`Request failed.`). A suíte não exercitava listagem de jobs.
- **Como:** teste de HTTP estendido primeiro, falha reproduzida no checkout novo (500 ≠ 200). Depois import restaurado. É a mesma correção local da worktree original, reaplicada com teste, sem copiar arquivos.
- **Contrato:** `/api/overview` volta a responder `{runs, jobs, agents}`. O teste verifica que o agent job criado aparece em `agents` e `jobs`.
- **Varredura:** varredura heurística de chamadas sem declaração/import em `mcp/`, `bin/`, `scripts/` e `web/`. Só apareceram falsos positivos de regex/strings; nenhum outro caso da mesma classe.

### `186a0de` — fix(storage): inicialização concorrente com WAL (RT-06)

- **Problema:** o teste `concurrent first initialization applies migrations once` era intermitente. Na imagem Linux, 8 de 12 execuções isoladas falharam com `SqliteError: database is locked` em `PRAGMA journal_mode = WAL`. No Windows, falhou 1 de 5 com 8 processos. A troca para WAL e a recuperação do WAL podem retornar `SQLITE_BUSY` sem acionar o busy handler. O resultado anterior "Linux 94/94" foi uma execução favorável, não prova de estabilidade.
- **Correção:** `mcp/storage.mjs` tenta de novo o pragma WAL e `migrate()` em `SQLITE_BUSY*`, com backoff de 10–250 ms e prazo de 10 s. As migrações são idempotentes: elas reconsultam `schema_migrations` sob `BEGIN IMMEDIATE`. A conexão só é guardada no singleton depois de pragmas e migrações completarem. Antes, uma falha deixava `database` atribuído e não migrado para chamadas seguintes do mesmo processo.
- **Teste:** 8 inicializadores, como na reprodução da auditoria. Cada um verifica que `schema_migrations` tem exatamente 2 linhas.
- **Decisão:** a retentativa fica restrita à inicialização. Transações normais continuam dependendo de `busy_timeout`. Nenhuma mudança de schema.

### Verificações desta rodada

| Comando/ambiente | Resultado |
|---|---|
| `npm ci --no-audit --no-fund`, Windows, Node v24.17.0 | 44 pacotes |
| `node --test test/http.test.mjs` antes/depois de `2c4d818` | 500 ≠ 200 → 1/1 |
| teste de inicialização concorrente, Linux (imagem), antes | 4 passaram, 8 falharam em 12 |
| mesmo teste, Windows, sem/com correção (8 processos) | 1 falha em 5 → 10/10 |
| mesmo teste, Linux (imagem), com correção | 25/25 |
| `npm test`, Windows | 94 testes: 92 passaram, 2 omitidos (Linux) |
| `docker build` + `docker run … npm test`, Docker 29.8.1 no WSL Ubuntu, OMP `omp/18.3.2` na imagem | 94/94, três execuções consecutivas |

Tags locais criadas: `omp-orchestrator:handoff-2c4d818` e `omp-orchestrator:handoff-wip`. O build reaproveitou o cache do artefato OMP já verificado por SHA-256.

**Não validado nesta rodada:** Compose com dois serviços, backup/restore, browser/console visual, prompt OMP real, VPS, TLS e CI remoto (sem push). Nenhuma credencial, quota, deploy ou publicação foi usada.

**Gates restantes (inalterados):** prompt OMP real com limite aprovado; TLS e VPS reais; isolamento para workloads não confiáveis. Nenhum deles foi declarado concluído.

### `32d993e` — ci: lint `no-undef`

- **Por quê:** a regressão de `listJobs` passou pela suíte inteira porque nenhum teste chamava `omp_job_list`.
- **Como:** `eslint.config.mjs` aplica apenas `no-undef`, sem regras de estilo:
  - `.mjs` com globals de Node;
  - `web/**/*.js` com globals de browser.
- **Dependências:** `eslint@10.11.0` e `globals@17.12.0`, como devDependencies com versão exata. A imagem usa `npm ci --omit=dev`, então elas não entram nela. `npm pack --dry-run` não inclui a configuração.
- **CI:** o job `node` roda `npm run lint` antes de `npm test`.
- **Prova:** `git show 75cf897:mcp/jobs.mjs | npx eslint --stdin --stdin-filename mcp/jobs.mjs` acusa `'listJobs' is not defined` com exit 1. O HEAD passa limpo. `npm audit` retornou 0 vulnerabilidades.

### Estabilidade e Compose local em 26/09 (sem mudança de código)

| Verificação | Resultado |
|---|---|
| Suíte completa em laço, imagem Linux `handoff-7fbb03c` | 20/20 execuções sem falha |
| Suíte completa em laço, Windows | 10/10 execuções sem falha |
| Compose de dois serviços em loopback (`-p omp-handoff-qa`, porta 18180), imagem do HEAD, token de teste 0600 enviado por arquivo de header | todos os checks abaixo passaram |

Checks do Compose:

- **Autenticação:**
  - `healthz` 200;
  - `readyz` 200 com token;
  - `/api/overview` sem token → 401;
  - sidecar sem arquivo de token;
  - `omp/18.3.2` na imagem.
- **Execução:**
  - agent job `command-json` fake criado por HTTP e executado pelo sidecar, com `succeeded` e output esperado;
  - job listado em `/api/overview`;
  - a mesma `idempotencyKey` devolve o mesmo job.
- **Reinício:** `docker compose restart` dos dois serviços. `readyz` volta e o job continua `succeeded`.
- **Backup/restore:**
  - artifact sintético de run gravado no CAS;
  - `scripts/backup.mjs` gerou pacote com SQLite, manifest e o objeto;
  - restauração em volume novo com `--runtime-state`, conforme `DEPLOY-VPS.md`;
  - container restaurado (porta 18181) leu o resultado do job e o conteúdo do artifact.
  - O `readyz` restaurado deu 200 porque esse container roda sem `AGENT_DISPATCH=external`, ou seja, em modo `local` (`agent-jobs.mjs:17`). É o comportamento esperado.
- **Reinício com job em execução** (motor fake `hang`, `docker compose restart agent-worker`): 7/7 rodadas terminaram em `interrupted` sem replay. `omp_agent_abort` num job em execução → `cancelled`.

Projetos, volumes e arquivos de QA foram removidos ao final. Ficam só as tags locais `omp-orchestrator:handoff-7fbb03c` e `omp-orchestrator:handoff-compose`.

**Risco residual observado (RT-10, P2, aberto):**

- A reconciliação do supervisor identifica o worker só pelo PID (`pidAlive`).
- Na medição, o worker antigo tinha PID 14, e o PID 14 voltou a existir no container reiniciado segundos depois (processos de `docker exec`).
- O teste passou porque o primeiro tick reconcilia antes de despachar novos workers.
- Um PID reaproveitado no instante da reconciliação (healthcheck, `exec`) ainda pode manter um job `running` indefinidamente.
- Correção sugerida: gravar a identidade do processo junto do PID, com `starttime` de `/proc/<pid>/stat` e o `boot_id` no Linux, e tratar divergência como processo morto. No Windows, manter o fallback atual. Não implementado nesta rodada.

**Continua não validado:** console no browser, prompt OMP real, VPS/TLS e CI remoto.
