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

**Risco residual observado (RT-10, P2), corrigido depois em `1fb674a`:**

- A reconciliação do supervisor identifica o worker só pelo PID (`pidAlive`).
- Na medição, o worker antigo tinha PID 14, e o PID 14 voltou a existir no container reiniciado segundos depois (processos de `docker exec`).
- O teste passou porque o primeiro tick reconcilia antes de despachar novos workers.
- Um PID reaproveitado no instante da reconciliação (healthcheck, `exec`) ainda pode manter um job `running` indefinidamente.
- Correção sugerida: gravar a identidade do processo junto do PID, com `starttime` de `/proc/<pid>/stat` e o `boot_id` no Linux, e tratar divergência como processo morto. No Windows, manter o fallback atual. Não implementado nesta rodada.

**Continua não validado:** console no browser, prompt OMP real, VPS/TLS e CI remoto.

### `1fb674a` — fix(runtime): identidade de processo (RT-10)

- **Problema:** vida de processo e envio de sinal usavam só `process.kill(pid, 0)`. No container reiniciado, o novo worker recebeu o mesmo PID 14 do anterior em todas as rodadas medidas. Com isso, um registro antigo podia:
  - manter um job `running` indefinidamente, se o PID estivesse ocupado no momento da reconciliação;
  - fazer `cancelRun` enviar SIGTERM ao grupo de um processo alheio. Ele sinalizava sem checagem nenhuma.
- **Contrato:** `mcp/process-identity.mjs`.
  - `processIdentity(pid)`: no Linux, `linux:<boot_id>:<pid>:<starttime>`, com `starttime` de `/proc/<pid>/stat` (campo 22, lido após o último `)`). Nas outras plataformas, `null`.
  - `workerProcess(pid)`: `{ workerPid, workerIdentity }`, gravado em todo ponto que antes gravava `workerPid`: workers de job, de agente e de run, supervisor, spawn local e broker/gateway do runtime OMP (`brokerIdentity`/`gatewayIdentity` no arquivo de estado).
  - `processAlive(pid, identity)`: PID existe e, se houver identidade para o mesmo PID, ela confere. Identidade de outro PID é ignorada, e `/proc` ilegível não é tomado como prova de reuso.
  - `processReused(pid, identity)`: PID existe e a identidade diverge.
- **Aplicação:**
  - reconciliação e despacho do supervisor, recovery de startup (jobs, runs e vínculo nó→job) e `cancelJob` usam `processAlive`;
  - `cancelRun` pula o sinal só quando `processReused`. Um líder morto ainda é sinalizado por grupo para parar filhos órfãos, e o Linux não reaproveita um PID enquanto o grupo dele existe;
  - `stopRuntime` e `runtimeStatus` usam a identidade gravada.
- **Compatibilidade:** sem migração de schema. A identidade fica no payload JSON e os DTOs públicos são listas explícitas, então ela não é exposta. Registros antigos e Windows mantêm o comportamento só por PID.
- **Testes:** `test/process-identity.test.mjs`.
  - Em todas as plataformas: fallback e processo encerrado.
  - Só no Linux: identidade forjada com o mesmo PID vivo e `starttime` diferente. Supervisor e recovery devem interromper job e run e desvincular o nó.
  - **Prova negativa:** com `agent-supervisor.mjs` e `recovery.mjs` antigos (stash temporário), os dois testes de reconciliação falham. Com a correção, passam.

### `0650bc6`, `0cca729` — test: smoke do Compose versionado

`test/compose/smoke.sh` consolida os roteiros ad hoc da rodada anterior.

- **Caminho e isolamento:** caminho relativo ao repositório, projeto/porta/imagem parametrizáveis, token descartável passado ao `curl` por arquivo de header e remoção automática ao final.
- **Modos:** `KEEP=1` deixa o ambiente de pé; o argumento `down` remove.
- **Novo check:** `Origin` estranho → 403.
- **Arquivos:** `.gitattributes` fixa `*.sh` em LF. O script fica em `test/`, fora do `files` do pacote e fora do padrão de `node --test`.

### QA do console web no browser e `3397a43` — fix(web)

Ambiente: browser do app desktop contra `http://127.0.0.1:18180` (Compose com `KEEP=1`).

