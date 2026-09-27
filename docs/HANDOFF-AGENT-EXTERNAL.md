# OMP Orchestrator: handoff completo e plano de continuidade

Atualizado em 26/09/2026, fim da noite (America/Sao_Paulo), ao fim da rodada 14. Este é o documento de entrada do projeto. O histórico detalhado, rodada a rodada, está em `docs/IMPLEMENTATION-5-PHASES.md`. O prompt para iniciar o próximo agente está em `docs/PROMPT-AGENT-EXTERNAL.md`.

Sumário:

1. Resumo executivo
2. Objetivo e escopo
3. Estado atual
4. Histórico de entregas
5. Arquitetura e mapa do código
6. Motores de agente
7. Ambiente local, caminhos e versões
8. Como verificar (comandos)
9. Decisões que devem ser preservadas
10. Aprendizados
11. Desafios, riscos e dívidas
12. O que não foi validado
13. Autorizações e proteção de estado
14. Plano: 7 marcos, 50 passos
15. Perguntas e decisões pendentes do usuário
16. Checklist de cada rodada

---

## 1. Resumo executivo

- O OMP Orchestrator é a camada de política, estado e execução entre **clientes** (CLI JSON, MCP stdio, MCP/HTTP autenticado, console web) e **motores** (inferência OMP, sessões `omp-rpc` e CLIs de agente via `command-json`).
- A preview `0.8.0-preview.3` roda stand-alone em Linux (imagem x64 + Compose com dois containers). Os **oito motores reais** passaram numa única execução dentro do container Linux:
  - OMP RPC com `opencode-go/muse-spark-1.3-contributor`;
  - Codex, Claude Code, Droid, Cursor, Grok, Devin e Muse.
