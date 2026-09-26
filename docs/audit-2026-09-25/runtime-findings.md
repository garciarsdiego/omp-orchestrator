# Auditoria do runtime, persistência, recuperação e budgets — OMP Orchestrator 0.7.0

## Escopo e método

Revisão somente leitura do commit `1f304720fce254e2bee0901dfcb96b16028b018a`, concentrada em `mcp/runtime.mjs`, `jobs.mjs`, `job-worker.mjs`, `job-store.mjs`, `run-manager.mjs`, `run-worker.mjs`, `run-store.mjs`, `storage.mjs`, `recovery.mjs`, `security.mjs`, `budget.mjs`, `migration.mjs` e testes relacionados.

O baseline fornecido pela frente principal passou 46/46 testes em Node 24.17.0, e `npm audit` não encontrou advisory. As provas abaixo usaram apenas dados sintéticos e bancos sob `%TEMP%`; nenhuma inferência, credencial, configuração real ou runtime OMP foi acionado. Os achados distinguem falhas do produto atual de requisitos adicionais para operação stand-alone/VPS.

## Resumo executivo

O SQLite em WAL evita corrupção do arquivo, mas não fornece por si só consistência do estado de negócio. A versão 0.7.0 ainda permite perda silenciosa de atualizações na mesma run/job, duplicação de inferência durante recuperação ou chamadas concorrentes, ultrapassagem de budgets antes do bloqueio, persistência de segredos em runs e falha na primeira inicialização concorrente. Esses pontos impedem tratar budgets, recuperação e ledger como garantias duráveis em um serviço com mais de um cliente ou processo.

| ID | Severidade | Natureza | Resultado |
|---|---|---|---|
| RT-01 | P1 | Bug atual | Budget de run não é aplicado aos jobs nem ao uso real agregado |
| RT-02 | P1 | Bug atual | Atualizações concorrentes na mesma entidade se sobrescrevem silenciosamente |
| RT-03 | P1 | Bug atual | Recuperação separa run e job vivo e o resume pode duplicar chamada paga |
| RT-04 | P1 | Bug atual | Retry restaura budget já esgotado; telemetria ausente vale custo zero |
| RT-05 | P1 | Bug atual | `run.input` e outros payloads de run podem persistir segredos bloqueáveis |
| RT-06 | P1 | Bug atual | Migração do schema falha sob primeira inicialização concorrente |
| RT-07 | P1 | Bug atual | Cancelamento reescreve run terminal aceita como cancelada |
| RT-08 | P2 | Bug atual | Estado terminal e ledger de consumo/política não são atômicos |
| RT-09 | P2 | Bug atual | Migração JSON com eventos não é idempotente e perde timestamps |
| RT-10 | P2 | Bug atual | PID e porta não provam identidade ou saúde do runtime gerenciado |

## Achados

### RT-01 — P1 — O budget de uma run não limita de fato seus jobs

**Locais:** `mcp/run-worker.mjs:33-59` (`assertBudget`), `mcp/run-worker.mjs:61-92` (`refreshUsage`), `mcp/run-worker.mjs:105-123` (`startNode`), `mcp/run-manager.mjs:120-170` (`createRun`), `mcp/gateway.mjs:127-173` (`requestInference`).

**Gatilho:** executar uma run próxima de `maxCalls`, `maxTotalTokens`, `maxDurationMs` ou `maxApiEquivalentUsd`, especialmente os dois nós iniciais em paralelo, ou receber uso real acima da estimativa.

**Evidência:** `startNode` consulta `run.usage` antes de criar cada job, mas não reserva capacidade. Os nós `plan` e `design` são iniciados sequencialmente antes que qualquer resultado atualize `run.usage`, portanto ambos enxergam os mesmos totais. A chamada a `createJob` não recebe `run.budget`, o budget restante nem o deadline absoluto. Depois, `refreshUsage` apenas recalcula totais; não compara o agregado real aos limites nem altera a run para `budget_exceeded`. O timeout HTTP usa `request.setTimeout`, que é um timeout de inatividade do socket, não um deadline absoluto de duração total.

