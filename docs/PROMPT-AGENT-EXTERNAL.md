# Prompt para o próximo agente

Copie o texto entre as linhas para iniciar a continuação. Os documentos citados estão no repositório, na branch `codex/omp-handoff`.

---

Você está continuando o repositório `garciarsdiego/omp-orchestrator`. Não use nada da conversa anterior como fonte: o estado está versionado.

**Leia antes de agir**, nesta ordem:

1. `docs/HANDOFF-AGENT-EXTERNAL.md`: estado, commits, decisões obrigatórias, autorizações e o que não foi validado.
2. `docs/IMPLEMENTATION-5-PHASES.md`: o que foi feito, por quê, comandos e resultados de cada rodada.
3. `docs/DEPLOY-VPS.md`: operação, tokens, métricas, backup, upgrade e rollback.
4. `docs/audit-2026-09-25/AUDITORIA.md`: a auditoria de origem.

**Estado de partida**

- Worktree `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-handoff`, HEAD no commit que acrescenta este arquivo (confira com `git log -1`).
- PR aberto: [garciarsdiego/omp-orchestrator#3](https://github.com/garciarsdiego/omp-orchestrator/pull/3). CI verde; aguarda revisão e merge pelo usuário.
- Versão `0.8.0-preview.2`, schema SQLite v4, OMP fixado em `v18.3.2` com SHA-256.
- A worktree original (`C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator`, `codex/omp-five-phases`) só tem arquivos não rastreados do usuário. Não mexa nela.

**Objetivo do produto** (inalterado): acompanhar o OMP atual; qualquer CLI ou agente controla o Orchestrator (CLI JSON, MCP, HTTP), e motores alternativos são executados por ele (`omp-rpc` e `command-json`, via `scripts/agent-cli-adapter.mjs`); distribuição stand-alone para Linux/VPS, para uma pessoa ou equipe confiável.

**Antes de editar**, reporte:

- branch, HEAD, `git status` e `git worktree list`;
- estado do PR e do CI (`gh pr view 3`, `gh run list --branch codex/omp-handoff`);
- o gate concreto que pretende trabalhar.

Se o PR já tiver sido mergeado, crie uma branch nova a partir de `origin/main` atualizado, sem reescrever histórico.

**Autorizações**

- Valem só as que o usuário der **na nova sessão**. A autorização anterior de push, PR e uso de quota não se transfere automaticamente.
- Sem autorização explícita, não faça: push, merge, release, deploy em VPS ou TLS, gasto de quota com provider ou CLI, nem leitura, cópia ou movimentação de credenciais.
- Motores reais usam o login que já existe na máquina. Nunca coloque valores de ambiente ou segredos no catálogo de backends: `envInherit` lista só nomes.

**Regras de trabalho**

- Preserve as decisões 1–13 do handoff. As principais:
  - núcleo comum para autorização, orçamento, auditoria, cancelamento e persistência;
  - uso desconhecido nunca vira zero;
  - identidade de processo antes de confiar em PID;
  - migração compatível com a imagem anterior;
  - ator e auditoria no núcleo.
- Antes de cada commit e de cada push autorizado, rode `npm run lint`, `npm test` e a suíte **na imagem Linux**:

  ```bash
  docker build -t omp-orchestrator:check . && docker run --rm omp-orchestrator:check npm test
  ```

  Para mudanças de stack, rode também `test/compose/smoke.sh`. Para migrações, rode `test/compose/upgrade-rollback.sh`.
- Testes de concorrência só contam como estáveis se passarem em laço.
- Diferencie fake de real, Compose local de VPS, e HTTP autenticado de TLS.
- Faça commits pequenos e convencionais. Antes de cada commit, confira status, diff completo e diff staged, e verifique que não entram segredos, capturas ou `.impeccable/`.
- Registre cada rodada em `docs/IMPLEMENTATION-5-PHASES.md` (o quê, por quê, como, arquivos, comandos, resultados, limitações) e atualize o handoff com os commits novos.

**Próximos gates sugeridos** (confirme a prioridade com o usuário):

1. Com autorização: deploy numa VPS de teste com TLS reverso, seguindo `DEPLOY-VPS.md`, e rodar lá o smoke e o backup/restore.
2. Motor real dentro do container Linux: login provisionado no sidecar e um job `omp-rpc` e outro `command-json` executados pelo Compose.
3. Confirmar a semântica de cache do Cursor, ou marcar `normalization` no relatório de backends.
4. Testes de UI da visualização de artifact de run e do console com tokens nomeados e métricas.
5. Isolamento para workloads não confiáveis, só se o usuário decidir ampliar o escopo.

**Ao final**, entregue um resumo conciso:

- commits e hashes;
- comportamento alterado;
- documentos atualizados;
- verificações com resultados reais;
- o que não foi validado;
- o próximo passo recomendado.

Não declare concluído nenhum gate sem evidência.

---
