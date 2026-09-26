# Auditoria de upstream do Oh My Pi

Verificação em **2026-09-25 22:32:19 -03:00 / 2026-09-26 01:32:19 UTC**. Fontes upstream foram consultadas por GitHub REST/raw, sempre fixadas ao commit quando a evidência é de código/documentação. Nenhuma instalação, execução de provedor, leitura de credencial ou alteração do produto foi feita.

## Identidade upstream e separação release/main

O endpoint oficial `releases/latest` retornou **v18.3.2**, publicada em `2026-09-26T00:00:25Z`, com o commit `7853b4e499936f9dcc13c9b64adb55f6b342aabf`. A consulta oficial de `commits/main` retornou o mesmo SHA neste instante; portanto, não há divergência observável entre a tag latest e `main` na coleta. O release body de v18.3.2 registra, entre outros, `ctx.agent` para identidade de subagente e correções de compaction/Anthropic/Windows.

- Release API: <https://api.github.com/repos/can1357/oh-my-pi/releases/latest>
- Commit/tag verificados: <https://api.github.com/repos/can1357/oh-my-pi/commits/v18.3.2> e <https://api.github.com/repos/can1357/oh-my-pi/commits/main>
- Release: <https://github.com/can1357/oh-my-pi/releases/tag/v18.3.2>
- Main tree usado na inspeção: <https://github.com/can1357/oh-my-pi/tree/7853b4e499936f9dcc13c9b64adb55f6b342aabf>

O checkout auditado é o OMP Orchestrator no commit `1f304720fce254e2bee0901dfcb96b16028b018a`, pacote `0.7.0` (`package.json:1-18`). O runtime instalado informado pelo agente principal é `omp/18.3.0`; isso não equivale a v18.3.2 latest e deve ser tratado como uma matriz de compatibilidade separada.

## Mapa local observado

- Entrada OMP: `mcp/lib.mjs:5-87`; `runOmp()` chama o executável configurado por `OMP_EXECUTABLE`, e o produto consome somente `omp --version`, `config path`, `config get modelRoles --json` e `models --json`.
- Gateway local: `mcp/gateway.mjs:7-151`; interpreta `provider/model[:effort]`, monta uma requisição Responses não-streaming para `/v1/responses`, usa `prompt_cache_key` obrigatório e cancela destruindo a requisição HTTP.
- Broker/gateway gerenciado: `mcp/runtime.mjs:7-151`; sobe `omp auth-broker serve` em `127.0.0.1:9000` e `omp auth-gateway serve` em `127.0.0.1:4000`, registra apenas PID/tempo em `%TEMP%`, exige `confirm=true` e não expõe tokens.
- Catálogo/roles: `mcp/providers.mjs:4-103`; mapeia dez famílias lógicas a IDs de provider e classifica prontidão por modelos efetivamente retornados, mantendo `configuredRoles` e seletor exato.
- Orquestração: `mcp/templates.mjs:1-57` define DAGs locais de inferência/validação/attestation com roles `plan`, `designer`, `advisor`, `default`; `mcp/server.mjs:86-338` expõe jobs persistentes, runs, eventos, cancelamento, resume e attestation por MCP.
- Contrato declarado: `README.md:7-25,40-68,93-131,153-160`; o produto é um plugin MCP independente, mantém Codex como orquestrador/revisor, suporta jobs/DAGs e prende o transporte atual ao gateway local autenticado.

## Evidência upstream atual

1. **RPC headless é um protocolo real, não só uma menção.** `docs/rpc.md` descreve JSONL sobre stdio, implementação primária em `packages/coding-agent/src/modes/rpc/rpc-mode.ts`/`rpc-types.ts`/`session/agent-session.ts`, frame `ready`, negociação de protocolo v2 e categorias de eventos. Os comandos canônicos incluem `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session`, `open_session`, `get_state`, `get_entries`, `get_tree`, `get_subagents` e `set_subagent_subscription`.
   Fonte: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/rpc.md> (linhas 1-12, 16-31, 65-82, 96-143).