**Impacto:** calls, tokens, duração e custo podem ultrapassar o envelope aprovado e ainda terminar em `awaiting_codex`/`succeeded`. Isso contradiz `README.md:100-117`, que declara calls, tokens e duração como limites rígidos. O problema existe no modo local e se agrava com motores heterogêneos e VPS.

**Correção proposta:** reservar calls/tokens/custo em transação antes de cada dispatch; passar ao job o budget restante e um deadline absoluto; reconciliar uso real em transação antes de liberar o próximo nó ou estado terminal; fazer `enforce` falhar fechado quando não houver telemetria; usar cancelamento por deadline absoluto, não apenas timeout de inatividade. Para nós paralelos, reservar a soma dos dois ou usar uma tabela de reservations com commit/release.

**Testes ausentes:** dois nós concorrentes junto ao limite; uso real acima da estimativa; resposta sem `usage`; resposta com atividade por mais tempo que o deadline; confirmação de que nenhuma chamada adicional começa depois da primeira violação.

### RT-02 — P1 — `updateRun` e `updateJob` perdem atualizações concorrentes

**Locais:** `mcp/run-store.mjs:49-111` (`writeRun`, `updateRun`), `mcp/job-store.mjs:33-79` (`writeJob`, `updateJob`), além das transições em `mcp/jobs.mjs:132-190`, `mcp/run-manager.mjs:209-275` e `mcp/run-worker.mjs:24-29`.

**Gatilho:** dois processos ou clientes atualizarem a mesma run/job, por exemplo cancelamento concorrente com conclusão, dois retries/resumes, duas atestações ou worker e operador ao mesmo tempo.

**Evidência reproduzida:** dois processos executaram 500 incrementos cada por `updateRun` contra a mesma linha. Ambos terminaram com código 0 e `PRAGMA quick_check` retornou `ok`, mas os dois ensaios observaram **519** e **523**, em vez de 1.000. A leitura ocorre fora da transação de `writeRun`, e cada gravação substitui o payload inteiro. WAL serializa os writes, mas não detecta que o segundo payload foi calculado sobre uma versão obsoleta. O teste atual `test/storage.test.mjs:151-184` cobre apenas writers em IDs distintos.

**Impacto:** perda silenciosa de node status, `workerPid`, usage, artifact, attestation ou cancelamento; dupla inferência paga; regressão de estado terminal; eventos e payload principal divergentes.

**Correção proposta:** adicionar coluna `version` e `UPDATE ... WHERE id=? AND version=?`, falhando/repetindo em conflito; implementar transições condicionais em SQL (`WHERE status IN (...)`); usar chave de idempotência por operação/attempt; atualizar payload, nodes, evento e reservation na mesma transação.

**Reprodução isolada:** em um `OMP_ORCHESTRATOR_STATE_DIR` temporário, criar uma run com `usage.counter=0`, iniciar dois processos com `for (let i=0; i<500; i++) updateRun(id, r => ({...r, usage:{...r.usage, counter:r.usage.counter+1}}))` e ler o contador. Consulte `docs/audit-2026-09-25/runtime-probes.mjs` e `runtime-probes.log`.

### RT-03 — P1 — Recuperação pode abandonar um job vivo e duplicá-lo no resume

**Locais:** `mcp/recovery.mjs:13-56` (`reconcileInterruptedWork`), `mcp/run-manager.mjs:193-205` (`prepareNodesForResume`), `mcp/run-manager.mjs:255-275` (`resumeRun`), `mcp/run-worker.mjs:105-123` (`startNode`).

**Gatilho:** o worker da run morrer enquanto um worker de job filho continua vivo, ou o processo morrer entre `createJob` e `updateNode`.

**Evidência reproduzida:** foi gravado um job `running` com PID vivo sintético e uma run `running` com PID morto, cujo nó apontava para esse job. A reconciliação retornou `jobs: 0`, manteve o job como `running`, marcou run/nó como `interrupted`, e `prepareNodesForResume` converteu o `jobId` do nó para `null`. Um resume então cria outro job, embora o primeiro ainda esteja consumindo quota.

