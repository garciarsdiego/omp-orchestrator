# Guia de browser do console (item 4) — PowerShell + WSL

 Rode no **PowerShell do Windows** (não no WSL). O repositório está em
 `C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff`, branch
 `codex/omp-postmerge` (ou `main` após o merge).

```powershell
cd C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff
git log -1 --oneline --decorate
git status --short --branch
```

## 1. Subir o stack local com token throwaway

```powershell
# Gera token local (não entra no Git) e sobe orchestrator + sidecar
wsl bash -lc 'cd /mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff && mkdir -p secrets && umask 077 && openssl rand -base64 48 | tr -d "\n" > secrets/access-token && chmod 600 secrets/access-token && docker compose up --build -d && docker compose ps'
```

Aguarde o sidecar:

```powershell
wsl bash -lc 'for i in $(seq 1 30); do code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $(cat /mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff/secrets/access-token)" http://127.0.0.1:8080/readyz); echo "readyz=$code"; [ "$code" = 200 ] && break; sleep 2; done'
```

Esperado: `healthz` 200 sem token; `readyz` 200 com token; sem token 401.

## 2. Criar um job fake + run com artifact (massa para o browser)

```powershell
$token = Get-Content C:\Users\Diego\Documents\ChatGPT\OMP-Orchestrator-handoff\secrets\access-token -Raw
$headers = @{ Authorization = "Bearer $($token.Trim())"; "Content-Type" = "application/json" }

# job fake (sem quota)
$agentBody = @{ name = "omp_agent_create"; arguments = @{ backend = "fake-command"; workspace = "browser-qa"; prompt = "hello-browser"; idempotencyKey = "browser-qa-001"; timeoutMs = 60000; confirmQuota = $true } } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/call -Method Post -Headers $headers -Body $agentBody

# backends com semântica de uso/cache
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/call -Method Post -Headers $headers -Body (@{ name = "omp_agent_backends"; arguments = @{} } | ConvertTo-Json)

# métricas JSON + Prometheus (com token)
Invoke-RestMethod -Uri http://127.0.0.1:8080/api/metrics -Headers @{ Authorization = "Bearer $($token.Trim())" }
Invoke-WebRequest -Uri http://127.0.0.1:8080/metrics -Headers @{ Authorization = "Bearer $($token.Trim())" } | Select-Object -ExpandProperty Content | Select-Object -First 20
```

Se o backend `fake-command` não existir nessa instalação, crie
 `config/backends.local.json` (ignorado pelo Git) com um `command-json` fake e
 monte via `compose.override.yaml`, conforme `docs/DEPLOY-VPS.md`. Não coloque
 credencial nesse arquivo.

## 3. Checklist no browser

1. Abra `http://127.0.0.1:8080/`.
2. Cole o conteúdo de `secrets/access-token` e clique **Conectar**.
3. Confira e anote:
   - [ ] overview lista runs / jobs / agents (o job `browser-qa-001` aparece?);
   - [ ] métricas do topo atualizam após Refresh;
   - [ ] seletor de motor mostra `id · tipo · perfil` e `· sem uso` quando `usageReported=false`;
   - [ ] passe o mouse no seletor: o `title` mostra o `cacheBehavior` (ex.: Cursor `cursor-exclusive-cache`);
   - [ ] clique numa run → painel mostra `omp_run_get`;
   - [ ] artifact abre como **texto** (`textContent`), sem HTML executado;
   - [ ] `omp_agent_backends` no painel Ferramentas mostra `usageSemantics` por backend;
   - [ ] recarregue a página: precisa colar o token de novo (token só em memória);
   - [ ] sem token, `/api/overview`, `/api/metrics` e `/metrics` retornam 401.
4. O que me enviar: para cada item, **passou/falhou + frase do que viu** (prints opcionais; não cole o token).

## 4. Derrubar e limpar o segredo local

```powershell
wsl bash -lc 'cd /mnt/c/Users/Diego/Documents/ChatGPT/OMP-Orchestrator-handoff && docker compose down -v && rm -f secrets/access-token && git status --short --branch'
```

Não commitar `secrets/`, `config/backends.local.json`, capturas nem `.impeccable/`.