2. **ACP também é uma entrada separada.** A referência CLI lista `--mode text|json|rpc|acp|rpc-ui`, e o subcomando `omp acp` executa servidor Agent Client Protocol sobre stdio; há implementação em `packages/coding-agent/src/modes/acp/`.
   Fonte: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/cli-reference.md> (linhas 131-176, 182-186); árvore API: <https://api.github.com/repos/can1357/oh-my-pi/git/trees/7853b4e499936f9dcc13c9b64adb55f6b342aabf?recursive=1>.

3. **Sessão, steer, abort e quiescência têm semântica explícita.** RPC emite `prompt_result`, `session_settled`, `agent_start`/`agent_end` e frames de subagente; `prompt_result` significa yield, enquanto `session_settled` só ocorre quando não há execução, fila steer/follow-up, job assíncrono ou entrega pendente. `open_session` adota uma sessão persistida por diretório.
   Fonte: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/rpc.md> (linhas 224-269).

4. **Broker/gateway upstream suporta remoto e mais contratos que o adaptador local usa.** `docs/auth-broker-gateway.md` define broker como escritor canônico da vault SQLite e gateway como forward proxy para OpenAI Chat Completions, Anthropic Messages, OpenAI Responses, pi-native stream, System One e modalidades de imagem/áudio/embedding/rerank/vídeo. Transporte entre hosts é responsabilidade do operador via Tailscale/WireGuard/reverse proxy + TLS; quase todos endpoints exigem bearer. Há endpoints snapshot/SSE, credential, refresh, disable, block, usage e health, além de `OMP_AUTH_BROKER_URL`/`OMP_AUTH_BROKER_TOKEN` e cache criptografado.
   Fonte: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/auth-broker-gateway.md> (linhas 1-10, 42-87, 231-265).

5. **Modelos e configuração têm CLI pública e seleção por sessão.** A referência CLI documenta `omp models`, `--provider-session-id`, `--prompt-cache-key`, `--session-dir`, `--continue`, `--resume`, `--fork`, `--mode json/rpc/acp`; o endpoint upstream não deve ser presumido idêntico ao catálogo local sem executar `omp models --json` da versão instalada.
   Fonte: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/cli-reference.md> (linhas 54-95, 164-220).

6. **Subagentes e worktrees são implementados como superfícies próprias.** `docs/agent-hub.md` documenta roster persistido, status, uso, transcript, steering, revive e kill; registra caminhos de output/patch e metadados de branch/worktree isolado. A árvore contém `packages/coding-agent/src/modes/agent-hub-runtime.ts`, `packages/coding-agent/src/tools/task*`, `packages/coding-agent/src/cli/worktree-cli.ts` e `docs/task-agent-discovery.md`.
   Fontes: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/agent-hub.md> (linhas 1-6, 24-44, 59-69, 81-106); <https://api.github.com/repos/can1357/oh-my-pi/git/trees/7853b4e499936f9dcc13c9b64adb55f6b342aabf?recursive=1>.

7. **MCP upstream é configuração/runtime de ferramentas, enquanto o projeto auditado é servidor MCP.** A árvore upstream contém `docs/mcp-config.md`, `docs/mcp-protocol-transports.md`, `docs/mcp-runtime-lifecycle.md`, `packages/coding-agent/src/modes/components/extensions/mcp-runtime.ts`; localmente, `mcp/server.mjs` registra ferramentas `omp_*`. Isso prova superfícies complementares, não interoperabilidade automática entre os dois MCPs.
   Fontes: <https://api.github.com/repos/can1357/oh-my-pi/git/trees/7853b4e499936f9dcc13c9b64adb55f6b342aabf?recursive=1>; <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/mcp-runtime-lifecycle.md>.