**Impacto:** inferência duplicada, custo duplicado, resultado órfão e ledger difícil de reconciliar. A ausência de supervisor periódico também deixa workers mortos presos em `queued`/`running` até outro processo MCP reiniciar, pois a reconciliação roda apenas no import de `mcp/server.mjs:14`.

**Correção proposta:** persistir lease/owner token e heartbeat; associar job ao nó atomicamente antes do spawn; reconciliar por `run_id`/`job_id`, e no resume anexar ao job vivo ou cancelá-lo de forma confirmada antes de criar outro; executar watchdog periódico; validar identidade do processo, não apenas existência do PID.

**Testes ausentes:** morte do run-worker com job filho vivo; morte entre criação do job e associação ao nó; worker morto durante uma sessão MCP que permanece ativa; resume concorrente.

### RT-04 — P1 — Retry reabre budgets esgotados e `enforce` aceita telemetria ausente como custo zero

**Locais:** `mcp/jobs.mjs:141-169` (`retryJob`), `mcp/budget.mjs:9-34` (`normalizeJobBudget`), `mcp/budget.mjs:74-120` (`evaluateActualUsage`), `mcp/job-worker.mjs:37-62`.

**Gatilho A:** uma tentativa inválida/falha consumir todo o budget de tokens, ainda havendo uma call permitida, e o operador pedir retry. `retryJob` subtrai o uso anterior e passa zero; `normalizeJobBudget` usa `Number(valor) || default`, transformando zero em um limite novo.

**Prova de função pura:** com restante zero, a normalização produziu `maxInputTokens: 128000`, `maxOutputTokens: 100` e `maxTotalTokens: 192000`. Assim, a nova chamada é permitida e a violação só pode ser detectada depois que a quota já foi consumida.

**Gatilho B:** um motor retornar output sem `usage`. `job-worker` define `cost=null`; `evaluateActualUsage` testa `cost?.highUsd === null`, mas `undefined === null` é falso e soma zero.

**Prova de função pura:** policy `enforce`, limite USD 1, `usage=null` e `cost=null` resultaram em `equivalentHighUsd: 0` e `breaches: []`.

**Impacto:** o operador recebe uma garantia de enforcement que não existe antes do gasto, especialmente com novos motores cujo envelope de telemetria varie.

**Correção proposta:** preservar zero como zero usando `??` e validar limites finitos; rejeitar retry quando qualquer restante necessário for zero/negativo; em `enforce`, tratar ausência ou forma inválida de `usage`/cost como `priceUnknown` bloqueante; registrar explicitamente telemetria ausente.

**Testes ausentes:** retry com cada limite exatamente esgotado; restante negativo; resposta sem usage; usage parcial; preço conhecido com telemetria de tokens ausente.

### RT-05 — P1 — Runs persistem conteúdo com padrão de segredo antes da validação

**Locais:** `mcp/run-manager.mjs:120-166` (`createRun`), `mcp/run-store.mjs:49-68` (`writeRun`), `mcp/run-manager.mjs:209-251` (`attestRun`), comparados a `mcp/jobs.mjs:65-67` e `mcp/run-store.mjs:151-155`.

**Gatilho:** enviar no `input` de uma run, findings de atestação ou outro campo do payload um token reconhecido por `security.mjs`.

**Evidência reproduzida:** uma run sintética com `input` no formato `sk-proj-...` foi gravada e lida integralmente do SQLite (`secretPersisted: true`). Jobs verificam o prompt e artifacts verificam o conteúdo, mas não existe verificação equivalente em `createRun` ou na fronteira `writeRun`.

**Impacto:** credenciais podem ficar em plaintext no banco, backups e payloads, apesar da política de bloquear padrões de alta confiança. Em VPS ou diretório compartilhado, o impacto aumenta; o scanner também cobre apenas poucas famílias de credenciais.

**Correção proposta:** validar `input` e findings antes da primeira persistência; centralizar redaction/recusa nos stores, com campos explicitamente permitidos; sanitizar mensagens de erro de gateway; ampliar padrões segundo os motores suportados; documentar que pattern matching não substitui isolamento e criptografia de segredos.

