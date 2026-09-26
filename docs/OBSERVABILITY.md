# OMP Orchestrator: observabilidade mínima (opção B do item 6)

Baseado só no que já existe no código: `GET /metrics` (Prometheus 0.0.4),
`GET /api/metrics` (JSON) e a ferramenta `omp_metrics` (CLI/MCP). Todos exigem
o bearer da API. Não há prompts, outputs, argumentos nem segredos. As contagens
de jobs/runs refletem o que está armazenado, não taxa.

## Token do Prometheus

Crie um token próprio com nome, junto do token do operador, sem restart:

```sh
umask 077
PROM_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
printf 'operator:%s\nprometheus:%s\n' "$(cat secrets/access-token)" "$PROM_TOKEN" > secrets/access-token.new
# Temporário no mesmo diretório + mv: o Compose monta o diretório secrets/.
mv secrets/access-token.new secrets/access-token
printf '%s' "$PROM_TOKEN" > /etc/prometheus/omp-orchestrator-token
chmod 0400 /etc/prometheus/omp-orchestrator-token
```

Esse bloco supõe um arquivo com um único token sem nome (ator `default`), que
passa a se chamar `operator`. O arquivo aceita `nome:token` por linha. Nomes e tokens não podem repetir.
Cada token precisa de pelo menos 32 bytes. Uma reescrita inválida mantém os
tokens anteriores em vez de bloquear os operadores. O nome vira o ator da
auditoria (`omp_audit_list`).

## Scrape

`docs/DEPLOY-VPS.md` já traz o exemplo com `credentials_file`. Exemplo completo:

```yaml
scrape_configs:
  - job_name: omp-orchestrator
    scrape_interval: 30s
    scrape_timeout: 10s
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/omp-orchestrator-token
    static_configs:
      - targets: ["127.0.0.1:8080"]
```

Validação manual:

```sh
TOKEN="$(cat /etc/prometheus/omp-orchestrator-token)"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/metrics
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/metrics | head -n 20
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/metrics | head -c 500
```

Sem token, `/metrics` e `/api/metrics` retornam 401 e incrementam
`omp_orchestrator_http_auth_failures_total` e `http.requests{code_class="4xx"}`.

## Alertas mínimos

Regras de exemplo (Prometheus):

```yaml
groups:
  - name: omp-orchestrator
    interval: 30s
    rules:
      - alert: OmpOrchestratorDown
        expr: up{job="omp-orchestrator"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "OMP Orchestrator fora do ar (alvo Prometheus down)"
      - alert: OmpReadyzFailing
        expr: probe_success{job="omp-orchestrator-readyz"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "readyz com falha (storage ou sidecar sem heartbeat)"
      - alert: OmpAgentSupervisorNotReady
        expr: omp_orchestrator_agent_supervisor_ready == 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "sidecar de agentes sem heartbeat recente"
      - alert: OmpHttp5xx
        expr: increase(omp_orchestrator_http_requests_total{code_class="5xx"}[5m]) > 0
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "erros 5xx na API HTTP"
      - alert: OmpAuthFailuresSpike
        expr: increase(omp_orchestrator_http_auth_failures_total[5m]) > 5
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "pico de bearers recusados (token errado ou scan)"
```

`readyz` exige bearer e retorna 200 só com storage aberto e heartbeat do
sidecar há menos de 5 s; senão 503. Para `probe_success`, use blackbox
exporter com header `Authorization: Bearer <token>` ou um script que chame
`/readyz` com o token do Prometheus e exporte 1/0.

## Backup automático + teste de restore

O pacote usa backup online do SQLite + `integrity_check` + CAS + `manifest.json`
com SHA-256. Não copie `orchestrator.sqlite` com `-wal`/`-shm` a quente.

Exemplo de cron (host com Docker):

```cron
0 3 * * * docker compose -f /opt/omp-orchestrator/compose.yaml exec -T orchestrator node scripts/backup.mjs --output /var/lib/omp-orchestrator/backups >> /var/log/omp-backup.log 2>&1
0 4 * * 0 docker compose -f /opt/omp-orchestrator/compose.yaml cp orchestrator:/var/lib/omp-orchestrator/backups/. /srv/omp-backups/latest/ && test -f /srv/omp-backups/latest/manifest.json
```

Teste de restore (obrigatório antes de confiar no backup): restaurar em volume
novo e subir cópia em outra porta de loopback, conforme `docs/DEPLOY-VPS.md`
e `test/compose/smoke.sh` (seção "backup and restore into a fresh volume").
Só aceite o backup depois de ler um artifact/run esperado do pacote;
`readyz` sozinho também passa com estado vazio.

## Runbook de rotação

Adicionar o novo token junto do antigo, trocar o cliente e remover o antigo.
Cada versão de `secrets/access-token` é escrita num temporário do mesmo
diretório e trocada com `mv` (o Compose monta o diretório).

```sh
umask 077
NEW="$(openssl rand -base64 48 | tr -d '\n')"
{ cat secrets/access-token; printf 'prometheus-next:%s\n' "$NEW"; } > secrets/access-token.tmp
mv secrets/access-token.tmp secrets/access-token                      # 1. novo junto do antigo
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $NEW" http://127.0.0.1:8080/metrics   # 2. precisa dar 200
printf '%s' "$NEW" > /etc/prometheus/omp-orchestrator-token.new       # 3. troca o do Prometheus
mv /etc/prometheus/omp-orchestrator-token.new /etc/prometheus/omp-orchestrator-token   # arquivo do host: aqui mv serve
chmod 0400 /etc/prometheus/omp-orchestrator-token
grep -v '^prometheus:' secrets/access-token | sed 's/^prometheus-next:/prometheus:/' > secrets/access-token.tmp
mv secrets/access-token.tmp secrets/access-token                      # 4. remove o antigo
```

O servidor relê em até 1 s, sem restart. Não há janela sem token válido: o
antigo vale até o passo 4 e o novo desde o passo 1. O Prometheus relê o
`credentials_file` a cada scrape.

Histórico: até a 0.8.0-preview.2 o Compose montava o arquivo, não o
diretório. Um `mv` trocava o inode e o container seguia com o antigo (medido
em 26/09/2026: token novo com 401 até reiniciar). Desde a preview.3, o
`test/compose/smoke.sh` prova a rotação por `mv` sem restart. O runbook
anterior também gerava um token do Prometheus que nunca entrava no arquivo do
servidor.

## Limites

- Métricas são do processo HTTP (`http.requests`, `authFailures` são
  contadores desde o início do processo).
- Não há taxa/latência por endpoint, nem custo real de provider (só estimativa
  equivalente quando o motor reporta).
- Auditoria (`omp_audit_list`) cobre operações que mudam estado; leituras não
  são auditadas.
- Para pessoa/equipe confiável. Não é sandbox nem isolamento multicliente.
