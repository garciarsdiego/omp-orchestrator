# Handoff: continuidade do OMP Orchestrator por outro provider

Atualizado em 2026-09-26 (America/Sao_Paulo), após a rodada na branch `codex/omp-handoff`.

## Objetivo

Continuar a implementação iniciada após a auditoria do `garciarsdiego/omp-orchestrator`, preservando suas decisões e entregando mudanças revisáveis. O produto deve acompanhar o OMP atual, permitir que CLIs/agentes controlem o Orchestrator e também sejam motores executados por ele, e oferecer distribuição stand-alone para Linux/VPS.

O usuário confirmou os dois sentidos de integração (cliente e motor). O perfil inicial de VPS autorizado é uma pessoa ou equipe confiável. Isso não autoriza deploy em VPS, publicação, push ou gastos com providers, nem afirma isolamento multi-tenant.

## Estado confirmado

- Worktree de continuação: `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-handoff`.
- Commits novos, em ordem, sobre `75cf897217d372f7f495cabf864d4708ea0e71a2`:
  1. `2c4d818` `fix(jobs): restore listJobs import for job listing`
  2. `186a0de` `fix(storage): retry busy WAL setup during concurrent first init`
  3. `7fbb03c` `docs: record handoff round and verification evidence`
  4. `32d993e` `ci: lint undefined references with eslint no-undef`
  5. commit de documentação com o Compose local e a estabilidade da suíte (veja `git log`).
- Worktree original: `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator`, branch `codex/omp-five-phases`, HEAD `75cf897`. Continua suja e **não foi alterada**:
  - modificados: `mcp/jobs.mjs` e `test/http.test.mjs`. É a mesma correção de `listJobs`, agora coberta por `2c4d818`;
  - não rastreados: `docs/audit-2026-09-25/`, capturas `docs/console-*.png`, `docs/PROMPT-AGENT-EXTERNAL.md` e a versão anterior deste handoff.
- Pacote `0.8.0-preview.1`. Fases e resultados estão em `docs/IMPLEMENTATION-5-PHASES.md`. Auditoria em `docs/audit-2026-09-25/AUDITORIA.md`, disponível **só na worktree original** porque não é rastreada. Deploy e limites em `docs/DEPLOY-VPS.md`.
- Validado em 26/09 (detalhes em `IMPLEMENTATION-5-PHASES.md`):
  - suíte em laço: 20/20 no Linux (imagem) e 10/10 no Windows;
  - teste de inicialização concorrente: 25/25 no Linux, contra 4/12 antes da correção;
  - `npm run lint` limpo;
  - Compose de dois serviços em loopback: autenticação, job fake no sidecar, idempotência, reinício, backup/restore com artifact em volume novo, reinício do sidecar com job em execução (7/7 `interrupted`, sem replay) e abort.
- Não validado: console no browser, prompt OMP real, VPS, TLS e CI remoto (sem push).
- RT-10 continua aberto. A reconciliação usa só o PID, e foi observado reuso de PID no container reiniciado. Veja a correção sugerida em `IMPLEMENTATION-5-PHASES.md`.
- Pode haver um servidor de QA local em `127.0.0.1:18080`, iniciado em sessão interativa anterior. Não foi verificado nem encerrado.
- Ao iniciar o WSL, containers `openbots-*` de outro projeto subiram por política de restart. Eles não pertencem a este repositório e não foram tocados.
- Tags Docker locais criadas: `omp-orchestrator:handoff-2c4d818`, `:handoff-wip`, `:handoff-7fbb03c` e `:handoff-compose`. Podem ser removidas quando não forem mais úteis. A tag `omp-orchestrator:local` da worktree original não foi sobrescrita, porque o QA usou override de imagem e projeto Compose próprios.
- Nada foi publicado, enviado ao remoto, implantado ou cobrado. Não crie PR nem faça push sem autorização específica.

## Proteção de estado

Não implemente na worktree original. Continue em `codex/omp-handoff` ou crie outra worktree a partir do HEAD dela, conferindo antes que caminho e branch não existem. Não use reset, checkout ou clean destrutivos. As alterações locais da worktree original agora são redundantes com `2c4d818`. Descartá-las cabe ao usuário, não ao agente.

## Decisões que devem ser preservadas

1. O Orchestrator é a camada de política, estado e execução. Contratos de CLI/API/MCP e adapters de motores convergem no mesmo núcleo. Não duplique regras de autorização, orçamento, eventos, cancelamento ou persistência por interface.
2. Clientes externos e motores plugáveis são requisitos separados, e ambos precisam ser validados.
3. OMP fixado em `v18.3.2` com artefato e SHA-256 verificados. Não use `latest` nem download sem pin/hash.
4. `command-json` é configurado pelo operador, sem segredos no catálogo. O prompt vai por stdin, com limites de processo, cancelamento e isolamento de diretório.
5. A preview VPS é para uma pessoa ou equipe confiável. O worker compartilha SQLite, workspaces e credenciais OMP, então não é sandbox forte nem multi-tenant.
6. Tokens e credenciais nunca vão em argumentos, logs, imagens ou arquivos versionados. O token HTTP não chega ao container worker.
7. Evidência sintética não prova acesso a provider, quota, VPS pública ou TLS.
8. (Nova) Retentativa em `SQLITE_BUSY` fica restrita à inicialização do banco (`getDatabase`). Operações normais dependem de `busy_timeout` e transações `BEGIN IMMEDIATE`. Não generalize retentativas para writes de domínio sem analisar a idempotência.

## Como continuar

1. Leia este handoff, `docs/IMPLEMENTATION-5-PHASES.md`, a auditoria (worktree original) e `docs/DEPLOY-VPS.md`. Não há `AGENTS.md` no repositório.
2. Resultado anterior de "passou uma vez" não prova estabilidade em testes de concorrência. Repita testes de concorrência no Linux (imagem) antes de declará-los estáveis.
3. Próximos passos sem credencial/deploy:
   - RT-10: identidade de processo (PID + `starttime`/`boot_id` no Linux) na reconciliação do supervisor e do recovery, com teste que simule PID reaproveitado;
   - QA do console web no browser contra o Compose local;
   - rodar os roteiros de QA do Compose como script versionado (hoje ficam fora do repositório; os passos estão descritos em `IMPLEMENTATION-5-PHASES.md`).
4. Gates que exigem autorização explícita: prompt OMP real com limite aprovado, VPS e TLS reais, isolamento para workloads não confiáveis.
5. Faça commits pequenos e convencionais, e atualize este arquivo e `IMPLEMENTATION-5-PHASES.md` a cada rodada.

## Critérios de continuidade e saída

- Cada cliente e motor usa contratos explícitos e testes que provam o caminho completo no núcleo comum.
- Jobs e runs mantêm orçamento, provider, persistência, eventos, cancelamento e recovery sob concorrência e reinício.
- OMP RPC e o motor independente têm testes fake reproduzíveis. Testes reais só com credencial e quota explicitamente disponíveis.
- A distribuição Linux documenta pin/hash, configuração, token, persistência, backup/restauração, health/readiness, upgrades e rollback. Validação local em container não é deploy real.
- Não declare finalização geral sem evidência para todos os gates aceitos.
