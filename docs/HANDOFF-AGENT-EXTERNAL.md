# Handoff: continuidade do OMP Orchestrator por outro provider

Atualizado em 2026-09-26 (America/Sao_Paulo), após a rodada autorizada (itens 1–10) na branch `codex/omp-handoff`.

## Objetivo

Continuar a implementação iniciada após a auditoria do `garciarsdiego/omp-orchestrator`, preservando suas decisões e entregando mudanças revisáveis. O produto deve acompanhar o OMP atual, permitir que CLIs/agentes controlem o Orchestrator e também sejam motores executados por ele, e oferecer distribuição stand-alone para Linux/VPS.

O usuário confirmou os dois sentidos de integração (cliente e motor), e o perfil inicial de VPS é uma pessoa ou equipe confiável.

Em 26/09/2026 o usuário autorizou:

- push da branch e PR;
- uso da credencial OMP local e de qualquer provider ativo;
- quota de Codex, Claude Code, Devin, Droid, Cursor, Grok e Muse para motores reais;
- os itens 4–10 do plano: upgrade/rollback, tokens e auditoria, revisão neutra, motores reais, identidade no Windows, métricas e limpeza.

Não estão autorizados:

- deploy em VPS ou TLS, que ficou para depois;
- merge do PR, que não foi pedido;
- publicação de release;
- isolamento multi-tenant, que continua fora do escopo.

## Estado confirmado

