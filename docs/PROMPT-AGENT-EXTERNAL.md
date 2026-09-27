# Prompt para o próximo agente

Copie o texto entre as linhas horizontais para iniciar a continuação. Ele é autossuficiente, mas manda ler os documentos versionados antes de agir.

---

Você está continuando o repositório `garciarsdiego/omp-orchestrator`. Não use nenhuma conversa anterior como fonte: o estado está versionado. Quando este prompt e os documentos divergirem do repositório, **vale o que você verificar no repositório**. Relate a divergência.

## 1. Leia antes de agir, nesta ordem

1. `docs/HANDOFF-AGENT-EXTERNAL.md`: estado, mapa do código, motores, ambiente, comandos, decisões 1–13, aprendizados, riscos, o que não foi validado, o plano de 7 marcos e 50 passos e as perguntas pendentes do usuário (seção 15).
2. `docs/IMPLEMENTATION-5-PHASES.md`, itens 11–14: o que foi feito, por quê, comandos e resultados. O item 11 contém uma hipótese sobre o cache do Cursor que o item 14 refutou.
3. `docs/DEPLOY-VPS.md`, `docs/OBSERVABILITY.md`, `docs/BROWSER-QA.md`.
4. `docs/audit-2026-09-25/AUDITORIA.md`: a auditoria de origem.
5. `CHANGELOG.md`, seção `0.8.0-preview.3`.

## 2. Estado de partida esperado (confira)

- Worktree `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch `codex/omp-round14`, HEAD no commit que acrescenta este arquivo (`git log -1`).
- PR [garciarsdiego/omp-orchestrator#5](https://github.com/garciarsdiego/omp-orchestrator/pull/5) aberto; CI verde em `36be6f9` (7/7). Confira o CI do HEAD atual.
- `main` em `b978e19` (merge do #4), salvo se o #5 já tiver sido mergeado.
- Versão `0.8.0-preview.3`, schema SQLite v4, OMP `v18.3.2` fixado por SHA-256.
- Não mexa na worktree original `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator` (`codex/omp-five-phases`, `75cf897`) sem autorização.
- Não commite `.impeccable/` (cache de editor).

## 3. Objetivo do produto

1. Acompanhar o OMP atual.
2. Qualquer CLI ou agente controla o Orchestrator (CLI JSON, MCP, HTTP).
3. Motores alternativos são executados por ele (`omp-rpc` e `command-json` via `scripts/agent-cli-adapter.mjs`).
4. Distribuição stand-alone Linux/VPS para uma pessoa ou equipe confiável. Isolamento multi-tenant está fora do escopo.

## 4. Antes de editar, reporte

- branch, HEAD, `git status --short --branch`, `git worktree list`;
- PR e CI (`gh pr view <n>`, `gh run list --branch <branch> -L 5`);
- quais autorizações o usuário deu **nesta** sessão;
- o marco e os passos da seção 14 do handoff que você vai trabalhar, com os thresholds que pretende atingir.

Se o PR já tiver sido mergeado, crie uma branch nova a partir de `origin/main` atualizado, sem reescrever histórico.

## 5. Autorizações

- Valem **só as dadas na sessão atual**. Nada se transfere de sessões anteriores.
- Sem autorização explícita, **não faça**:
  - push, PR, merge, tag, release ou publicação de imagem;
  - deploy em VPS ou TLS;
  - gasto de quota (prompts reais em qualquer motor);
  - leitura, cópia ou movimentação de credenciais;
  - remoção da worktree original;
  - `docker pull` de imagens novas;
  - mudança em configs globais do usuário.
- Credenciais: nunca imprima valores; confira só nomes. `envInherit` e o catálogo guardam só nomes. As credenciais dos motores ficam só no sidecar, e o token HTTP só no serviço HTTP.
- Se precisar de uma decisão da seção 15 do handoff, pergunte com opções e uma recomendação.

## 6. Regras de trabalho

- Preserve as decisões 1–13 do handoff (seção 9). Em especial:
  - núcleo único para autorização, orçamento, auditoria, cancelamento e persistência;
  - uso desconhecido nunca vira zero, e a semântica de uso vem de medição real;
  - identidade de processo antes de confiar em PID;
  - migração legível pela imagem anterior;
  - ator e auditoria no núcleo;
  - prompt fora de argumentos, exceto o Cursor, que é declarado.
- Teste primeiro: reproduza o defeito com um teste que falha, corrija e mostre que passa. Fixtures precisam imitar o parser real com o mesmo rigor. Cada flag nova de CLI exige prova real (com autorização) ou fica marcada como não validada.
- Antes de cada commit relevante e de todo push autorizado:

  ```bash
  npm run lint
  npm test
  ```

  No WSL (o Docker roda lá; o repositório está em `/mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff`):

  ```bash
  docker build -t omp-orchestrator:check . && docker run --rm omp-orchestrator:check npm test
  test/compose/smoke.sh            # se tocar stack, compose, token, backup
  FAKE=1 test/compose/gate2.sh     # se tocar motores, adaptador, sidecar
  ```

  Com migração: `test/compose/upgrade-rollback.sh`. O `git` do WSL não lê esta worktree; gere a imagem antiga com `git archive` pelo Windows (seção 8 do handoff).
- Testes de concorrência só contam como estáveis se passarem em laço.
- Diferencie fake de real, Compose local de VPS, e HTTP autenticado de TLS.
- No Windows, edição por shell corrompe escapes (`\n`, `\r`, `\\`). Prefira a ferramenta de edição de arquivos e confira com `od -c` quando houver dúvida.
- Commits pequenos e convencionais. Antes de cada commit, confira status, diff e diff staged. Sem segredos, capturas ou `.impeccable/`.
- Remova stacks e diretórios de QA ao final (`docker ps -a`, `docker volume ls`). Não toque nos containers `openbots-*`, que são de outro projeto.

## 7. Por onde começar

1. Marco 1 do handoff: CI do #5 → merge (depende do usuário) → provar o `upgrade-rollback.yml` com um PR descartável de schema v5 → suíte em laço → limpeza.
2. Depois, o marco 2, na ordem dos passos 7–15, respeitando as dependências Q<n>.
3. Pergunte ao usuário só o que bloqueia o passo atual. Para seguir sem esperar, peça primeiro as respostas 1, 3, 5 e 10 da seção 15.

## 8. Registro de cada rodada

- `docs/IMPLEMENTATION-5-PHASES.md`: novo item numerado com o quê, por quê, como, arquivos, comandos, resultados reais e limitações.
- `docs/HANDOFF-AGENT-EXTERNAL.md`: atualizar as seções 3 (estado e commits), 10–12 (aprendizados, riscos, não validado), 14 (passos concluídos ou alterados) e 15 (perguntas respondidas ou novas).
- `CHANGELOG.md`, quando mudar comportamento ou configuração.

## 9. Entrega ao final

Resumo conciso:

- commits e hashes;
- comportamento alterado;
- documentos atualizados;
- verificações com resultados reais (comando e saída resumida);
- o que não foi validado;
- o próximo passo recomendado e as perguntas numeradas que ainda precisam do usuário.

Não declare concluído nenhum gate ou threshold sem evidência.

---
