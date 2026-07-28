# OMP Orchestrator — próximos passos executáveis

Data: 2026-07-28
Estado-base: plugin `0.5.0`, Oh My Pi `17.1.8`, 10 providers prontos,
352 modelos disponíveis, 26 testes e smoke test aprovados.

## Objetivo

Evoluir o plugin de uma integração funcional e ampla para um orquestrador
durável, verificável e seguro para uso recorrente. A prioridade imediata não é
adicionar mais providers ou routing inteligente; é tornar persistência,
orçamento, readiness e contratos honestos sob falhas reais.

## Evidência usada

O plano combina:

- inspeção local do código e testes;
- análise OMP `plan` com Claude Fable 5;
- análise adversarial OMP `advisor` com Claude Opus 5;
- consolidação e verificação final pelo Codex.

Os modelos receberam apenas um resumo técnico autorizado do repositório, não o
código-fonte completo nem credenciais.

## Decisões

1. Preservar Codex como root orchestrator e atestador final.
2. Manter o conjunto atual de dez providers; não ampliar antes de readiness real.
3. Manter routing estático e auditável até existir evidência interna suficiente.
4. Tratar preço desconhecido como desconhecido, nunca como custo zero.
5. Persistir estado fora do diretório temporário antes de expandir pipelines.
6. Templates permanecem declarativos: nenhum `eval`, script ou hook arbitrário.
7. Benchmarks serão pequenos, específicos por papel e limitados por orçamento.
8. Para providers por assinatura, custo equivalente de API é telemetria em modo
   `observe`; chamadas, tokens e duração permanecem limites rígidos.

## Fase 0 — estabilizar e publicar a baseline

Prazo estimado: 1–2 dias.

Status em 2026-07-28: implementação, validação e revisão do diff concluídas;
commit local e tag permanecem intencionalmente separados da publicação.

### 0.1 Revisar e versionar o trabalho atual

- Separar as mudanças atuais em commits pequenos e revisáveis.
- Remover somente após confirmação os artefatos gerados
  `.agent-orchestration/` e `=`.
- Atualizar changelog e registrar a configuração compatível do OMP.
- Criar tag somente depois de CI e smoke aprovados.

Critérios de aceite:

- worktree sem artefatos acidentais;
- cada commit passa nos testes relevantes;
- versão do pacote, MCP e routing policy consistente;
- rollback possível para a baseline anterior.

### 0.2 Corrigir inconsistências pequenas já confirmadas

- Atualizar `getRoutingPolicy().version`, ainda reportando `0.4.0`.
- Fazer `pricing.normalizeSelector()` reconhecer `max` e `ultra`.
- Adicionar teste de regressão para catálogos acima de 200 modelos.
- Adicionar teste MCP para `omp_providers` e job por `selector`.
- Confirmar no README que existem 352 modelos no snapshot atual, sem transformar
  o número em contrato permanente.

Resultado:

- routing policy alinhada em `0.5.0`;
- pricing normaliza `max` e `ultra`;
- catálogo com mais de 200 entradas coberto por regressão;
- MCP e selector direto cobertos por testes;
- 26 testes, smoke, doctor, readiness 10/10 e ciclo runtime aprovados.

Critérios de aceite:

- nenhuma versão divergente no runtime;
- seletores com qualquer esforço suportado normalizam corretamente;
- readiness encontra providers localizados depois da posição 200;
- chamada por selector indisponível falha antes de consumir quota.

## Fase 1 — persistência e recuperação

Prazo estimado: 4–6 dias.

Status em 2026-07-28: implementação 0.6.0 concluída; 37 testes automatizados de
SQLite WAL, concorrência multiprocesso, reconciliação, checkpoints, migração,
CAS, GC e padrões de segredo aprovados. O dry-run e a importação explícita de
3 jobs, 2 runs e 12 eventos legados passaram sem erros; smoke confirmou OMP
17.1.8, 9 roles e 352 modelos.

### 1.1 Substituir JSON em `%TEMP%` por SQLite

Usar SQLite em WAL mode, com diretório configurável e privado. Entidades:

- `jobs`;
- `job_attempts`;
- `runs`;
- `run_nodes`;
- `events`;
- `artifacts`;
- `attestations`.

Não persistir tokens, headers de autorização ou snapshots do broker.

Critérios de aceite:

- reiniciar o MCP durante um job não perde o ledger;
- jobs interrompidos são marcados `interrupted`, não ficam eternamente `running`;
- resume continua de checkpoints sem repetir nós concluídos;
- gravações concorrentes não corrompem estado;
- migração importa, em modo explícito, registros JSON existentes;
- diretório e arquivos usam as permissões mais restritas suportadas no sistema.

Testes:

