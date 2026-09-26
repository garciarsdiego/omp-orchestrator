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

A imagem executa como o usuário `node` (UID 1000). O arquivo de token montado com permissão `0600` deve ser legível por esse UID no host; em uma VPS, crie-o com o usuário de UID 1000 ou ajuste a propriedade do arquivo antes de subir. Não torne o token legível por todos para contornar uma falha de permissão.

O primeiro endpoint verifica que o processo HTTP responde. `readyz` exige token, abre o storage e confirma um heartbeat recente do sidecar; pode retornar 503 nos primeiros segundos da subida. Em 25/09/2026, build e Compose passaram no Docker via WSL/Ubuntu: health/ready 200, sem token 401, OMP18.3.2, job fake no sidecar e restore de artifact em outro mount. Nenhum provedor real ou VPS foi usado.

O Compose usa `${OMP_ORCHESTRATOR_PUBLIC_ORIGIN:-http://127.0.0.1:8080}`: a variável exportada no comando substitui a origem padrão de loopback. Mantenha a publicação host em loopback para a configuração local. Os volumes nomeados `omp-state` e `omp-workspaces` preservam respectivamente estado/SQLite/objetos e diretórios de trabalho; `OMP_ORCHESTRATOR_WORKSPACE_ROOT=/workspaces` faz os jobs de agente usarem o segundo volume.

`OMP_ORCHESTRATOR_HOST_PORT` altera a porta publicada no loopback, e `OMP_ORCHESTRATOR_TOKEN_FILE` permite montar um arquivo de token fora do diretório do projeto. Se mudar a porta, ajuste também `OMP_ORCHESTRATOR_PUBLIC_ORIGIN`. `docker compose ps` deve mostrar `orchestrator` e `agent-worker` saudáveis. O sidecar não publica porta e só executa jobs já registrados no SQLite.

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