| Verificação | Resultado |
|---|---|
| token errado | `Authentication required.` |
| token de teste | conecta; mostra a run sintética, os agentes do smoke e 37 ferramentas |
| criar agent job pelo formulário (`fake-command`) | `queued` → `succeeded`, inspetor com eventos, uso e output `received:hello-from-console` |
| inspecionar run | payload como texto, sem `iframe` |
| `omp_storage_status` pelo formulário de ferramentas | WAL, schema 2 |
| argumentos inválidos | 400 `Invalid tool arguments.` |
| Desconectar e recarregar | token limpo; `localStorage`, `sessionStorage` e cookies vazios; volta desconectado |

- **Defeito encontrado:** o console acusou `Pattern attribute value [A-Za-z0-9][A-Za-z0-9._-]* is not a valid regular expression`. Browsers compilam `pattern` com o flag `v`, em que `-` sem escape no fim de uma classe é erro. A validação do lado do cliente era descartada em silêncio; o servidor continuava recusando nomes inseguros.
- **Correção:** hífen escapado.
- **Teste:** `test/web.test.mjs` compila todo `pattern` com `v` e compara a regra do workspace com a regex do servidor (`agent-jobs.mjs:65`). Falha sem a correção.
- **Confirmação no browser após rebuild:** `-bad`, `a/b` e `..` são inválidos, e `browser-qa` é válido.
- "Jobs recentes 0" com agentes presentes é intencional: o console separa `inferenceJobs` dos agentes (`web/app.js:103`).

**Limitações do QA de browser:**

- O painel descarta `window.confirm()`, cujo retorno é `false`. Isso confirmou que a negação não cria job. Para o fluxo aceito, o `confirm` foi substituído por um stub de teste só naquela aba.
- A visualização de artifact de run não foi exercitada, porque o seed sintético grava `run_artifacts` sem listar o artifact no payload da run.
- O hook de design do editor apontou os marcadores numerados de seção ("01 / EXECUÇÕES"). É design existente, fora do escopo, e não foi alterado.

### Verificações no HEAD `0cca729`

| Comando/ambiente | Resultado |
|---|---|
| `npm run lint` | limpo |
| `npm test`, Windows | 101 testes: 96 passaram, 5 omitidos (Linux) |
| imagem Linux `handoff-0cca729`, `npm test` | 101/101 em 5 execuções |
| `test/compose/smoke.sh` com RT-10 | todos os checks; reinício do sidecar com job rodando → `interrupted`, com o PID 14 reaproveitado a cada rodada |

Não validado: prompt OMP real, VPS/TLS, CI remoto e identidade de processo no Windows.

## Rodada autorizada de 26/09/2026 (itens 1–10 do plano)

O usuário autorizou:

- push e PR;
- uso da credencial OMP local, com qualquer provider ativo;
- teste de upgrade/rollback;
- rotação de token e ator auditado;
- nomenclatura neutra de revisão;
- motores reais com quota de Codex, Claude Code, Devin, Droid, Cursor, Grok e Muse;
- identidade de processo no Windows;
- métricas em Prometheus e JSON;
- limpeza.

VPS/TLS ficou para depois. Nenhuma credencial foi lida, copiada ou movida: cada motor usou o login que já existia na máquina.

### 1. Push e PR

