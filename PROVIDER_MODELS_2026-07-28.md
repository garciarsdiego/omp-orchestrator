# Catálogo atual de providers e modelos

Levantamento local realizado em 2026-07-28. A lista distingue modelos-base de
variantes de esforço, modo `fast`, contexto e aliases específicos de cada CLI.

## Resumo

| Provider/CLI | Catálogo confirmado | Observação |
|---|---:|---|
| Claude | 10 famílias | Enumeradas via Cursor e Antigravity; Claude Code não possui comando `models` |
| Codex | 8 modelos | Enumerados por `codex debug models` |
| Cursor | 193 entradas | Catálogo agregado; inclui variantes de esforço e `fast` |
| Grok | 1 modelo nativo | Enumerado por `agent models` |
| Qwen | 11 modelos únicos | Nove no Qwen Code mais duas referências GGUF |
| Kimi | 5 famílias | Três aliases nativos mais opções Alibaba/Cursor |
| Devin | 170 permitidos | A CLI informa a quantidade, mas não enumera todos os IDs |
| Gemini | 4 famílias | Antigravity e Cursor |
| DeepSeek | 5 modelos únicos | Provider direto e Alibaba |
| Cerebras | 3 modelos | Enumerados pelo OpenCode |

## Claude

Famílias Anthropic atualmente expostas no ambiente:

- `claude-opus-5`
- `claude-opus-4-8`
- `claude-fable-5`
- `claude-sonnet-5`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-opus-4-5`
- `claude-sonnet-4-5`
- `claude-sonnet-4`

Dependendo da família, o Cursor expõe variantes `low`, `medium`, `high`,
`xhigh`, `max`, `thinking` e `fast`. No Antigravity estão disponíveis
`claude-sonnet-4-6` e `claude-opus-4-6-thinking`.

O Claude Code aceita os aliases `fable`, `opus` e `sonnet`, além dos IDs
completos. A configuração local atual do Claude Code aponta para `kimi-k3`,
portanto ela não está usando um modelo Anthropic como padrão.

## Codex

- `gpt-5.6-sol`
  - esforços: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- `gpt-5.6-terra`
  - esforços: `low`, `medium`, `high`, `xhigh`, `max`, `ultra`
- `gpt-5.6-luna`
  - esforços: `low`, `medium`, `high`, `xhigh`, `max`
- `gpt-5.5`
  - esforços: `low`, `medium`, `high`, `xhigh`
- `gpt-5.4`
  - esforços: `low`, `medium`, `high`, `xhigh`
- `gpt-5.4-mini`
  - esforços: `low`, `medium`, `high`, `xhigh`
- `gpt-5.3-codex-spark`
  - esforços: `low`, `medium`, `high`, `xhigh`
- `codex-auto-review`
  - esforços: `low`, `medium`, `high`, `xhigh`

## Cursor

O Cursor Agent reporta 193 entradas. Elas correspondem às famílias abaixo,
expandidas em combinações de esforço, thinking, contexto 1M e modo `fast`.

### OpenAI/Codex

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.4-nano`
- `gpt-5.3-codex`
- `gpt-5.2`
- `gpt-5.1`
- `gpt-5-mini`

### Anthropic

- `claude-opus-5`
- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-opus-4-5`
- `claude-fable-5`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-sonnet-4-5`
- `claude-sonnet-4`

### Cursor, Grok e Composer

- `auto`
- `composer-2.5`
- `composer-2.5-fast`
- `cursor-grok-4.5`

### Google

- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3.1-pro`
- `gemini-3-flash`

### Kimi e Z.AI

- `kimi-k3`
- `kimi-k2.7-code`
- `glm-5.2`

## Grok

Catálogo nativo autenticado:

- `grok-4.5` — padrão atual

No Cursor, `cursor-grok-4.5` possui variantes `low`, `medium` e `high`, com e
sem modo `fast`.

## Qwen

Modelos Qwen configurados no Qwen Code:

- `qwen3.8-max-preview` — padrão atual
- `qwen3.7-max`
- `qwen3.7-plus`
- `qwen3.6-plus`
- `qwen3.6-flash`
- `qwen3.5-plus`
- `qwen3-coder-plus`
- `qwen3-coder-next`
- `qwen3-max-2026-01-23`

Outras opções Qwen presentes no OpenCode:

- `Qwen3.6-27B-uncensored-heretic-v2-Native-MTP-Preserved-GGUF`
- `Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-GGUF`

Essas duas últimas entradas são referências de catálogo Unsloth/GGUF; não há
arquivo de peso local instalado.

## Kimi

Provider nativo Kimi Code:

- `kimi-code/k3` — K3, contexto 1M, esforço `max`
- `kimi-code/kimi-for-coding` — K2.7 Coding, contexto 262K
- `kimi-code/kimi-for-coding-highspeed` — K2.7 Coding Highspeed, contexto 262K

Também disponíveis por Alibaba/Cursor:

- `kimi-k2.7-code`
- `kimi-k2.6`
- `kimi-k2.5`
- variantes `kimi-k3-low`, `kimi-k3-high` e `kimi-k3-max`

## Devin

Confirmado localmente:

- `swe-1-7-lightning` — modelo configurado atualmente
- `swe-1-6-fast` — alias usado anteriormente pelo papel `tiny` do OMP

A conta Devin Pro informa **170 modelos explicitamente permitidos**, mas a
versão atual da CLI não oferece um comando que enumere os 170 IDs. A ajuda da
CLI cita ainda aliases como `claude-sonnet-4`, `claude-opus-4.6`, `opus` e
`codex`; eles não devem ser tratados como uma enumeração completa do catálogo.

## Gemini

Modelos Gemini disponíveis:

- `gemini-3.6-flash`
  - Antigravity: `high`, `medium`, `low`
  - Cursor: `minimal`, `low`, `medium`, `high`
- `gemini-3.5-flash`
  - Antigravity: `high`, `medium`, `low`
  - Cursor também oferece o alias sem esforço
- `gemini-3.1-pro`
  - Antigravity: `high`, `low`
  - Cursor também oferece o alias sem esforço
- `gemini-3-flash`
- `gemini-3.5-flash`

Não há Gemini CLI standalone instalado; esses modelos são acessados pelo
Antigravity, Cursor ou OMP.

## DeepSeek

- `deepseek-chat`
- `deepseek-reasoner`
- `deepseek-v3.2`
- `deepseek-v4-flash`
- `deepseek-v4-pro`

`deepseek-v4-flash` também aparece como opção gratuita intermediada pelo
OpenCode.

## Cerebras

- `cerebras/gemma-4-31b`
- `cerebras/gpt-oss-120b`
- `cerebras/zai-glm-4.7`

## Estado da verificação

- Catálogos consultados sem envio de prompt: Codex, Cursor, Grok, Kimi, Qwen,
  Gemini/Antigravity, OpenCode/DeepSeek/Cerebras e Devin.
- O OMP 17.1.8 foi revalidado fora do sandbox e expõe 352 modelos no snapshot
  final usado pela baseline 0.5.0. Uma leitura intermediária retornou 171
  modelos; ela não deve ser usada como contagem final do catálogo.
- A disponibilidade listada significa que o modelo é exposto por pelo menos um
  CLI/provider configurado. Não significa que todos os modelos tenham recebido
  uma chamada faturável nesta coleta.