- kill do worker no meio de um job;
- kill durante uma DAG;
- restart e reconciliação;
- concorrência de escritores;
- migração e rollback;
- scanner de padrões de segredo sobre banco, eventos e artefatos.

### 1.2 Content-addressed artifacts

- Armazenar artefatos por SHA-256.
- Referenciar hashes nas atestações.
- Registrar selector concreto, esforço, provider e versão do OMP.
- Implementar garbage collection apenas para artefatos sem referência.

Critérios de aceite:

- resultado idêntico produz hash idêntico;
- atestação sempre aponta para conteúdo verificável;
- GC nunca remove artefato referenciado.

## Fase 2 — orçamento e preços honestos

Prazo estimado: 3–4 dias; pode ocorrer em paralelo com a Fase 1.

Status em 2026-07-28: implementação 0.7.0 concluída. Registry versionado,
precedência e cobertura de preços, políticas de jobs, retries com saldo
remanescente, cancelamento cooperativo com fallback, ledger SQLite v2 e
contratos MCP foram implementados. A migração v1→v2 criou backup automático e
importou cinco usages históricos como `legacy/unknown`. A cobertura inicial das
nove roles é 2 conhecidas, 7 desconhecidas e nenhuma entrada vencida. Os 46
testes, smoke com 352 modelos, estimativa real sem quota e empacotamento 0.7.0
foram aprovados.

### 2.1 Registry de preços versionado

Substituir a tabela embutida por dados versionados contendo:

- provider;
- modelo ou família;
- preço de entrada, cache e saída;
- modalidade de cobrança;
- data de vigência;
- URL ou nota de origem;
- nível de confiança.

Ordem de resolução:

1. selector exato;
2. família do modelo;
3. faixa explicitamente configurada;
4. `unknown`.

Critérios de aceite:

- relatório de cobertura para os modelos em papéis ativos;
- preço ausente retorna `unknown` com `highUsd: null`;
- DAG estrita não inicia com teto monetário impossível de provar;
- modo não estrito exige aprovação explícita e preserva o desconhecido no ledger;
- aviso de preço desatualizado.

### 2.2 Orçamento também para jobs avulsos

Hoje jobs avulsos têm confirmação de quota e teto de tokens, mas não um ledger de
orçamento equivalente às DAGs.

Adicionar:

- `maxInputTokens`;
- `maxOutputTokens`;
- `maxDurationMs`;
- `maxApiEquivalentUsd`, quando calculável;
- `costPolicy`: `observe`, `enforce` ou `disabled`;
- cancelamento cooperativo;
- razão explícita para `budget_exceeded`.

Política inicial:

- `observe` é o padrão para OAuth e assinaturas;
- `enforce` é reservado para credenciais pay-as-you-go;
- preço desconhecido não bloqueia `observe`, mas fica explícito na telemetria;
- limites de chamadas, tokens e duração são calibrados por template e revistos
  com os valores reais de cada execução.

Critérios de aceite:

- retry consome o orçamento remanescente;
- job não inicia quando o custo máximo conhecido ultrapassa o teto;
- uso real é registrado mesmo quando a resposta falha no contrato.

## Fase 3 — readiness real e operação

Prazo estimado: 3–5 dias; depende da persistência para cache e histórico.

### 3.1 Estados de readiness

Substituir o booleano inferido do catálogo por:

- `authenticated`;
- `catalog_only`;
- `unavailable`;
- `unreachable`;
- `rate_limited`;
- `expired`;
- `unknown`.

Usar primeiro endpoints gratuitos de metadata. Quando só existir inferência
faturável, não testar automaticamente: marcar que a verificação exige probe
explícito com confirmação de quota.

Critérios de aceite:

- credencial revogada não aparece como provider saudável;
- 401, 403, 429 e timeout são diferenciados;
- resultado tem timestamp, TTL e origem;
- nenhum probe ou erro retorna tokens;
- startup não depende da disponibilidade de todos os providers.

### 3.2 Diagnóstico operacional

Adicionar um comando/tool de diagnóstico que reúna:

- versão do plugin e OMP;
- storage e migrações;
- runtime;
- papéis resolvidos;
- providers por estado;
- cobertura de preços;
- jobs interrompidos;
- limites ativos.

O diagnóstico deve ser somente leitura por padrão.

## Fase 4 — contratos e pipelines declarativos

Prazo estimado: 4–6 dias.

### 4.1 Generalizar contratos

Suportar declarativamente:

- texto/notas;
- JSON Schema;
- Markdown estruturado;
- HTML standalone;
- review JSON;
- conjunto de arquivos com manifesto.

Critérios de aceite:

- validação acontece antes da atestação;
- contrato e template têm hash persistido;
- erro de schema é determinístico e legível;
- normalização nunca altera conteúdo substantivo silenciosamente.

### 4.2 Templates configuráveis