8. **Docker/web/colaboração remota existem no upstream, mas não foram incorporados localmente.** A árvore contém `Dockerfile`, `Dockerfile.robomp`, `python/robomp/docker-compose.yml`, `python/robomp/web/` e `packages/collab-web/`; README upstream descreve `/collab`, `omp join` e viewer web. A documentação do broker deixa claro que exposição entre hosts exige transporte seguro operado pelo deploy. VPS é objetivo explícito desta auditoria; ainda falta decidir o perfil de usuário/equipe/multicliente e sua fronteira de autorização.
   Fontes: <https://api.github.com/repos/can1357/oh-my-pi/git/trees/7853b4e499936f9dcc13c9b64adb55f6b342aabf?recursive=1>; <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/README.md>; <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/auth-broker-gateway.md>.

## Matriz de decisão

| Recurso upstream | Suporte no projeto em `1f30472` | Compatibilidade observada | Incorporar ou adiar |
|---|---|---|---|
| CLI público de versão/config/modelos | `mcp/lib.mjs` consome `--version`, `config path`, `config get modelRoles --json`, `models --json` | Compatível com o OMP local `18.3.0`; shape de catálogo deve ser revalidado por versão | **Incorporar incrementalmente:** capability probe e diagnóstico de schema; manter fallback sem hardcode de catálogo |
| Roles e catálogo por provider | `mcp/providers.mjs` mantém mapa fixo de dez famílias e seletor exato | Compatível conceitualmente; recomendações podem envelhecer (release atual já é 18.3.2) | **Incorporar:** tornar IDs/recomendações dados observáveis/versionados; não afirmar disponibilidade por README |
| Auth broker/gateway local | `mcp/runtime.mjs` sobe os dois serviços loopback e `mcp/gateway.mjs` chama Responses | Compatível com comandos upstream; local usa apenas porta fixa, `/v1/responses` e token interno; upstream permite remoto e vários protocolos | **Incorporar em etapas:** adapter de capabilities e URLs configuráveis; remoto/VPS só após decisão de transporte, autenticação e ownership |
| RPC JSONL headless | Ausente; jobs fazem HTTP Responses e estados próprios | Contrato documentado para `omp --mode rpc` e frames versionados; integração de execução ainda não testada | **Incorporar primeiro:** backend de execução RPC opcional com normalização para job/event store; preservar gateway como backend de transporte |
| ACP | Ausente | ACP é servidor stdio voltado a clientes/editor; não substitui automaticamente MCP ou RPC | **Adiar:** adicionar somente se cliente ACP concreto entrar no escopo |
| Sessões, steer, abort e eventos | Jobs/runs locais têm `queued/running/succeeded/failed`, polling, cancelamento e eventos; cancel destrói request/processo | Local não preserva sessão OMP nem distingue yield de settled; RPC upstream possui semântica rica | **Incorporar depois do RPC:** mapear `prompt_result`/`session_settled`/abort para eventos, com testes de perda/reconexão |
| MCP | Projeto é servidor MCP de ferramentas `omp_*`; não há ponte explícita para MCP runtime upstream | Complementar; não há prova de compatibilidade automática | **Incorporar somente como adaptador:** descoberta/configuração MCP upstream, sem misturar autoridade de credencial |
| Subagentes/Agent Hub | Templates fazem DAG de chamadas por roles; não usam `task`, registry, transcript ou Hub | Não equivalente a subagentes upstream isolados | **Adiar:** exige contrato de identidade, persistência, steer/revive/kill, artefatos e worktrees |
| Worktrees/isolamento | README declara runs isolados e armazenamento próprio, mas não integração com worktree OMP | Upstream possui CLI/worktree e metadados de branches; local não prova isolamento de checkout | **Incorporar com o motor agente:** workspace por execução e receipt verificável; worktree não substitui sandbox |
| Docker/robomp/web/collab | Ausentes do produto | Podem hospedar OMP/UX no VPS, mas adicionam deploy, rede, TLS e controle de acesso | **Propor incrementalmente:** incluir Docker/robomp no desenho do VPS; fechar antes o perfil usuário/equipe/multicliente e a autorização |

## Recomendação incremental