- Gates 1–5 da fase pós-merge concluídos (browser e observabilidade com ressalvas). O PR [garciarsdiego/omp-orchestrator#5](https://github.com/garciarsdiego/omp-orchestrator/pull/5) está aberto com CI verde (7/7 checks em `36be6f9`) e aguarda o merge do usuário.
- Falta, em ordem:
  - fechar a preview.3;
  - robustez dos motores;
  - observabilidade até notificação;
  - clientes MCP reais;
  - avaliar ACP;
  - release 0.8.0;
  - VPS pessoal (adiada pelo usuário).

## 2. Objetivo e escopo

**Objetivo (confirmado pelo usuário):**

1. Acompanhar o OMP atual.
2. Qualquer CLI ou agente consegue **controlar** o Orchestrator (CLI JSON, MCP, HTTP).
3. Agentes diferentes são **executados por** ele (`omp-rpc` e `command-json` via `scripts/agent-cli-adapter.mjs`).
4. Distribuição stand-alone Linux/VPS para **uma pessoa ou equipe confiável**.

**Dentro do escopo:** uma instalação e uma fronteira de confiança; tokens nomeados com auditoria de ator; métricas Prometheus; backup/restore; upgrade e rollback compatíveis.

**Fora do escopo:** isolamento multi-tenant e sandbox forte para workloads não confiáveis. O sidecar compartilha SQLite, workspaces e credenciais dos motores.

**Direção do usuário (rodada 14):**

- são suportados todos os motores que rodarem, mesmo sem uso reportado;
- o gate de motores exige os 8;
- limite de tokens só como observação;
- ficam para depois: VPS, forma de levar os motores à VPS, Telegram, backups, clientes MCP e usuários da VPS.

## 3. Estado atual

| Item | Valor |
|---|---|
| Repositório | `garciarsdiego/omp-orchestrator` |
| Worktree de trabalho | `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff` |
| Branch | `codex/omp-round14` (de `origin/main` em `b978e19`) |
| PR aberto | #5, CI verde, sem auto-merge |
| `main` | `b978e19` (merge do #4) |
| Versão | `0.8.0-preview.3` (`package.json`, lockfile, `.codex-plugin/plugin.json`) |
| Schema SQLite | v4 (`SCHEMA_VERSION` em `mcp/storage.mjs`) |
| OMP | `v18.3.2` fixado por SHA-256 `8cbbcd4b…0702534` no `Dockerfile`; é a última release em 26/09/2026 |
| Node | `v24.17.0` (Windows); imagem `node:24` |
| Worktree original | `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator`, `codex/omp-five-phases` em `75cf897`, só não rastreados do usuário. **Não mexer** sem autorização. |

Commits do #5 (`git log --oneline origin/main..HEAD`):

| Hash | Conteúdo |
|---|---|
| `251c715` | Uso do Cursor com cache exclusivo (medido) |
| `929114a` | `gate2.sh`: chaves de motor por nome, Cursor `--model auto` |
| `3f6f5e4` | Devin com `--respect-workspace-trust false`; primeira tentativa de `--` no Grok |
| `fbfb397` | Codex volta a receber o prompt por stdin (`-`) |
| `b076035` | **Quebra:** token montado por diretório (`OMP_ORCHESTRATOR_TOKEN_DIR`) |
| `eff0227` | CI: `FAKE=1 gate2.sh` + `upgrade-rollback.yml` condicionado ao schema |
| `f5cf554` | Grok por `--prompt-file` |
| `2fb6cd9` | Versão `0.8.0-preview.3` + changelog |
| `36be6f9` | Documentação da rodada 14 |
| (este) | Handoff completo, plano e prompt |

### Gates

| Gate | Situação | Evidência |
|---|---|---|
| 1. Motores reais no container Linux | **concluído, 8/8 numa única execução** | item 14 de `IMPLEMENTATION-5-PHASES.md` |
| 2. Browser do console | concluído | item 13 |
| 3. Observabilidade prática | concluído com ressalvas | item 13: alertas em `pending`, nenhum em `firing`; `OmpReadyzFailing` sem blackbox |
| 4. Docs + merge do #4 | concluído | `b978e19` |
| 5. Limpeza | concluído | stacks e QA removidos em cada rodada |
| VPS/TLS | adiado pelo usuário | — |
| Multi-tenant | fora do escopo | — |

Última execução real do gate 1 (código final, container Linux):

| Motor | Status | Tempo | Tokens |
|---|---|---|---|
| omp-rpc | succeeded | 6 s | 9.086 |
| Codex | succeeded | 10 s | 13.486 |
| Claude Code | succeeded | 5 s | 25.646 |
| Droid | succeeded | 15 s | 7.333 |
| Cursor | succeeded | 20 s | 35.615 |
| Grok | succeeded | 10 s | 21.910 |
| Devin | succeeded | 10 s | desconhecido |
| Muse | succeeded | 15 s | desconhecido |

## 4. Histórico de entregas

| Marco | Onde | Resumo |
|---|---|---|
| Auditoria | `docs/audit-2026-09-25/` | 18 achados (10 P1, 8 P2) em `1f30472`, mais requisitos de arquitetura |
| Fases 1–5 | `75cf897` (`codex/omp-five-phases`) | Correções P1/P2; núcleo e catálogo comum; OMP RPC; `command-json`; imagem e Compose |
| PR #3 | `556caf6` | WAL/SQLITE_BUSY, `listJobs`, lint `no-undef`, identidade de processo (Linux/Windows), smoke do Compose, revisão neutra (schema v3), tokens nomeados e auditoria (schema v4), métricas, OMP real, adaptador das 7 CLIs |
| PR #4 | `b978e19` | Capacidades dos backends, observabilidade mínima, browser QA, `agent.failed`, `--` antes de prompt posicional, `gate2.sh`, rotação de token no lugar |
| PR #5 | aberto | 8/8 real no Linux, correção do uso do Cursor, entrega de prompt por CLI, token por diretório, CI fake e de upgrade, preview.3 |

Detalhes, comandos e resultados de cada rodada (itens 1–14): `docs/IMPLEMENTATION-5-PHASES.md`. O item 11 registra a hipótese de cache inclusivo do Cursor, que o item 14 **refutou**; o item 11 fica como histórico.

## 5. Arquitetura e mapa do código

```
clientes ─┬─ bin/omp-orchestrator.mjs  (CLI JSON: tools, call, mcp, serve, doctor)
          ├─ mcp/server.mjs             (MCP stdio legado/moderno)
          ├─ mcp/http-server.mjs        (HTTP: /mcp, /api/call, /api/overview, /metrics, /api/metrics, /healthz, /readyz, console)
          └─ web/                       (console: app.js, index.html, style.css)
               │
               ▼
núcleo ─── mcp/tool-catalog.mjs (catálogo único, invoke(), auditoria)
          ├─ mcp/request-context.mjs (ator vindo do transporte)
          ├─ mcp/audit.mjs, mcp/metrics.mjs, mcp/security.mjs (scanner de segredos)
          ├─ jobs: mcp/jobs.mjs, job-store.mjs, job-worker.mjs, budget.mjs, pricing.mjs, providers.mjs
          ├─ runs: mcp/run-manager.mjs, run-store.mjs, run-worker.mjs, templates.mjs, validators.mjs
          ├─ agentes: mcp/agent-jobs.mjs, agent-supervisor.mjs (sidecar), agent-worker.mjs
          ├─ estado: mcp/storage.mjs (SQLite WAL, migrações, SCHEMA_VERSION), migration.mjs, recovery.mjs
          ├─ processo: mcp/process-identity.mjs, runtime.mjs, gateway.mjs
               │
               ▼
motores ── mcp/backends/omp-rpc.mjs      (sessão OMP JSONL: eventos, steer, abort, uso por message_end)
          ├─ mcp/backends/command-json.mjs (processo do operador: stdin → JSON, limites, envInherit)
          └─ scripts/agent-cli-adapter.mjs + mcp/backends/cli-profiles.mjs (7 CLIs → contrato command-json)
```

| Caminho | Papel |
|---|---|
| `Dockerfile` | Imagem Linux x64, OMP 18.3.2 com SHA-256, usuário `node` (UID 1000), `HOME=/var/lib/omp-orchestrator` |
| `compose.yaml` | `orchestrator` (HTTP, token em `/run/omp-orchestrator/secrets`) + `agent-worker` (sidecar, sem token), loopback |
| `scripts/backup.mjs` | Backup online SQLite + CAS + manifest; `--restore` |
| `scripts/agent-cli-adapter.mjs` | Adaptador das CLIs (`<perfil> [--launch …] -- <executável> [args fixos]`) |
| `fixtures/` | `command-json-fake.mjs`, `fake-agent-cli.mjs` (imita os 7 formatos e parsers), `fake-omp-rpc.mjs` (conclui só com a mensagem `complete`) |
| `test/*.test.mjs` | Suíte `node --test` (119 testes; 2 só Linux) |
| `test/compose/smoke.sh` | Stack com motores fake: auth, Origin, sidecar sem token, rotação por `mv`, job, restart, PID reaproveitado, abort, backup/restore |
| `test/compose/upgrade-rollback.sh` | Upgrade com migração, rollback só de imagem, restore anterior (exige que o schema avance) |
| `test/compose/gate2.sh` + `gate2.yaml` + `gate2.backends.json` | 8 motores reais no sidecar (`FAKE=1` para CI) |
| `.github/workflows/ci.yml` | Node Ubuntu/Windows (lint, test, pack), imagem (test, smoke, gate2 fake) |
| `.github/workflows/upgrade-rollback.yml` | Ensaio de upgrade quando `SCHEMA_VERSION` muda num PR |
| `docs/DEPLOY-VPS.md` | Deploy, token, métricas, backup, upgrade/rollback |
| `docs/OBSERVABILITY.md` | Prometheus, alertas, rotação, backup automático |
| `docs/BROWSER-QA.md` | Roteiro de QA do console |

## 6. Motores de agente

Versões capturadas no cabeçalho de `mcp/backends/cli-profiles.mjs`, e versões vistas no WSL em 26/09/2026:

| Motor | Versão no WSL | Entrega do prompt | Flags do perfil | Semântica de uso | Login no WSL | Origem no Windows |
|---|---|---|---|---|---|---|
| omp-rpc | OMP 18.3.2 (imagem) | frame `prompt` | `--model opencode-go/muse-spark-1.3-contributor --thinking high` (catálogo do gate) | `omp-message-end` | `~/.omp/agent` (`config.yml`, `agent.db`) | `C:\Users\Diego\.omp\agent` |
| Codex | codex-cli 0.155.1 | stdin (`exec … -`) | `exec --json --skip-git-repo-check --ephemeral -`; catálogo `-s read-only` | `openai-inclusive-cache` | `~/.codex` | `…\Programs\OpenAI\Codex\bin\codex.exe` |
| Claude Code | 2.1.283 (capturada 2.1.280) | stdin | `-p --output-format json` | `anthropic-exclusive-cache` | `~/.claude`, `~/.claude.json` | — |
| Droid | 0.228.0 (capturada 0.209.1) | arquivo 0600 | `exec -o json -f <arquivo>` | `anthropic-exclusive-cache` + créditos | variável `FACTORY_API_KEY` | `.env` do OMP; `~/.factory` usa keyring (não portável) |
| Cursor | 2026.09.26-dd393fe | **argumento**, depois de `--` | `-p --output-format json --trust -- <prompt>`; catálogo `--model auto` | `cursor-exclusive-cache` (medido) | `~/.config/cursor/auth.json` | `%APPDATA%\Cursor\auth.json` |
| Grok | 1.0.41 | arquivo 0600 | `--output-format json --prompt-file <arquivo>` | `anthropic-exclusive-cache` | `~/.grok/auth.json` | `C:\Users\Diego\.grok\auth.json` |
| Devin | 3000.11.3 (Windows 3000.1.27) | arquivo 0600 | `-p --respect-workspace-trust false --prompt-file <arquivo>` | sem uso (texto puro) | `~/.local/share/devin/credentials.toml` | `%APPDATA%\devin\credentials.toml` |
| Muse | capturada 1.3.0; WSL tem `muse-bin-1.4.0-R4161.1` (versão efetiva a confirmar) | arquivo 0600 | `exec --json --prompt-file <arquivo>` | sem uso (só evento terminal) | `~/.config/muse` | — |

Regras que valem para todos:

- uso desconhecido é omitido (`null`), nunca zero;
- falha grava `agent.failed` com código, exit e o fim do stderr (prompt redigido, segredo retido);
- `envInherit` lista só nomes;
- o catálogo não guarda valores.

## 7. Ambiente local, caminhos e versões

| Item | Valor |
|---|---|
| SO | Windows 11 Pro; shell do agente: PowerShell e Git Bash |
| WSL | Ubuntu; usuário `diego` UID 1000; `HOME=/home/diego` |
| Docker | 29.8.1, dentro do WSL (`wsl bash -lc 'docker …'`) |
| Repositório no WSL | `/mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff` |
| CLIs Linux | `~/.local/bin` (symlinks absolutos para `/home/diego/...`); Node e Codex em `~/.local/share/node/bin` |
| Credenciais copiadas do Windows (rodada 14, autorizado) | `~/.grok/auth.json`, `~/.config/cursor/auth.json`, `~/.local/share/devin/credentials.toml` (todas 0600) |
| Chave do Droid | `C:\Users\Diego\.omp\agent\.env` → `OMP_GATE2_ENV_FILE=/mnt/c/Users/Diego/.omp/agent/.env` (filtrada por nome em `ENGINE_KEYS`) |
| Tags Docker | `omp-orchestrator:check`, `:smoke`, `:gate2`, `:upgrade-old`, `:push`, `:local`, `:local-preview`; `prom/prometheus:v3.5.0` |
| Containers de outro projeto | `openbots-*` sobem com o WSL; não tocar |
| Cache de editor | `.impeccable/` na raiz: não commitar |
| Instalador do Grok | `https://x.ai/cli/install.sh -s 1.0.41` |
| Conta Cursor | sem cota no modelo padrão; usar `--model auto` |

## 8. Como verificar (comandos)

Rode no Windows, na worktree:

```bash
npm ci
npm run lint
npm test
```

Esperado: lint limpo; 117 passam + 2 omitidos (só Linux).

Imagem Linux, no WSL:

```bash
cd /mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff
docker build -t omp-orchestrator:check . && docker run --rm omp-orchestrator:check npm test
```

Esperado: 119/119.

Stack (WSL):

```bash
test/compose/smoke.sh                              # SMOKE OK; KEEP=1 deixa de pé; "down" remove
FAKE=1 test/compose/gate2.sh                        # GATE2 OK, sem login nem quota
OMP_GATE2_ENV_FILE=/mnt/c/Users/Diego/.omp/agent/.env test/compose/gate2.sh   # REAL: consome quota, só com autorização
ONLY="real-cursor real-grok" KEEP=1 test/compose/gate2.sh                     # subconjunto; stack fica de pé
```

Upgrade/rollback (só quando o schema avança). O `git` do WSL não lê esta worktree, então gere a imagem antiga pelo Windows:

```bash
git archive <ref-antigo> | tar -x -C /c/Users/Diego/AppData/Local/Temp/omp-old
wsl bash -lc 'docker build -t omp-orchestrator:upgrade-old /mnt/c/Users/Diego/AppData/Local/Temp/omp-old'
wsl bash -lc 'cd /mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff && NEW_IMAGE=omp-orchestrator:smoke test/compose/upgrade-rollback.sh'
```

Browser e Prometheus: `docs/BROWSER-QA.md` e `docs/OBSERVABILITY.md`. O ensaio real da rodada 13 está no item 13.

## 9. Decisões que devem ser preservadas

1. O Orchestrator é a camada de política, estado e execução. Contratos de CLI/API/MCP e adapters de motores convergem no mesmo núcleo. Não duplique regras de autorização, orçamento, eventos, cancelamento ou persistência por interface.
2. Clientes externos e motores plugáveis são requisitos separados, e ambos precisam ser validados.
3. OMP fixado por versão, com artefato e SHA-256 verificados. Não use `latest` nem download sem pin/hash.
4. `command-json` é configurado pelo operador, sem segredos no catálogo, com limites de processo, cancelamento e isolamento de diretório. O prompt vai por stdin (Codex, Claude Code) ou por arquivo temporário 0600 (Droid, Grok, Devin, Muse). **Exceção:** o Cursor só aceita o prompt como argumento. Ele vai depois de `--`, fica visível na lista de processos local durante o job e isso aparece em `promptDelivery`. Um teste impede outro perfil de voltar ao argumento.
5. A preview é para uma pessoa ou equipe confiável. O worker compartilha SQLite, workspaces e credenciais, então não é sandbox nem multi-tenant.
6. Tokens e credenciais nunca vão em argumentos, logs, imagens ou arquivos versionados. O token HTTP não chega ao sidecar, e as credenciais dos motores não chegam ao serviço HTTP.
7. Evidência sintética não prova acesso a provider, quota, VPS pública ou TLS.
8. Retentativa em `SQLITE_BUSY` só na inicialização (`getDatabase`). Operações normais usam `busy_timeout` e `BEGIN IMMEDIATE`.
9. Todo ponto que grava `workerPid` grava `workerIdentity`, e toda decisão de vida ou sinal usa `processAlive`/`processReused`.
10. Uso desconhecido nunca vira zero; no `command-json`, é omitido. A semântica de cache de cada CLI vem de medição real, não de terceiros. Custos são estimativas equivalentes de API, não fatura.
11. `envInherit` lista só nomes. Herdar `HOME`/`USERPROFILE` dá à CLI o login local dela, aceitável só dentro da fronteira de confiança.
12. Toda migração precisa ser legível pela imagem anterior. O CI ensaia isso quando `SCHEMA_VERSION` muda; rode `upgrade-rollback.sh` antes de publicar.
13. O ator vem do transporte via `mcp/request-context.mjs`. Auditoria e atestação ficam no núcleo.

Nota operacional: o Compose monta o **diretório** do token. Rotacione com arquivo temporário no mesmo diretório e `mv`.

## 10. Aprendizados

1. **Meça o formato cru antes de normalizar.** A hipótese de terceiros (`pi-cursor-sdk`) sobre o cache do Cursor estava errada. Só o `usage` cru de uma execução real (4 / 26.032 / 9.550) mostrou isso.
2. **Clamps escondem erros.** O `min(cache, input)` transformou uma subcontagem de 1.800× em números "plausíveis". Prefira invariantes com teste e números reais nos fixtures.
3. **Fixture tem de ser tão rígido quanto o parser real.** O fake do Grok aceitava `-p -- prompt`, e o Grok real recusa. Cada flag nova precisa de prova real.
4. **Parsers estilo clap:** um posicional com `-` inicial vira opção sem `--`; uma opção que exige valor (`-p/--single`) não aceita `--` nem valor com `-`. Prefira arquivo de prompt ou stdin.
5. **`codex exec`:** `-` com stdin funciona; argumento **e** stdin juntos fazem o Codex anexar um bloco `<stdin>`. O `989309a` tirou a conclusão errada desse caso.
6. **CLIs headless com "workspace trust":** Devin (`--respect-workspace-trust false`) e Cursor (`--trust`) recusam diretórios novos sem essas flags.
7. **Bind de arquivo único mantém o inode.** `mv` no host não chega ao container. Monte o diretório.
8. **Docker cria os pais de mounts aninhados como root**, e tmpfs é `noexec` por padrão. O OMP precisa extrair o addon nativo em `~/.omp/natives` e carregá-lo, então use tmpfs com `uid=1000` e `exec`.
9. **Instaladores deixam symlinks absolutos** (`~/.local/bin/grok -> /home/diego/.grok/...`). O sidecar precisa do mesmo caminho de HOME do host.
10. **CI difere do host:** UID 1001 no runner; `OMP_ORCHESTRATOR_BIND=0.0.0.0` herdado na imagem. Rode a suíte na imagem antes do push.
11. **O `git` do WSL não lê uma worktree criada no Windows** (o gitdir é um caminho Windows). Use `git archive` pelo Windows.
12. **Credenciais em keyring do Windows não são portáveis** (Droid `auth.v2.keyring`); arquivos são (Grok, Cursor, Devin). Chaves por variável são a alternativa.
13. **Não adivinhe subcomandos de CLI** (`grok whoami` ficou pendurado). Use `--help` ou `auth status` documentados.
14. **Diagnóstico precisa ficar gravado.** Antes do `agent.failed`, seis falhas reais não deixavam nada para inspecionar.
15. **`upgrade-rollback.sh` pressupõe migração;** sem mudança de schema ele falha em "schema advanced". O CI só o roda quando `SCHEMA_VERSION` muda.
16. **Edição por shell no Windows corrompe escapes** (`\n`, `\r`, `\\`). Prefira a ferramenta de edição e confira com `od -c` ou `grep -c $'\r'`.
17. **Cota por modelo:** a conta do Cursor esgotou o modelo padrão, mas `auto` funciona. Falha de cota não é falha de integração, e o `agent.failed` mostra a diferença.

## 11. Desafios, riscos e dívidas

| Risco | Impacto | Mitigação atual / próxima |
|---|---|---|
| Sessões compartilhadas entre Windows e WSL (arquivos copiados) | Renovar um refresh token pode deslogar o outro lado | Decisão 10 da seção 15 (logins separados) |
| Drift de versão das CLIs | Formato muda e o parser falha | Parsers falham alto; passo 8 (aviso de drift) e canário (passo 13) |
| Prompt do Cursor visível no `ps` | Exposição local | Declarado em `promptDelivery`; não usar em VPS compartilhada |
| Devin e Muse sem uso | Custo invisível | Passo 10 (verificar saída JSON nas versões novas) |
| Droid falha sem stderr | Diagnóstico pobre | Passo 7 |
| Sidecar compartilha credenciais e estado | Um agente com shell lê o que o sidecar lê | Escopo "equipe confiável" (decisão 5) |
| Quebra da preview.3 (`TOKEN_FILE` → `TOKEN_DIR`) | Instalações antigas não sobem com token | Changelog e `DEPLOY-VPS.md`; notas de upgrade no passo 39 |
| Números antigos do Cursor subestimados | Relatórios anteriores errados | Changelog; item 14 |
| Alertas nunca vistos em `firing` | Alerta pode não disparar | Passo 20 |
| Regressão nativa no Windows após as mudanças do adaptador | Só Codex e Grok foram testados lá | Passo 15 |
| Workflow de upgrade só testado no caminho "sem migração" | Caminho com migração não provado no GitHub | Passo 3 |

## 12. O que não foi validado

- `upgrade-rollback.yml` com migração real no GitHub (rodou verde no #5 pelo caminho "sem migração");
- alertas em `firing`, `OmpReadyzFailing` e notificação;
- clientes reais (Claude Code, Codex, Cursor) controlando o Orchestrator por MCP HTTP;
- os 8 motores nativos no Windows depois das mudanças da rodada 14 (só Codex e Grok);
- timeout e abort reais em motores `command-json`;
- VPS, TLS, backup agendado real;
- isolamento para workloads não confiáveis (fora do escopo).

## 13. Autorizações e proteção de estado

- Autorizações valem **só na sessão em que o usuário as dá**. Nada do que foi autorizado em sessões anteriores se transfere.
- Sem autorização explícita, não faça:
  - push, merge ou release;
  - VPS, TLS ou deploy;
  - gasto de quota;
  - leitura, cópia ou movimentação de credenciais;
  - publicação de imagem;
  - remoção da worktree original.
- Não use reset, checkout, clean ou stash destrutivos. Depois de cada merge, crie branch nova de `origin/main` sem reescrever histórico.
- `envInherit` só nomes. Nunca imprima valores de credencial; confira nomes com `sed -n 's/^\([A-Z_]*\)=.*/\1/p'`.

---

## 14. Plano: 7 marcos, 50 passos

Cada marco traz etapas, entregáveis, thresholds (critérios mensuráveis), critério qualitativo, tarefas base e resultado esperado. "Q<n>" aponta para a pergunta da seção 15 da qual o passo depende.

### Marco 1: fechar a 0.8.0-preview.3

- **Etapas:** confirmar CI → merge → provar os workflows novos → estabilidade → limpeza.
- **Entregáveis:** #5 mergeado; `upgrade-rollback.yml` provado com migração; suíte estável em laço; worktree antiga arquivada; máquina limpa.
- **Thresholds:**
  - CI verde nos dois gatilhos e nos 3 workflows;
  - PR descartável com schema v5 dispara o ensaio e passa;
  - laço de 20/20 na imagem Linux e 10/10 no Windows.
- **Qualitativo:** nenhum gate declarado sem saída de comando; nenhuma credencial em log de CI.
- **Tarefas base:**
  1. Conferir o CI do #5 no último commit; corrigir se falhar.
  2. Merge do #5 (Q1) e branch nova de `origin/main`.
  3. PR descartável com uma migração v5 trivial para provar o `upgrade-rollback.yml`; fechar sem merge.
  4. Suíte em laço (20 vezes na imagem, 10 no Windows).
  5. Arquivar os não rastreados da worktree original num zip fora do repositório e removê-la com `git worktree remove` (Q3).
  6. Remover tags Docker e imagens de QA que não serão reutilizadas.
- **Resultado esperado:** `main` na preview.3, com CI provado nos três workflows.

### Marco 2: robustez dos motores

- **Etapas:** diagnóstico → contrato → fake → prova real.
- **Entregáveis:** erro do Droid legível; drift de versão no relatório; modelo por backend; decisão sobre logins; canário real; timeout e abort reais; regressão no Windows.
- **Thresholds:**
  - 100% dos perfis com falha diagnosticável no `agent.failed`;
  - gate real 8/8 ao fim do marco;
  - 0 regressões nos testes fake;
  - timeout e abort reais sem processo órfão.
- **Qualitativo:** semântica de uso só com medição real; falhar alto em vez de adivinhar.
- **Tarefas base:**
  7. Droid: levar ao `agent.failed` o erro do JSON do stdout quando não há stderr.
  8. Drift de versão: `omp_agent_backends` mostra a versão instalada ao lado da capturada, com aviso sem bloquear.
  9. Recapturar os formatos reais nas versões atuais e atualizar fixtures e o cabeçalho de `cli-profiles.mjs`.
  10. Devin e Muse: verificar se há saída JSON com uso; se houver, parser novo com medição.
  11. Modelo por backend documentado como escolha do operador (Q11).
  12. Logins separados entre WSL e Windows, ou compartilhados com o risco documentado (Q10).
  13. Canário real periódico com `gate2.sh` e aviso de falha (Q4, Q13).
  14. Timeout e abort reais em Claude e Codex (`limit_exceeded`, `cancelled`, sem órfãos).
  15. Regressão nativa no Windows com os 8 motores pelo Orchestrator (Q23).
- **Resultado esperado:** motores com diagnóstico, versões vigiadas e prova real recorrente.

### Marco 3: observabilidade completa

- **Etapas:** métricas → regras → ensaio até `firing` → notificação.
- **Entregáveis:** métricas por backend; `agent.failed` no console; alerta de motor falhando; probe do `readyz`; Alertmanager com Telegram; runbook ensaiado.
- **Thresholds:**
  - todos os alertas vistos em `firing` pelo menos uma vez;
  - notificação em até 2 min após o `firing`;
  - teste automatizado garante 0 prompts, outputs ou segredos nas métricas.
- **Qualitativo:** alertas acionáveis e sem ruído em operação normal.
- **Tarefas base:**
  16. Métricas por backend: jobs por status, histograma de duração, `agent.failed` por código.
  17. `agent.failed` no inspetor do console (código, exit, stderr).
  18. Regras `OmpEngineFailing` e heartbeat do canário.
  19. Probe do `readyz` com o blackbox exporter (Q6).
  20. Ensaio até `firing` de todos os alertas (`for:` curto só no ensaio).
  21. Alertmanager e Telegram (Q19).
  22. `OBSERVABILITY.md` com o ensaio e a checklist de operação.
- **Resultado esperado:** falhas de stack ou de motor chegam ao Telegram, com evidência.

### Marco 4: clientes reais controlando o Orchestrator

- **Etapas:** configuração local → prova por cliente → contrato automatizado → documentação.
- **Entregáveis:** configs MCP de exemplo; 2 ou mais clientes reais provados; teste de contrato MCP HTTP; seção "conectar seu agente" no README.
- **Thresholds:**
  - cada cliente completa o ciclo criar → acompanhar → resultado → abortar;
  - 100% das operações auditadas com o ator certo;
  - o contrato cobre listar, chamar e os erros 400/401/403.
- **Qualitativo:** nenhum comportamento especial por cliente (decisão 1).
- **Tarefas base:**
  23. Token nomeado por cliente e auditoria conferindo o ator.
  24. Claude Code como cliente MCP HTTP, com config local ao projeto (Q7, Q22).
  25. Codex como cliente MCP.
  26. Terceiro cliente, à escolha do usuário.
  27. Teste automatizado de contrato MCP HTTP.
  28. README: "conectar seu agente", só com exemplos provados.
- **Resultado esperado:** "agente controla o Orchestrator" provado com clientes reais.

### Marco 5: motores de próxima geração (ACP)

- **Etapas:** levantamento → recomendação → protótipo → prova → documentação.
- **Entregáveis:** relatório de viabilidade; backend `acp` com 1 motor real, se aprovado.
- **Thresholds:** eventos, abort e (se o protocolo permitir) steer provados em execução real; uso reportado ou declarado desconhecido, nunca zero.
- **Qualitativo:** contrato aberto em vez de mais um parser por CLI.
- **Tarefas base:**
  29. Levantar quais CLIs expõem ACP (o Devin tem `devin acp`) e o que oferecem.
  30. Relatório com recomendação (Q12).
  31. Backend `acp` com fixture fake no mesmo núcleo de eventos e cancelamento.
  32. Prova real com o Devin via ACP.
  33. Segundo motor via ACP, se houver.
  34. Documentar quando usar `omp-rpc`, `command-json` ou `acp`.
- **Resultado esperado:** motores externos com controle em tempo real.

### Marco 6: release 0.8.0

- **Etapas:** critérios → endurecimento → publicação → verificação da imagem publicada.
- **Entregáveis:** tag `v0.8.0`; imagem no GHCR fixada por digest; notas de upgrade; SBOM e assinatura, se decididos.
- **Thresholds:**
  - smoke e gate fake verdes contra a imagem **publicada**;
  - upgrade a partir da preview.2 ensaiado;
  - `npm audit` sem vulnerabilidade alta;
  - todos os gates acordados com evidência.
- **Qualitativo:** alguém de fora instala só com o README e o `DEPLOY-VPS.md`.
- **Tarefas base:**
  35. Critérios da 0.8.0 (Q14).
  36. Revisão de segurança do modelo "equipe confiável".
  37. Conferir, item a item, os 18 achados da auditoria contra o código atual.
  38. Workflow de release com build, SBOM e assinatura opcional, e push no GHCR (Q8, Q15, Q16).
  39. Notas de upgrade: `TOKEN_FILE` → `TOKEN_DIR`; correção do uso do Cursor.
  40. Smoke e gate fake contra a imagem publicada.
  41. Vigia de releases do OMP com o SHA para revisar o pin.
- **Resultado esperado:** versão instalável e verificável.

### Marco 7: VPS pessoal (quando liberado)

- **Etapas:** decidir motores → provisionar → TLS → operar → ensaiar desastre.
- **Entregáveis:** instância com TLS; backup automático com restore ensaiado; Prometheus e Telegram; runbook.
- **Thresholds:**
  - `readyz` 200 via HTTPS e 401 sem token;
  - restore lendo um artifact real;
  - alerta no Telegram;
  - gate real com os motores escolhidos passando na VPS.
- **Qualitativo:** porta só em loopback atrás do proxy; nenhum segredo em imagem.
- **Tarefas base:**
  42. Motores na VPS: (a) imagem com CLIs, (b) montadas do host ou (c) só omp-rpc (Q18).
  43. Provisionar: usuário UID 1000, Docker, firewall, SSH por chave (Q9, Q21).
  44. Deploy pelo `DEPLOY-VPS.md` com a imagem do GHCR por digest.
  45. TLS com Caddy ou nginx, `PUBLIC_ORIGIN` correto, sem logar `Authorization`.
  46. Login dos motores no sidecar da VPS, sem copiar credenciais do Windows.
  47. Backup agendado com retenção e destino (Q20) e ensaio de restore.
  48. Prometheus, Alertmanager e Telegram na VPS, com rotação de token ensaiada.
  49. Ensaio de desastre cronometrado: apagar o volume numa cópia e restaurar.
  50. Upgrade e rollback na VPS com a próxima versão.
- **Resultado esperado:** Orchestrator pessoal em produção, observado e recuperável.

---

## 15. Perguntas e decisões pendentes do usuário

**Agir**

1. Revisar e fazer o merge do #5 (CI verde em 7/7).
2. Cursor: aumentar a cota da conta ou aceitar `--model auto` como padrão.

**Autorizar (vale só na sessão em que for dado)**

3. Arquivar os não rastreados da worktree original num zip e remover a worktree.
4. Quota recorrente do canário real (8 prompts mínimos por execução).
5. Push e PRs dos marcos 1–5.
6. `docker pull` do blackbox exporter e do Alertmanager.
7. Configs MCP locais ao projeto para Claude Code e Codex (sem tocar nas configs globais).
8. Publicar no GHCR e criar a tag `v0.8.0`.
9. Acesso à VPS.

**Decidir**

10. Logins separados entre WSL e Windows (recomendado) ou compartilhados.
11. Modelo por backend fixado no catálogo (recomendado) ou padrão da conta.
12. Investir em ACP. Recomendado: levantamento antes de decidir.
13. Canário: diário, semanal (recomendado) ou manual.
14. Critérios da 0.8.0. Recomendado: marcos 1–3 e 6 obrigatórios; 4 e 5 podem ir para a 0.9.
15. GHCR público ou privado.
16. SBOM e assinatura obrigatórios ou opcionais.
17. Confirmar limite de tokens só como observação na 0.8.0.
18. Motores na VPS: (a), (b) ou (c). Trava o marco 7.

**Responder**

19. Telegram: você cria o bot e indica onde fica o token, ou prefere um passo a passo?
20. Backups: retenção e destino.
21. VPS: provedor, sistema operacional e domínio.
22. Clientes MCP a provar primeiro.
23. O Windows nativo continua como plataforma de primeira classe para os motores?

Para começar sem esperar o resto bastam as respostas 1, 3, 5 e 10: elas fecham o marco 1 e abrem o 2.

## 16. Checklist de cada rodada

1. Reportar branch, HEAD, `git status`, `git worktree list`, PR e CI antes de editar.
2. Confirmar quais autorizações valem **nesta** sessão.
3. Commits pequenos e convencionais, com status, diff e staged conferidos. Sem segredos, capturas ou `.impeccable/`.
4. Antes de push: lint, `npm test`, suíte na imagem Linux; smoke e `FAKE=1 gate2.sh` se tocar stack ou motores; `upgrade-rollback.sh` se houver migração.
5. Registrar a rodada em `docs/IMPLEMENTATION-5-PHASES.md` (o quê, por quê, como, arquivos, comandos, resultados, limitações) e atualizar este documento (seções 3, 10–12 e 14–15).
6. Remover stacks e diretórios de QA; conferir `docker ps -a` e `docker volume ls`.
7. Entregar no final: commits e hashes, comportamento, docs, verificações reais, não validado, próximo passo. Sem evidência, sem gate concluído.
