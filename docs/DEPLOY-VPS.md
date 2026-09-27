# OMP Orchestrator: Linux/VPS (pessoa ou equipe confiável)

Este pacote executa o HTTP/MCP do Orchestrator atrás de um token bearer e os agentes em um segundo container. O sidecar de agentes não recebe o arquivo do token HTTP. O broker/gateway OMP e a vault não são publicados: somente a porta HTTP `8080` do serviço principal é ligada a `127.0.0.1` do host por padrão.

## Artefato OMP fixado

O `Dockerfile` instala `omp-linux-x64` da release oficial `v18.3.2`, não um instalador mutável. A [release upstream v18.3.2](https://github.com/can1357/oh-my-pi/releases/tag/v18.3.2) aponta ao commit `7853b4e499936f9dcc13c9b64adb55f6b342aabf`; o [SHA256SUMS.txt oficial](https://github.com/can1357/oh-my-pi/releases/download/v18.3.2/SHA256SUMS.txt) lista para Linux x64 o SHA-256 `8cbbcd4bea7a7b86116a13352f31e3778fd4d93df931036bb1771738b0702534`. O build verifica esse digest antes de colocar o binário em `PATH`.
O MIT e as notas de terceiros da mesma revisão upstream são copiados para `licenses/` e incluídos na imagem.

O binário fixado é Linux x86_64 com glibc. Para arm64 ou musl, não altere somente a URL: troque o artefato e o SHA-256 pelos valores publicados na mesma release e faça um build/teste de imagem na arquitetura alvo. Não há alegação de que a imagem inclua credenciais OMP ou um broker remoto.

## Preparação local

Requer Docker Engine e Compose v2. Crie um token local de pelo menos 32 bytes, que não deve entrar no Git:

```sh
mkdir -p secrets
umask 077
openssl rand -base64 48 > secrets/access-token
docker compose up --build -d
curl -i http://127.0.0.1:8080/healthz
curl -i -H "Authorization: Bearer $(cat secrets/access-token)" http://127.0.0.1:8080/readyz
```

A imagem executa como o usuário `node` (UID 1000). O Compose monta o **diretório** `secrets/` (somente leitura) em `/run/omp-orchestrator/secrets`; o diretório e o arquivo de token, com permissão `0600`, devem ser legíveis por esse UID no host; em uma VPS, crie-o com o usuário de UID 1000 ou ajuste a propriedade do arquivo antes de subir. Não torne o token legível por todos para contornar uma falha de permissão.

O primeiro endpoint verifica que o processo HTTP responde. `readyz` exige token, abre o storage e confirma um heartbeat recente do sidecar; pode retornar 503 nos primeiros segundos da subida. Em 25/09/2026, build e Compose passaram no Docker via WSL/Ubuntu: health/ready 200, sem token 401, OMP18.3.2, job fake no sidecar e restore de artifact em outro mount. Nenhum provedor real ou VPS foi usado.

O Compose usa `${OMP_ORCHESTRATOR_PUBLIC_ORIGIN:-http://127.0.0.1:8080}`: a variável exportada no comando substitui a origem padrão de loopback. Mantenha a publicação host em loopback para a configuração local. Os volumes nomeados `omp-state` e `omp-workspaces` preservam respectivamente estado/SQLite/objetos e diretórios de trabalho; `OMP_ORCHESTRATOR_WORKSPACE_ROOT=/workspaces` faz os jobs de agente usarem o segundo volume.

`OMP_ORCHESTRATOR_HOST_PORT` altera a porta publicada no loopback, e `OMP_ORCHESTRATOR_TOKEN_DIR` permite montar um diretório de token fora do projeto (o arquivo dentro dele se chama `access-token`). **Mudança na 0.8.0-preview.3:** a variável antiga `OMP_ORCHESTRATOR_TOKEN_FILE` não é mais lida; quem a usava deve mover o arquivo para um diretório próprio e apontar `OMP_ORCHESTRATOR_TOKEN_DIR` para ele. Não aponte para um diretório com outros segredos: tudo nele fica visível ao serviço HTTP. Se mudar a porta, ajuste também `OMP_ORCHESTRATOR_PUBLIC_ORIGIN`. `docker compose ps` deve mostrar `orchestrator` e `agent-worker` saudáveis. O sidecar não publica porta e só executa jobs já registrados no SQLite.

Para usar `omp-rpc`, autentique o OMP **no ambiente do sidecar** depois de subir a instalação, seguindo a [documentação do OMP 18.3.2](https://raw.githubusercontent.com/can1357/oh-my-pi/7853b4e499936f9dcc13c9b64adb55f6b342aabf/docs/providers.md). Por exemplo, `docker compose exec agent-worker omp login <provider>` inicia o fluxo interativo; `docker compose exec agent-worker omp models --json` permite inspecionar a disponibilidade. Faça a autenticação na instalação de destino com o provedor desejado. Um login no Codex ou no computador local não provisiona automaticamente o container.

Para executar outra CLI, instale seu binário ou wrapper na imagem e crie `config/backends.local.json` com o contrato `command-json` do README. Monte esse arquivo **somente leitura em ambos** os serviços por um `compose.override.yaml` local:

```yaml
services:
  orchestrator:
    environment:
      OMP_ORCHESTRATOR_BACKENDS_FILE: /run/omp-orchestrator/backends.json
    volumes:
      - ./config/backends.local.json:/run/omp-orchestrator/backends.json:ro
  agent-worker:
    environment:
      OMP_ORCHESTRATOR_BACKENDS_FILE: /run/omp-orchestrator/backends.json
    volumes:
      - ./config/backends.local.json:/run/omp-orchestrator/backends.json:ro
```

O arquivo `config/backends.local.json` é ignorado pelo Git e pelo build Docker. Não coloque credenciais nesse arquivo: o agente pode ler arquivos visíveis ao usuário do sidecar. Configure credenciais do motor separadamente e conceda somente o acesso necessário.

## Tokens, rotação e auditoria

O arquivo de token aceita várias linhas, uma por token. Cada linha pode ter a forma `nome:token`, e linhas em branco ou começando com `#` são ignoradas. Cada token precisa de pelo menos 32 bytes, e nomes e tokens não podem se repetir. O nome identifica o ator: operações que mudam estado (criar, cancelar, retomar, atestar, abortar, iniciar/parar runtime) geram um evento em `audit_events` com ator, mecanismo (`http-bearer`), operação, alvo e resultado. A consulta é feita pela ferramenta `omp_audit_list`. Os argumentos não são gravados, porque podem conter prompts. A atestação de revisão registra o mesmo ator. Transportes locais (MCP stdio e CLI) aparecem como `local-operator`.

O servidor relê o arquivo até 1 s depois de uma alteração, sem reiniciar. Para rotacionar um token:

```sh
umask 077
printf 'ana:%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >> secrets/access-token   # novo, junto do antigo
# distribua o novo token; quando ninguém mais usar o antigo, remova a linha dele
```

Escreva a versão nova de forma atômica: arquivo temporário **no mesmo diretório** e `mv`. Isso funciona porque o Compose monta o diretório, não o arquivo. Com o arquivo único montado, um `mv` trocava o inode e o container seguia lendo o arquivo antigo (medido em 26/09/2026, token novo com 401). `test/compose/smoke.sh` verifica a rotação por `mv` sem restart. Confira o token novo com `curl` antes de remover o antigo. Se a versão nova for inválida (vazia, token curto, duplicado), o servidor registra o erro e **mantém os tokens anteriores**, para não bloquear os operadores. Um único token numa linha sem nome continua funcionando e aparece como `default`.

## Métricas

`GET /metrics` (formato de texto do Prometheus 0.0.4) e `GET /api/metrics` (JSON) exigem o mesmo bearer da API. A mesma visão em JSON sai pela ferramenta `omp_metrics` (CLI/MCP). O conteúdo:

- jobs por tipo (`inference`/`agent`) e status;
- runs por status;
- eventos de consumo e tokens registrados, incluindo os de preço desconhecido;
- resultados de auditoria;
- prontidão e idade do heartbeat do sidecar;
- respostas HTTP por classe de status e bearers recusados desde o início do processo.

Não há prompts, outputs, argumentos nem segredos. As contagens de jobs e runs refletem o que está armazenado, não uma taxa.

Para o Prometheus, dê a ele um token próprio (por exemplo `prometheus:<token>` no arquivo de tokens) e use:

```yaml
scrape_configs:
  - job_name: omp-orchestrator
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/omp-orchestrator-token
    static_configs:
      - targets: ["127.0.0.1:8080"]
```

## VPS com TLS reverso

No VPS, mantenha `127.0.0.1:8080:8080` no Compose e faça Caddy, Nginx ou outro proxy TLS do host encaminhar para `http://127.0.0.1:8080`. Configure a origem pública antes de subir:

```sh
OMP_ORCHESTRATOR_PUBLIC_ORIGIN=https://omp.example.com docker compose up -d
```

O proxy deve preservar `Host`, limitar acesso à origem esperada e nunca registrar o header `Authorization`. O token continua em arquivo montado somente leitura **apenas no serviço HTTP**; não o substitua por variável de ambiente, label ou arquivo dentro da imagem. O endpoint é para uma pessoa/equipe confiável. O sidecar ainda compartilha o volume SQLite, os workspaces e o diretório de credenciais OMP: agentes com shell podem ler ou alterar esse estado. Não use a preview para prompts, usuários ou workspaces mutuamente não confiáveis. Separar o bearer HTTP reduz o alcance de um agente, mas não é sandbox forte nem isolamento multicliente.

## Backup e restauração

Não copie `orchestrator.sqlite` junto com `-wal`/`-shm` enquanto o serviço estiver ativo. O script usa a API online de backup do SQLite, valida `integrity_check` no snapshot e cria um diretório de pacote com `orchestrator.sqlite`, cada objeto CAS referenciado pela metadata e `manifest.json` com SHA-256 de todos os arquivos:

```sh
docker compose exec orchestrator node scripts/backup.mjs --output /var/lib/omp-orchestrator/backups
```

Copie o diretório de pacote inteiro para armazenamento externo; o SQLite sozinho não restaura artifacts. Para testar uma restauração, faça-a primeiro em uma cópia vazia dos volumes, não sobre o serviço em produção:

1. Pare a cópia de teste e monte o diretório do pacote sob um caminho somente leitura.
2. Crie um volume novo que será montado em `/var/lib/omp-orchestrator`; o banco deve ficar no subdiretório `state/` desse volume. Execute a restauração em um container auxiliar com o volume montado também em `/restore-parent`:

   ```sh
   docker volume create omp-state-restore-test
   docker compose run --rm --no-deps \
     -v omp-state-restore-test:/restore-parent \
     -v "$PWD/backups/omp-orchestrator-...:/backup:ro" \
     --entrypoint node orchestrator scripts/backup.mjs \
     --restore /backup --state /restore-parent/state \
     --runtime-state /var/lib/omp-orchestrator/state
   ```

   `--state` é o staging dentro do volume novo; `--runtime-state` é o caminho que o processo verá quando esse mesmo volume estiver montado no local normal. O script verifica hashes, copia os objetos e grava esse caminho final no SQLite.
3. Monte `omp-state-restore-test` em `/var/lib/omp-orchestrator` na cópia de teste e suba com outro bind de loopback, por exemplo `127.0.0.1:18080:8080`.
4. Chame `readyz` com o token de teste e execute um cenário fake que não consuma quota.

Para restaurar produção, pare o serviço, faça um backup novo do estado atual, restaure o pacote já testado para um volume de estado novo com `--runtime-state /var/lib/omp-orchestrator/state` e então monte esse volume. A restauração recusa diretórios de destino existentes para não sobrescrever estado por engano. `readyz` confirma que o serviço respondeu e abriu storage; só aceite a restauração depois de ler um artifact/run esperado do pacote, pois `readyz` sozinho também pode passar com estado vazio.

## Atualização e rollback

Antes de atualizar, registre a imagem atual e faça backup. Construa a nova imagem em uma máquina/CI compatível, execute a suíte e teste a restauração em cópia de volume. Atualize a tag/hash OMP juntos, a partir da release upstream, e então reinicie:

```sh
docker compose build
docker compose up -d
docker compose ps
```

Se health/readyz falharem, volte à imagem anterior e ao snapshot testado. Um rollback de imagem não reverte automaticamente migrações ou alterações de estado; trate a restauração do SQLite e dos objetos como uma etapa separada e verificável.

**Política de schema.** Toda migração precisa ser compatível com a imagem anterior: a versão anterior do código deve continuar lendo e operando um banco já migrado. Por exemplo, a v3 troca `awaiting_codex` por `awaiting_review`, e o código continua aceitando os dois. Antes de aplicar uma migração num banco existente, o serviço grava `orchestrator.sqlite.bak-v<N>` ao lado do banco, uma cópia após `wal_checkpoint(FULL)`. Essa cópia não inclui os objetos CAS e não substitui o pacote de backup.

Há dois tipos de rollback:

1. **Só de imagem.** Suba a tag anterior sobre os mesmos volumes. Serve quando o problema está no código e o schema novo é compatível com a imagem anterior.
2. **Completo.** Restaure o pacote de backup feito antes do upgrade num volume novo (procedimento acima) e suba a imagem anterior sobre ele. O trabalho feito depois do upgrade não estará nesse estado.

`test/compose/upgrade-rollback.sh` ensaia os dois casos com motores fake:

- **Na imagem antiga:** estado e pacote de backup.
- **Upgrade:** a migração roda, o `.bak-v<N>` passa no `integrity_check` e os registros continuam legíveis.
- **Rollback só de imagem:** a imagem antiga lê o banco migrado e aceita trabalho novo.
- **Rollback completo:** o schema e os registros anteriores ao upgrade voltam.

Rode-o antes de publicar uma imagem que traga migração:

```sh
OLD_IMAGE=omp-orchestrator:<tag-anterior> NEW_IMAGE=omp-orchestrator:<tag-nova> test/compose/upgrade-rollback.sh
```

Em 26/09/2026, o ensaio passou em todos os checks do schema 2 (`831fd97`) para o 3, no Docker via WSL/Ubuntu. Nenhuma VPS foi usada.