`codex/omp-handoff` foi enviada, e o PR [garciarsdiego/omp-orchestrator#3](https://github.com/garciarsdiego/omp-orchestrator/pull/3) foi aberto contra `main`. Ele inclui o commit-base `75cf897`, que nunca tinha sido enviado.

O primeiro CI remoto revelou duas falhas reais:

- **`ffad77e`:** o smoke do Compose falhava no runner. O runner usa UID 1001, e o token 0600 ficava ilegível para o container (UID 1000). Agora o script torna o token descartável legível quando o UID difere e imprime os logs do Compose em qualquer `FAIL`.
- **`43f973a`:** os testes novos de HTTP herdavam `OMP_ORCHESTRATOR_BIND=0.0.0.0` do Dockerfile dentro da imagem. Agora fixam `127.0.0.1`. Faltou rodar a suíte na imagem antes daquele push; depois da correção, a imagem passou 113/113.

### 6. `d86c58c` — revisão neutra

- Os templates chamam o nó de atestação de `review`, com descrições sem "Codex".
- A atestação marca o nó pelo tipo, então runs antigas com o nó `codex` continuam atualizando.
- O schema v3 migra `awaiting_codex` para `awaiting_review` na coluna e no payload. O código continua aceitando os nomes antigos, então a imagem anterior lê e atesta um banco migrado.
- **Testes:** migração v2→v3 com `.bak-v2`, atestação de run legada e descrições neutras.

### 4. `d2ad15d` — ensaio de upgrade e rollback

`test/compose/upgrade-rollback.sh` roda com motores fake e token descartável:

1. Na imagem antiga, grava estado (agent job e run legada com artifact) e cria um pacote de backup.
2. Sobe a imagem nova nos mesmos volumes: a migração roda, o `.bak-v<N>` passa no `integrity_check` e os registros continuam legíveis.
3. Volta só a imagem antiga: ela lê o banco migrado e aceita trabalho novo.
4. Restaura o pacote anterior ao upgrade com a imagem antiga: o schema e os registros voltam, e o trabalho posterior não aparece.

Passou do schema 2 (`831fd97`) para o 3. A política de schema compatível com a imagem anterior e os dois tipos de rollback estão em `DEPLOY-VPS.md`.

### 8. `7a7821a` — identidade de processo no Windows

- Formato `win32:<pid>:<FILETIME de início UTC>`, lido com `Get-Process` pelo `powershell.exe`, porque o Node não expõe o início do processo.
- Cada consulta custa cerca de 200 ms, com cache de 1 s por PID.
- Processos sem acesso (outro usuário, sistema) mantêm o fallback só por PID.
- Os testes de reuso (unidade, supervisor, recovery) passaram a rodar no Windows. A comparação usa `BigInt`, porque o FILETIME excede a precisão de `Number`.
- Suíte Windows: 12 de 13 execuções completas passaram. A primeira falhou por prazo no teste do supervisor externo, com o PowerShell ainda frio; isolado, o teste leva 1,5 s.

### 5. `8eae332` — tokens nomeados, rotação e ator

- O arquivo de token aceita várias linhas `nome:token`, ignora comentários e exige no mínimo 32 bytes, sem nomes ou valores repetidos.
- O arquivo é relido em até 1 s depois de mudar. Um arquivo inválido mantém os tokens anteriores.
- O transporte associa o ator com `AsyncLocalStorage`, e o núcleo lê esse contexto.
- `invoke()` grava `audit_events` (schema v4) em toda operação que muda estado, sem argumentos. `omp_audit_list` consulta esses eventos, e a atestação grava ator e mecanismo.
- **Testes:** parser, dois atores, ator via `/api/call` e via MCP, rotação sem reinício e arquivo inválido sem bloquear o acesso.
- O storage exporta `SCHEMA_VERSION`.

### 9. `c38b74c` — métricas

- `/metrics` (texto Prometheus 0.0.4), `/api/metrics` (JSON) e a ferramenta `omp_metrics`, todos autenticados.
- Conteúdo:
  - jobs por tipo e status;
  - runs por status;
  - consumo e tokens registrados;
  - resultados de auditoria;
  - prontidão e idade do heartbeat do supervisor;
  - respostas HTTP por classe de status e bearers recusados.
- Nada de prompts, outputs, argumentos ou segredos.
- O teste valida cada linha do formato e a paridade entre HTTP e a ferramenta. O `DEPLOY-VPS.md` traz um scrape config com token próprio.

### 10. Limpeza (`71f6b53`, `f700276`)

- A auditoria foi versionada em `docs/audit-2026-09-25/`. Ficaram de fora `doctor-local.json` e `interface-probes.json` (caminhos locais da máquina) e os logs, que já eram ignorados.
- Versão `0.8.0-preview.2` em pacote, lockfile e plugin, com um teste de coerência entre os três. Os testes leem a versão do `package.json`, e a descrição do pacote ficou neutra.
- Na worktree original, as alterações rastreadas eram idênticas byte a byte a `2c4d818`, conferido por `git hash-object`, e foram descartadas com `git restore`. Os arquivos não rastreados de lá continuam intactos.
- O `NEXT_STEPS.md` já estava marcado como histórico.

### 2. `54908ab` — OMP real e uso das sessões

Execução pela CLI JSON (`call omp_agent_create`/`get`/`events`/`result`/`abort`/`steer`) no Windows. OMP 18.3.2 em `C:\Users\Diego\.bun\bin\omp.exe`, backend `omp-rpc` com `--model openai-codex/gpt-5.5 --thinking low`, estado isolado em `%TEMP%\omp-real`.

| Cenário | Resultado |
|---|---|
| prompt mínimo | `succeeded` em 6 s, saída exata `ORCHESTRATOR-REAL-OK`; eventos `prompt_result` → `session_settled` → `agent.completed` |
| uso (depois da correção) | 10.080 tokens, modelo `openai-codex/gpt-5.5`, custo equivalente estimado pelo OMP de US$ 0,0507 |
| abort depois de ~5 s | `cancelled`; uso `null` (desconhecido) |
| steer depois de ~3 s | a instrução nova mudou o resultado para `STEERED-OK`; 23.806 tokens, `complete: true` |

- **Defeito encontrado:** o uso das sessões OMP era sempre `null`. Uma sonda real mostrou o formato: o `message_end` do assistente traz `usage`, `provider` e `model`, e o `agent_end` repete a mensagem.
- **Correção:** acumulação por `messageId` no adapter do OMP.
- **Segundo defeito encontrado no abort real:** o OMP reporta uso **zero** na mensagem cortada. Mensagens `aborted`/`error` com uso zerado agora contam como não reportadas, e o resultado diz `complete: false` sem estimativa de custo.
- O fixture fake reproduz o formato observado, com valores sintéticos.

### 7. Motores reais via `scripts/agent-cli-adapter.mjs`

- `command-json` ganhou `envInherit`: só nomes de variáveis, copiadas do ambiente do Orchestrator, para cada CLI achar o login que já existe.
- O adaptador tem perfis para as sete CLIs. Os formatos foram capturados das saídas reais nas versões listadas em `mcp/backends/cli-profiles.mjs`.
- Os parsers falham em vez de adivinhar. Uso desconhecido é omitido do contrato, nunca vira zero.
- O prompt vai por stdin (Codex, Claude Code) ou por arquivo temporário 0600, removido depois (Droid, Devin, Muse). Cursor e Grok só aceitam o prompt como argumento, então ele fica visível na lista de processos local durante o job.
- `--launch` cobre CLIs iniciadas como `node index.js`.
- **Testes:** fake com os sete formatos, prompt com caracteres de shell, falha sem ecoar o prompt, erros de formato e validação de `envInherit`.

Execuções reais pelo Orchestrator (`omp_agent_create` via CLI, workspace vazio, pedido para não usar ferramentas; o Codex em `-s read-only`):

| Motor (versão) | Status | Tempo | Uso registrado |
|---|---|---|---|
| Codex (codex-cli 0.155.1) | `succeeded`, `ENGINE-CODEX-OK` | 6 s | 21.748 tokens |
| Claude Code (2.1.280) | `succeeded`, `ENGINE-CLAUDE-OK` | 5 s | 46.109 tokens, `claude-sonnet-5`, equivalente US$ 0,0940 |
| Droid (0.209.1) | `succeeded`, `ENGINE-DROID-OK` | 12 s | 9.960 tokens |
| Cursor (cursor-agent 2026.09.26) | `succeeded`, `ENGINE-CURSOR-OK` | 25 s | 23.559 tokens na soma antiga com duplo cache; com a partição inclusiva da rodada atual seriam 20.000 + 3.559 aprox. (vendor continua silencioso; ver item 11) |
| Grok (1.0.41) | `succeeded`, `ENGINE-GROK-OK` | 7 s | 28.879 tokens, `grok-4.7-build-fast`, equivalente US$ 0,0376 |
| Devin (3000.1.27) | `succeeded`, `ENGINE-DEVIN-OK` | 8 s | desconhecido (saída só texto) |
| Muse (1.3.0) | `succeeded`, `ENGINE-MUSE-OK` | 35 s | desconhecido (não reportado) |

### 11. Rodada autorizada (26/09/2026) — relatório de backends + testes de UI + Cursor inclusivo

Commits: `8b4a54a` (produto+README), `3d3cdb1` (testes de UI/HTTP), `35be67b` (docs) e `42c7623` (smoke limpo).

Commits: `8b4a54a` (produto+README), `3d3cdb1` (testes de UI/HTTP) e `35be67b` (docs).

- `omp_agent_backends` agora declara, por backend, `usageReported`, `usageSemantics`, `usageIncludes`, `cacheBehavior`, `promptDelivery` e `usageUnknownAs` (sempre omitido, nunca zero), além das capacidades antigas (`steer`, `abort`, `sessionEvents`, `tokenLimitEnforced: false`, `providerCostKnown: false`).
- `omp-rpc` declara `omp-message-end` (frames `message_end` do assistente, deduplicados por `messageId`; `aborted`/`error` com uso zerado contam como não reportados).
- `command-json` sem adaptador declara `operator-command-json` (só o que o comando do operador reportar é gravado).
- Quando os args usam `scripts/agent-cli-adapter.mjs <perfil>`, o relatório expõe `profile`, o `adapter` e os fatos do perfil em `mcp/backends/cli-profiles.mjs` (`cliCapabilities()`).
- **Cursor (gate 3, resolvido como inclusivo-particionado, vendor silencioso):** pesquisa em 26/09/2026 não achou definição de cache na doc oficial (`cursor.com/docs/cli/reference/output-format.md` nem sequer documenta o bloco `usage`; o fórum confirma que `-p --output-format json` é o único lugar que reporta uso). Evidência independente: `pi-cursor-sdk@0.1.62` (`cursor-usage-accounting.ts`) observa `turn-ended.usage` raw local e afirma `inputTokens is the full prompt; cache fields partition it`, com `uncached = inputTokens - cacheReadTokens - cacheWriteTokens`, `total = inputTokens + outputTokens` e aviso explícito para não usar o `toTokenUsage` do SDK oficial (que somaria os quatro). O parser agora implementa isso: `input_tokens = inputTokens`, `cached_tokens = min(cacheRead+cacheWrite, inputTokens)`, `total_tokens = inputTokens + outputTokens`, sem duplo cache; sem `usage` continua `null`. Semântica nova: `cursor-inclusive-cache-partition`. O número real antigo do Cursor (23.559) usava a soma exclusiva e contava cache duas vezes; não foi reexecutado com quota nesta rodada.
- Console: o seletor de motor mostra `id · tipo · perfil` e marca `· sem uso` quando `usageReported` é falso; o `title` carrega o `cacheBehavior`. A inspeção de run continua lendo `omp_run_get` + `omp_run_artifact` e exibindo o corpo como texto (`textContent`, sem `innerHTML`).
- **Testes novos (todos fake/sintéticos, sem quota):**
  - `test/agent-cli.test.mjs`: Cursor com partição inclusiva (fixture 20+5+0+3 vira 20/5/3/23, sem duplo cache; clamp e `null` sem usage); todo perfil declara semântica/cache/unknown com "never zero".
  - `test/agent-jobs.test.mjs`: o relatório declara semântica de uso/cache sem implicar custo ou limite de tokens.
  - `test/web.test.mjs`: o console mostra artefato como texto (sem `innerHTML`) e rotula backends sem uso.
  - `test/http-auth.test.mjs`: `/api/overview`, `/api/metrics` e `/metrics` exigem token nomeado, nunca ecoam o token e retornam `{ runs, jobs, agents }` com os três arrays.
- **Verificações desta rodada:** `npm run lint` limpo no Windows; suíte Windows 114 passaram + 2 omitidos (Linux); imagem Linux `omp-orchestrator:push` com o código final: `npm test` 116/116; `test/compose/smoke.sh` em projeto limpo `omp-smoke-push` com `SMOKE OK` (todos os PASS, incluindo job fake no sidecar, restart, 3 rounds de sidecar-restart, abort e backup/restore); sem migração, então `upgrade-rollback.sh` não se aplica.
- **Não validado nesta rodada:** vendor do Cursor; motor real dentro do container Linux; VPS/TLS; isolamento para workloads não confiáveis; browser real do console.

### 12. Pós-merge (26/09/2026, branch `codex/omp-postmerge` de `origin/main`)

- PR #3 mergeado em `556caf6` (`MERGED` em 2026-09-26T18:43:23Z) após push `42c7623` e CI verde nos dois gatilhos (Node Ubuntu/Windows + imagem Linux + smoke do Compose).
- Nova branch `codex/omp-postmerge` criada de `origin/main` atualizado, sem reescrever histórico. Worktree continua em `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`.
- Gate 2 completo (7 CLIs Windows dentro do container Linux) **bloqueado por inviabilidade técnica**: os motores instalados são `PE32+ .exe` Windows (`codex.exe`, `claude.exe`, `droid.exe`, `grok.exe`, `devin.exe`, `muse-*.exe`, `cursor-agent` via `node.exe`+`index.js`); o container é Linux x86_64 e não há Wine. Copiar credencial Windows para o sidecar não faria os binários executarem.
- Proposta mantida: gate 2 em escopo mínimo (1x `omp-rpc` real com login provisionado no sidecar + 1x `command-json` fake/adaptador) ou escopo completo com CLIs Linux instaladas no sidecar, o que exige instalar/autenticar as versões Linux e nova autorização de quota.
- Cursor real com a nova normalização inclusiva continua pendente de reexecução com quota.
- Observabilidade (item 6, opção B) ainda não implementada: só existe a base (`/metrics` + `/api/metrics` + `omp_metrics` + exemplo de scrape com `credentials_file` em `DEPLOY-VPS.md`).
- Browser real do console continua pendente (item 4: guia abaixo).