Para clientes quaisquer e motores intercambiáveis, separar três interfaces: (1) `ModelCatalog`/`RoleResolver` sobre CLI pública e capability probe; (2) `ExecutionBackend` com implementações `responses-gateway` (atual) e `omp-rpc` (novo, opcional); (3) `Session/Event` normalizador que converta job local e frames RPC sem fingir que `succeeded` equivale a `session_settled`. O broker deve continuar atrás de uma interface de credencial, com modo loopback atual como default.

Sequência recomendada: primeiro registrar versão/SHA/capabilities e tolerar diferenças 18.3.0→18.3.2; depois prototipar RPC stdio para uma execução textual e mapear prompt/steer/abort/eventos; em paralelo, tratar workspace isolado como requisito do motor agente, não como simples extensão do DAG; então avaliar sessões persistentes e subagentes/worktrees. Docker/robomp entra como opção de empacotamento do VPS, condicionada ao perfil de usuário/equipe/multicliente e à política de autorização. ACP, web/collab e broker remoto dependem desses contratos; as fontes upstream delegam TLS/rede ao operador.

## Questão crítica: selector explícito e roteamento do gateway

Há uma perda concreta de seleção no caminho local. `mcp/jobs.mjs:32-49` valida `provider/model[:effort]` e persiste `selector`, `parsed.provider` e `parsed.model`; porém `mcp/job-worker.mjs:24-34` passa somente `job.request.model`, e `mcp/gateway.mjs:104-114,127-132` monta o body com apenas `model`, `input`, limites, stream e `prompt_cache_key`. O provider não é enviado como campo separado, nem como header.

No upstream v18.3.2, o gateway resolve o `model` recebido contra um índice construído em `packages/coding-agent/src/cli/auth-gateway-cli.ts:194-210`: `provider/id` é sempre indexado e o `id` simples é apenas fallback `first-write-wins` para clientes legados. O handler em `packages/ai/src/auth-gateway/server.ts:270-287` lê o campo top-level `model`, chama `bootOpts.resolveModel(modelId)`, e rejeita modelo desconhecido; depois, em `:345-382`, resolve a credencial e registra `model.provider`/`model.id`. Portanto:

- `model: "provider/id"` é formato aceito e preserva explicitamente o provider no upstream;
- `model: "id"` também pode funcionar, mas seleciona o primeiro modelo daquele id na ordem do catálogo entre providers autenticados; essa escolha é ambígua e não é garantia de prioridade desejada;
- a resolução do provider determina `resolveGatewayApiKey`, account/session state, retry/usage e o `resolvedProvider` registrado, portanto não é somente metadata;
- não há evidência de que o gateway interprete `provider` em um campo separado do Responses body. O contrato demonstrado é o ID composto dentro de `model`.

Para o projeto, a correção recomendada é preservar e enviar o selector composto (`provider/model`) no campo `model` até um backend upstream compatível, mantendo `reasoning` separado. O worker deve derivar `provider` e `model` de `job.request.selector` no momento da chamada, ou o job deve armazenar um `requestModel` canônico já composto; a validação deve rejeitar qualquer selector que não esteja no catálogo. A proveniência/uso deve continuar ancorada em `selector`, provider e model resolvidos, e testes devem provar que dois providers com o mesmo `id` não colapsam no bare-id fallback. Não recomendo adicionar um campo `provider` arbitrário sem contrato upstream.

Fontes pinned: <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/packages/coding-agent/src/cli/auth-gateway-cli.ts> (linhas 194-210); <https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/packages/ai/src/auth-gateway/server.ts> (linhas 270-287, 336-382); local: `mcp/jobs.mjs:32-49`, `mcp/job-worker.mjs:24-34`, `mcp/gateway.mjs:104-132`.

Limitações: a coleta não executou `omp models`, `omp --mode rpc`, `omp acp`, broker, gateway, Docker ou provedores; portanto, atesta contratos documentados e caminhos de código upstream, não compatibilidade end-to-end. A tag latest pode avançar depois do horário de verificação.