**Testes ausentes:** run input, attestation findings, output e erro contendo cada padrão bloqueado; teste de não persistência após rejeição.

### RT-06 — P1 — Primeira inicialização concorrente disputa o schema

**Local:** `mcp/storage.mjs:27-219` (`migrate`).

**Gatilho:** dois ou mais processos abrirem o mesmo state dir novo ou pendente ao mesmo tempo, cenário natural quando vários clientes CLI/agentes iniciam seus servidores MCP.

**Evidência reproduzida:** em dois ensaios de 20 state dirs temporários, oito processos chamaram `storageStatus()` simultaneamente. Houve ao menos uma falha em **15/20** e **11/20** trials. Exemplos: `SqliteError: table pricing_snapshots already exists` e `SqliteError: table jobs already exists`. Cada processo calcula `applied` antes da transação e depois executa DDL baseado nessa fotografia obsoleta. A prova repetível está em `docs/audit-2026-09-25/runtime-probes.mjs` e o último resultado em `runtime-probes.log`.

**Impacto:** startup intermitente em instalação limpa/upgrade; em um supervisor, pode gerar loop de restart. O teste WAL atual começa depois que o schema já foi criado, portanto não cobre esse caso.

**Correção proposta:** adquirir lock de migração (`BEGIN EXCLUSIVE` ou mecanismo equivalente), reler `schema_migrations` dentro do lock e aplicar uma versão por vez; considerar a API de backup SQLite em vez de copiar apenas o arquivo principal; testar inicialização e upgrade multi-processo.

### RT-07 — P1 — `cancelRun` aceita qualquer estado e destrói o contrato terminal

**Local:** `mcp/run-manager.mjs:278-292` (`cancelRun`).

**Gatilho:** chamar cancelamento confirmado em uma run já `succeeded`, `failed`, `rejected` ou `cancelled`.

**Evidência reproduzida:** uma run validada e aceita mudou de `succeeded` para `cancelled`. A função não possui allowlist de estados antes de matar PIDs e regravar status.

**Impacto:** `omp_run_result` passa a rejeitar um artifact previamente aceito; trilha de atestação e estado terminal divergem. Em corrida com conclusão, a ausência de CAS de RT-02 permite ainda que cancelamento seja perdido ou que conclusão seja reescrita.

**Correção proposta:** transição SQL condicional somente de estados ativos; tornar cancelamento idempotente para `cancelled`; rejeitar estados terminais; fazer worker conferir um cancellation token/estado antes de qualquer commit terminal.

**Teste ausente:** matriz completa estado atual × cancel; corrida cancelamento/conclusão.

### RT-08 — P2 — Estado terminal, consumo e policy events podem divergir após crash

**Locais:** `mcp/job-worker.mjs:44-62`, `mcp/job-store.mjs:114-184`.

**Gatilho:** processo morrer ou SQLite lançar erro depois de `updateJob` e antes de `recordConsumptionEvent`, ou entre consumo e `recordPolicyEvents`.

**Evidência de código:** as três gravações são transações independentes. Recovery ignora jobs já terminais e não há outbox/reconciliador que preencha eventos ausentes. A migração v2 preenche consumo apenas no upgrade inicial, não continuamente.

**Impacto:** job terminal com usage no payload/attempt, mas sem linha de consumo; consumo sem policy event; relatório financeiro e auditoria incompletos. Se `recordConsumptionEvent` falhar, o catch ainda regrava o job como `failed`, embora a inferência tenha terminado.

**Correção proposta:** commit único de resultado, attempt, consumo e policy events; ou outbox durável com estado `accounting_pending` e reconciliador idempotente. Adicionar constraints/idempotency também aos policy events.

**Teste ausente:** fault injection após cada boundary de persistência e reconciliação no restart.

### RT-09 — P2 — Migração JSON com eventos não é idempotente e altera a história

**Locais:** `mcp/migration.mjs:37-55`, `mcp/migration.mjs:60-88`.

**Gatilho:** importar uma run legada com pelo menos um evento e repetir `--apply`, ou precisar preservar o timestamp original.