Permitir templates built-in, do usuário e do projeto, com precedência explícita.
Um template declara:

- nós;
- dependências;
- role ou selector;
- contrato;
- limites;
- fallback allowlisted;
- condição de entrada;
- política de atestação.

Restrições:

- nenhum JavaScript ou shell embutido;
- nenhum caminho fora do root permitido;
- templates são validados integralmente antes do run.

Primeiros templates:

1. `implementation-and-review`;
2. `architecture-decision`;
3. `repo-audit`;
4. `benchmark-role`;
5. manter `single-file-web-app`.

## Fase 5 — benchmark interno

Prazo estimado: 5–8 dias; depende das Fases 1–3.

### 5.1 Suíte pequena por papel

Começar com até dez modelos e tarefas específicas:

- `default`: issues multi-arquivo com testes ocultos;
- `advisor`: PRs com defeitos semeados;
- `plan`: ADR e plano de migração;
- `smol`: correções curtas com limite de tempo;
- `tiny`: alterações unitárias;
- `designer`: screenshot + Playwright + acessibilidade;
- `task`: pesquisa e exploração;
- `vision`: interpretação e reprodução visual;
- `commit`: resumo e mensagem a partir de diff.

Métricas:

- sucesso;
- validação;
- qualidade cega;
- latência p50/p95;
- tokens;
- custo equivalente;
- retries;
- estabilidade em três execuções.

Critérios de aceite:

- seed, tarefa, selector e esforço registrados;
- teto de gasto cancela o restante da suíte;
- falha de um provider não invalida os demais resultados;
- exportação JSON e Markdown;
- benchmark completo nunca é o default;
- `--all-models` exige confirmação reforçada.

## Fase 6 — routing orientado por evidência

Não iniciar antes de haver pelo menos duas semanas de resultados internos.

Primeira versão:

- recomendação de selector, não troca silenciosa;
- regras estáticas derivadas das métricas;
- fallback explícito e reproduzível;
- cada decisão registra os candidatos, regra e motivo.

Somente depois considerar routing adaptativo. Qualquer algoritmo aprendido deve
ter modo replay e permitir reproduzir a decisão original.

## O que não construir agora

- novos providers além dos dez aprovados;
- dashboard web;
- cluster ou Postgres;
- marketplace de templates;
- scripts arbitrários dentro de contratos;
- automação de OAuth que manipule credenciais de outros CLIs;
- routing autônomo ou aprendizado online;
- sweep dos 352 modelos;
- publicação automática de artefatos ou mudanças externas.

## Ordem de execução

```text
Fase 0
  ├── Fase 1: persistência ──┬── Fase 3: readiness
  │                          └── Fase 4: contratos/templates
  └── Fase 2: orçamento/preços ─────────┐
                                       └── Fase 5: benchmark
                                                  └── Fase 6: routing
```

## Próxima unidade de trabalho

Executar apenas a Fase 0 em uma branch dedicada:

1. revisar o diff atual;
2. decidir sobre os dois artefatos não rastreados;
3. corrigir versões e normalização de esforço;
4. criar testes de catálogo grande, `omp_providers` e selector direto;
5. atualizar changelog;
6. rodar `npm test`, `npm run smoke` e um ciclo runtime start/stop;
7. entregar diff para revisão antes de commit/tag.

Essa unidade é pequena, reversível e prepara a base para a migração de
persistência sem misturar trabalho estrutural com o release atual.

## Ledger da consulta OMP

| Papel | Job | Selector | Status | Tokens | Contrato |
|---|---|---|---|---:|---|
| plan | `06cd0dfb-f4ba-4699-945d-3cd9fbc6c8d3` | `anthropic/claude-fable-5:high` | succeeded | 3.332 | notes |
| advisor | `1621791b-1a54-4b94-8ea4-bb7f3f032194` | `anthropic/claude-opus-5:high` | succeeded | 3.915 | notes |

Total: 7.247 tokens. Os dois outputs passaram na validação estrutural. A saída
do advisor atingiu o teto de 3.500 tokens e foi tratada como contribuição
parcial, não como plano completo.

### Consulta da Fase 2

| Papel | Job | Selector | Status | Tokens | Contrato |
|---|---|---|---|---:|---|
| plan | `46fb0b60-f9f5-4ef9-b5bf-997150d7bf92` | `anthropic/claude-fable-5:high` | succeeded | 3.793 | notes |
| task | `cabcd0a1-ecd0-4675-8c20-fb7962f685a2` | `xai-oauth/grok-4.5` | succeeded | 3.395 | notes |

Total da Fase 2: 7.188 tokens. Os dois contratos passaram. Grok registrou 3.077
tokens de saída para um máximo solicitado de 3.000, incluindo 77 tokens de
raciocínio; esse caso foi convertido em regressão para avaliação pós-chamada.
