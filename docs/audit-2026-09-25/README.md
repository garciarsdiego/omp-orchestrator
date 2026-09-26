# Auditoria de 25/09/2026

Instantâneo da auditoria que originou a preview 0.8. O relatório principal está em `AUDITORIA.md`, e os anexos que ele cita estão nesta pasta.

Arquivos não versionados, preservados apenas na worktree de origem:

- `doctor-local.json` e `interface-probes.json`: contêm caminhos locais da máquina auditada;
- os `.log` dos probes e testes, ignorados pelo `.gitignore`.

O `sk-proj-…` em `runtime-probes.mjs` é um segredo sintético usado para testar o scanner. Não é uma credencial.

A pasta fica fora da imagem Docker (`.dockerignore`) e do pacote npm (`files`).