**Evidência reproduzida:** a primeira importação teve sucesso. A segunda lançou `UNIQUE constraint failed: events.run_id, events.sequence`. O evento legado com `at: 2025-01-01T00:00:00.000Z` foi armazenado com o horário atual de 2026, porque `sequence` e `at` são removidos e `appendRunEvent` os recria.

**Impacto:** rerun não é seguro após interrupção e a provenance temporal importada deixa de ser fiel. O teste atual de idempotência cobre apenas job legado sem eventos.

**Correção proposta:** inserir eventos legados com sequence/timestamp originais e `ON CONFLICT` que compare payload; não zerar `eventCount` antes de reimportar; declarar conflito real quando o mesmo sequence possuir conteúdo diferente. Validar secrets dos artifacts já na inspeção e preservar binários quando aplicável.

**Testes ausentes:** reaplicação de run com eventos/artifacts, interrupção parcial, timestamp original e conflito de conteúdo.

### RT-10 — P2 — PID vivo e porta aberta não identificam o runtime gerenciado

**Locais:** `mcp/runtime.mjs:13-29`, `mcp/runtime.mjs:31-51`, `mcp/runtime.mjs:78-99`, `mcp/runtime.mjs:141-150`; `mcp/recovery.mjs:3-11`.

**Gatilho:** PID ser reutilizado depois de crash, arquivo de estado ficar obsoleto, ou outro serviço ocupar 4000/9000.

**Evidência de código:** `pidAlive` só executa `process.kill(pid, 0)` e `portOpen` aceita qualquer TCP listener. `runtimeStatus.running` combina esses sinais, sem validar executable, start time, nonce ou endpoint autenticado. `stopRuntime` então envia `taskkill /T /F` ou sinal ao grupo registrado. Isso não cumpre literalmente a descrição de `mcp/server.mjs:76-80`, “stop only” os processos iniciados pelo plugin.

**Impacto:** falso positivo de saúde, runtime irrecuperável e, com PID reutilizado, término de processo não relacionado. Não foi feita prova destrutiva com PIDs reais.

**Correção proposta:** lock de instância; nonce e identidade do processo (PID + start time + executable); endpoint de health com desafio autenticado; verificar identidade antes de sinalizar; gravar estado em diretório privado e durável; usar portas configuráveis/alocadas.

**Teste ausente:** state file obsoleto, PID reutilizado simulado, porta ocupada por servidor dummy, startup concorrente e crash entre spawn e gravação do state file.

## Requisitos adicionais para stand-alone/VPS e múltiplos clientes/motores

Os itens abaixo são expansão de arquitetura, não bugs novos do uso local confiável por um único usuário:

- identidade/autorização por cliente, namespaces/tenants e quotas por principal; hoje qualquer cliente MCP ligado ao mesmo state dir compartilha todos os runs/jobs;
- limite global de workers/runs e fila transacional; `OMP_ORCHESTRATOR_MAX_JOBS` é contado por `jobRoot`, então cada run isolada recebe seu próprio teto e não existe teto global de runs;
- scheduler/lease durável com heartbeat, requeue e fencing token, evitando depender de detached child + PID;
- adapters de motor com contrato versionado para request, cancellation, usage, erro e idempotency; telemetry ausente deve ter semântica explícita;
- portas/configuração por instância, health/readiness autenticados, shutdown gracioso e supervisão de processo;
- backup/restore SQLite consistente (incluindo WAL), retenção/GC, criptografia/ACL do state dir e observabilidade de filas, leases e accounting pendente.

## Limitações da auditoria

- Nenhuma chamada real de provedor foi feita; comportamento de quota foi inferido do fluxo e validado com funções puras/estado sintético.
- A prova de concorrência exercitou o store integrado e processos reais, mas não o worker de inferência, para evitar consumo pago.
- RT-10 foi validado por inspeção; não se tentou matar nem falsificar processos do runtime real.
- A suíte verde demonstra o caminho coberto, mas não cobre conflitos sobre a mesma entidade, primeira migração concorrente, crash boundaries, budgets agregados de run, ausência de usage, migração de eventos nem matriz de estados terminais.