- **Worktree de continuação:** `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-handoff`, enviada para `origin`.
- **PR:** [garciarsdiego/omp-orchestrator#3](https://github.com/garciarsdiego/omp-orchestrator/pull/3), aberto contra `main`, sem auto-merge. O CI ficou verde em `43f973a`, `94e75a4` e `ad38a3f`, nos dois gatilhos (jobs Node Ubuntu/Windows, testes na imagem e smoke do Compose no runner). O PR aguarda revisão e merge pelo usuário.
- **Commits sobre `75cf897`,** em ordem (`git log --oneline 75cf897..HEAD`):
  - `2c4d818` listJobs;
  - `186a0de` WAL/SQLITE_BUSY;
  - `7fbb03c`, `514a0b2`, `379871d` docs;
  - `32d993e` lint;
  - `1fb674a` RT-10 no Linux;
  - `0650bc6`, `0cca729` smoke do Compose;
  - `3397a43` pattern do console;
  - `831fd97` smoke no CI;
  - `d86c58c` revisão neutra (schema v3);
  - `d2ad15d` ensaio de upgrade/rollback;
  - `7a7821a` identidade no Windows;
  - `8eae332` tokens nomeados e auditoria (schema v4);
  - `c38b74c` métricas;
  - `ffad77e` smoke com UID diferente de 1000;
  - `71f6b53` auditoria versionada;
  - `f700276` versão 0.8.0-preview.2;
  - `54908ab` uso do OMP RPC;
  - `43f973a` bind dos testes HTTP;
  - `34cc7cc` adaptador das sete CLIs;
  - `94e75a4` docs;
  - e o commit desta atualização do handoff.
- **Worktree original:** `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator`, branch `codex/omp-five-phases`, HEAD `75cf897`. As duas alterações rastreadas eram idênticas byte a byte a `2c4d818` e foram descartadas com autorização. Os não rastreados continuam lá: capturas, prompt, handoff antigo e a auditoria completa com os arquivos que contêm caminhos locais.
- **Pacote e documentação:** pacote `0.8.0-preview.2`, schema SQLite v4. A auditoria está versionada em `docs/audit-2026-09-25/`, sem os dois JSONs com caminhos locais. Resultados detalhados em `docs/IMPLEMENTATION-5-PHASES.md`; deploy, rotação de tokens, métricas e rollback em `docs/DEPLOY-VPS.md`.
- **Validado (detalhes em `IMPLEMENTATION-5-PHASES.md`):**
  - Windows: 113 testes, 111 passaram e 2 são específicos de Linux;
  - imagem Linux: 113/113;
  - `npm run lint` limpo;
  - smoke do Compose, local e no CI;
  - ensaio de upgrade/rollback de schema 2→3;
  - console no browser;
  - **OMP 18.3.2 real** (`openai-codex/gpt-5.5`): conclusão, steer e abort, com uso registrado e uso do abort desconhecido;
  - **sete CLIs reais** pelo Orchestrator: Codex, Claude Code, Droid, Cursor, Grok, Devin e Muse, todas `succeeded`.
- **Não validado:**
  - VPS e TLS reais;
  - motores reais dentro do container Linux, porque os testes reais rodaram no Windows local, onde estão os logins;
  - o console depois das mudanças de token e métricas (há agora testes de UI que cobrem o seletor de motor e a inspeção de artefato como texto, mas sem browser real nesta rodada);
  - a semântica de cache do Cursor: resolvida como `cursor-inclusive-cache-partition` por observação independente (`pi-cursor-sdk`), com vendor silencioso; o número real antigo usava soma com duplo cache.
- **Trabalho desta sessão (26/09/2026, commits `8b4a54a` + `3d3cdb1`, ainda não enviado):**
  - `omp_agent_backends` declara `usageReported`/`usageSemantics`/`usageIncludes`/`cacheBehavior`/`promptDelivery`/`usageUnknownAs` por backend (detalhes em `IMPLEMENTATION-5-PHASES.md`, item 11);
  - testes novos em `test/agent-cli.test.mjs`, `test/agent-jobs.test.mjs`, `test/web.test.mjs` e `test/http-auth.test.mjs` (overview/métricas com token nomeado);
  - verificado: `npm run lint` limpo no Windows; suíte Windows 114 + 2 omitidos; imagem Linux `omp-orchestrator:check` com `npm test` 116/116; `test/compose/smoke.sh` com `SMOKE OK` uma vez e uma falha posterior por resíduo de projeto (não isolada);
  - **pendente antes de push/merge:** repetir `test/compose/smoke.sh` em projeto limpo e registrar o resultado.
- **Ambiente local:**
  - o estado dos testes reais fica em `%TEMP%\omp-real`, com o catálogo `engines.json` (só caminhos e nomes de variáveis) e estados SQLite com as saídas triviais;
  - ao iniciar o WSL, containers `openbots-*` de outro projeto sobem sozinhos; não foram tocados;
  - `.impeccable/` é cache de um hook do editor e não foi commitado.
- **Tags Docker de QA:** foram removidas no fim da sessão. Confira com `docker images omp-orchestrator`. As tags `:local` e `:local-preview` da worktree original foram preservadas.

## Proteção de estado

Continue em `codex/omp-handoff` ou crie outra worktree a partir do HEAD dela, conferindo antes que caminho e branch não existem. Não use reset, checkout ou clean destrutivos. Não faça merge, force-push ou release sem autorização específica.

## Decisões que devem ser preservadas

1. O Orchestrator é a camada de política, estado e execução. Contratos de CLI/API/MCP e adapters de motores convergem no mesmo núcleo. Não duplique regras de autorização, orçamento, eventos, cancelamento ou persistência por interface.
2. Clientes externos e motores plugáveis são requisitos separados, e ambos precisam ser validados.
3. OMP fixado em `v18.3.2` com artefato e SHA-256 verificados. Não use `latest` nem download sem pin/hash.
4. `command-json` é configurado pelo operador, sem segredos no catálogo. O prompt vai por stdin, com limites de processo, cancelamento e isolamento de diretório.
5. A preview VPS é para uma pessoa ou equipe confiável. O worker compartilha SQLite, workspaces e credenciais OMP, então não é sandbox forte nem multi-tenant.
6. Tokens e credenciais nunca vão em argumentos, logs, imagens ou arquivos versionados. O token HTTP não chega ao container worker.
7. Evidência sintética não prova acesso a provider, quota, VPS pública ou TLS.
8. (Nova) Retentativa em `SQLITE_BUSY` fica restrita à inicialização do banco (`getDatabase`). Operações normais dependem de `busy_timeout` e transações `BEGIN IMMEDIATE`. Não generalize retentativas para writes de domínio sem analisar a idempotência.
9. (Nova) Todo ponto que grava `workerPid` grava também `workerIdentity` (`workerProcess(pid)`), e toda decisão de vida ou envio de sinal usa `processAlive`/`processReused` de `mcp/process-identity.mjs`. Não use `process.kill(pid, 0)` isolado. Um PID reaproveitado, ou o grupo dele, nunca recebe SIGTERM. Sem identidade disponível (processo de outro usuário ou registros antigos), o comportamento continua só por PID. Linux e Windows têm identidade.
10. (Nova) Uso desconhecido nunca vira zero. Uma mensagem do OMP abortada ou com erro e com uso zerado conta como não reportada; o resultado traz `complete: false` e não afirma custo. No `command-json`, uso desconhecido é **omitido**. Custos informados pelas CLIs ou pelo OMP são estimativas equivalentes de API, não fatura.
11. (Nova) `envInherit` lista só nomes de variáveis. Valores de ambiente e credenciais nunca vão para o catálogo de backends. Herdar `USERPROFILE`/`HOME` dá à CLI acesso ao login local dela, o que só é aceitável dentro da fronteira de confiança da instalação.
12. (Nova) Toda migração de schema precisa ser compatível com a imagem anterior. Antes de publicar uma imagem com migração, rode `test/compose/upgrade-rollback.sh`.
13. (Nova) O ator vem do transporte (nome do token HTTP, ou `local-operator`) via `mcp/request-context.mjs`. Auditoria e atestação ficam no núcleo (`invoke`, `attestRun`), nunca por interface.

## Como continuar

1. Leia este handoff, `docs/IMPLEMENTATION-5-PHASES.md`, a auditoria (`docs/audit-2026-09-25/`) e `docs/DEPLOY-VPS.md`. Não há `AGENTS.md` no repositório.
2. Antes de cada push, rode `npm run lint`, `npm test` no Windows ou no host **e na imagem Linux**. O CI remoto pegou duas diferenças de ambiente que o host não mostrava: UID 1001 e `BIND` herdado. Testes de concorrência precisam passar em laço, não uma vez só.
3. Para validar o stack local: `test/compose/smoke.sh`. Use `KEEP=1` para deixar o ambiente de pé e `PROJECT=… test/compose/smoke.sh down` para remover. Para migrações, use `test/compose/upgrade-rollback.sh` com `OLD_IMAGE`/`NEW_IMAGE`.
4. Próximos passos sem credencial nem deploy:
   - revisar e fazer o merge do PR (decisão do usuário);
   - rodar um motor real dentro do container Linux: exige provisionar login no sidecar, conforme `DEPLOY-VPS.md`;
   - confirmar a semântica de cache do Cursor ou declará-la no relatório de backends;
   - teste de UI da visualização de artifact de run e do console com tokens nomeados.
5. Gates que exigem autorização explícita: VPS e TLS reais, isolamento para workloads não confiáveis, merge e release.
6. Faça commits pequenos e convencionais, e atualize este arquivo e `IMPLEMENTATION-5-PHASES.md` a cada rodada.

## Critérios de continuidade e saída

- Cada cliente e motor usa contratos explícitos e testes que provam o caminho completo no núcleo comum.
- Jobs e runs mantêm orçamento, provider, persistência, eventos, cancelamento e recovery sob concorrência e reinício.
- OMP RPC e o motor independente têm testes fake reproduzíveis. Testes reais só com credencial e quota explicitamente disponíveis.
- A distribuição Linux documenta pin/hash, configuração, token, persistência, backup/restauração, health/readiness, upgrades e rollback. Validação local em container não é deploy real.
- Não declare finalização geral sem evidência para todos os gates aceitos.
