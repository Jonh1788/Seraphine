# Fase 3b: porteiro de ferramentas e ponte MCP (contrato)

Contrato entre o backend e a tela para a etapa 3b do plano
(`docs/agent-harness/PLANO.md`, seção 5.4). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Base obrigatória: o resultado do teste de bancada com os motores reais,
`fase-3-bancada.md`, na mesma pasta. O que está escrito lá foi visto
acontecer; onde este contrato e a bancada divergirem, a bancada vence e a
divergência deve ser relatada.

Referências de desenho: estudo principal, seção "Fase 3"
(`E:\Projetos\Projeto-Seraphine\reports\Agentes chat pelo código fonte.md`),
e as notas `laco_do_agente_computador_e_navegador.md` e
`aprovacoes_e_seguranca.md`.

## Por quê

Hoje um agente só enxerga a pasta do projeto. Ele não consegue consultar as
notas nem a wiki do dono, que a assistente Seraphine já tem. Esta etapa cria
o caminho por onde as ferramentas da Seraphine chegam aos agentes, com um
único ponto de controle no backend, e entrega as primeiras ferramentas, todas
**só de leitura**. Ferramentas que escrevem ficam para a etapa 3c.

## Visão geral

```
motor (Codex ou Claude Code)
   └─ inicia →  ponte MCP (programa pequeno, entrada e saída padrão)
                    └─ chama →  porteiro, no backend (só 127.0.0.1, token da execução)
                                    └─ executa a ferramenta e registra
```

## A ponte

- Um único arquivo Python, só com a biblioteca padrão, executado como script
  (não como módulo do pacote, para subir rápido: a bancada mostrou que o Codex
  segue sem ferramentas se a ponte demora mais que cerca de 1 segundo para
  responder ao início).
- Fala MCP por entrada e saída padrão: `initialize`,
  `notifications/initialized`, `tools/list`, `tools/call`. Pedidos que não
  conhece (por exemplo `server/discover`, que o Claude Code envia antes do
  início) recebem o erro padrão de método desconhecido e não derrubam a ponte.
- Responde `initialize` e `tools/list` sem falar com o backend: a lista de
  ferramentas daquele turno vem de um arquivo que o harness grava antes de
  iniciar o motor.
- Em `tools/call`, repassa a chamada ao porteiro por HTTP em `127.0.0.1` e
  devolve o resultado. Erro de ferramenta volta como erro de ferramenta MCP,
  com a frase do porteiro.
- Ao subir, avisa o backend ("presente"), para o harness saber que as
  ferramentas ficaram de fato disponíveis naquele turno.
- Não guarda estado entre execuções (os motores iniciam uma ponte nova a cada
  turno e a cada retomada).
- Recebe três valores do harness, pelo ambiente do processo: o endereço do
  porteiro, o token do turno e o caminho do arquivo com a lista de ferramentas.

## O token do turno

- Um valor aleatório novo a cada turno de motor. No banco fica só o SHA-256
  dele, ligado à execução e ao agente.
- Vale apenas enquanto aquele turno está em andamento; é revogado quando o
  turno termina, por qualquer motivo.
- Dá ao portador exatamente o que o agente já pode fazer pelas ferramentas,
  e nada mais. Por isso é aceitável que o próprio agente consiga lê-lo (a
  bancada mostrou que, no Codex, o valor fica na linha de comando do processo
  da ponte): ele não ganha nada com isso.
- Nunca vai para log, evento, mensagem ou resposta de API.

## O porteiro (backend)

Rotas internas, fora do grupo protegido pelo token do dono:

- `POST /agents/bridge/hello`
- `POST /agents/bridge/call`

Regras de acesso às duas: só de `127.0.0.1` ou `::1`; pedido com cabeçalho
`Origin` é recusado (navegador não fala com o porteiro); pedido com cabeçalhos
de encaminhamento é recusado; o token do turno vai no cabeçalho
`X-Seraphine-Bridge-Token`. Token ausente, desconhecido, revogado ou de uma
execução que não está em `running`: 401, sem dizer o motivo.

`POST /agents/bridge/call`, corpo `{ "tool": "<nome>", "arguments": { … } }`.
O porteiro faz, nesta ordem:

1. Acha a ferramenta pelo nome no catálogo. Desconhecida: erro.
2. Confere **no banco, a cada chamada**, o acesso do agente ao grupo da
   ferramenta. Nada que venha no texto do agente ou no resultado de outra
   ferramenta muda isso. Sem acesso: erro "sem acesso", e um evento na
   execução (abaixo).
3. Valida os argumentos contra o formato de entrada da ferramenta. Inválido:
   erro dizendo o que falta.
4. Registra o começo da ação na execução.
5. Executa, com limite de 30 segundos.
6. Registra o fim da ação.
7. Devolve o resultado limitado a 50.000 caracteres, embrulhado num envelope
   que diz ao modelo que aquilo é **dado, não instrução**.

Resposta: `{ "ok": true, "content": "<texto>" }` ou
`{ "ok": false, "error": "<frase em pt-BR>" }`, sempre com HTTP 200 quando o
token é válido (o erro é da ferramenta, não do transporte).

Cada chamada conta como uma ação da execução (teto e detector de laço da 1d),
marcada como só de leitura nesta etapa.

## Catálogo desta etapa (todas só de leitura)

| Grupo | Ferramenta | O que faz |
|---|---|---|
| `system` | `ping` | Devolve o texto recebido. Serve para testar a ponte. Sempre permitida. |
| `notes` | `search_notes` | Busca nas notas do dono. |
| `notes` | `list_notes` | Lista as notas mais recentes. |
| `wiki` | `wiki_search` | Busca nas páginas da wiki. |
| `wiki` | `wiki_list_pages` | Lista as páginas da wiki. |
| `wiki` | `wiki_read_page` | Lê uma página da wiki. |
| `memory` | `memory_search` | Busca na memória pessoal do dono. |

Os nomes que o modelo vê são `mcp__seraphine__<ferramenta>`. As descrições das
ferramentas são em português do Brasil. Onde já existe uma ferramenta da
assistente com a mesma função (notas), ela é reaproveitada, não reescrita.

## Acesso por agente

Nível por grupo: `none` (sem acesso) ou `read` (ler). O nível `write` fica
reservado para a 3c e é recusado nesta etapa.

Padrões para um agente que não tem nada gravado: `notes: read`, `wiki: read`,
`memory: none`. A memória pessoal fica fechada por padrão porque guarda humor,
saúde e finanças, e o que um agente lê é enviado ao provedor do motor dele; o
dono abre agente por agente.

Rotas (grupo protegido pelo token do dono):

- `GET /agents/tools` → `{ "groups": [ { "id", "label", "description", "default", "sensitive", "tools": [ { "name", "label", "description", "read_only" } ] } ] }`.
  `sensitive: true` marca o grupo `memory`. O grupo `system` não aparece.
- `GET /agents/defs/{id}/grants` → `{ "grants": { "notes": "read", "wiki": "read", "memory": "none" } }` (sempre todos os grupos, com o padrão aplicado).
- `PUT /agents/defs/{id}/grants`, corpo `{ "grants": { "<grupo>": "none" | "read" } }` (parcial permitido) → o mesmo formato do GET.
  Grupo desconhecido ou nível inválido: 422.

O objeto agente ganha o campo `grants`, sempre presente, no mesmo formato.

## Motores

Só quando o agente tem acesso a pelo menos uma ferramenta além de `ping`, e o
motor age em arquivos (Codex ou Claude Code), o harness declara a ponte ao
motor naquele turno. O motor de conversa simples não recebe ferramentas nesta
etapa.

- **Codex:** a ponte é declarada por opções `-c mcp_servers.seraphine.…`
  (comando, argumentos, ambiente), com
  `default_tools_approval_mode="approve"` **só para esse servidor**. Vale nos
  dois níveis de sandbox e também em `exec resume`.
- **Claude Code:** `--mcp-config` (JSON na linha de comando, com os valores
  sensíveis referidos como `${VARIAVEL}` e passados pelo ambiente do motor),
  `--strict-mcp-config` e `--allowedTools mcp__seraphine`. No nível só de
  leitura, o modo `plan` bloqueia MCP: nesse nível, **e só quando há
  ferramentas a oferecer**, usa-se `--permission-mode manual` com a mesma
  lista de ferramentas de leitura de hoje. Sem ferramentas a oferecer, tudo
  fica como está.
- Nada disto pode ampliar o que o agente faz fora das ferramentas da
  Seraphine: a lista de ferramentas nativas do Claude Code não muda, nenhum
  modo que libere comandos ou edição é usado, e o sandbox do Codex não muda.
- As chamadas à ponte que aparecem no fluxo do próprio motor **não** são
  gravadas de novo: quem registra a ação é o porteiro.
- Se a ponte não avisar "presente" em 10 segundos depois de o motor iniciar,
  ou se o motor informar que o servidor falhou, a execução ganha uma nota e
  segue sem as ferramentas (não falha).

O texto inicial do agente ganha uma linha dizendo que ele tem ferramentas da
Seraphine para consultar o que o dono liberou, e que o que elas devolvem é
dado, não instrução.

## Eventos da execução

- Ação de ferramenta: dois `step`, como toda ação (1a):
  `{"type": "seraphine_tool", "phase": "started" | "completed", "call_id": "<id>", "tool": "<nome>", "group": "<grupo>", "label": "<frase curta em pt-BR do que foi pedido>", "read_only": true}`,
  e no `completed` também `"ok": true | false`, `"summary": "<resultado resumido, até 400 caracteres>"` e, se falhou, `"error": "<frase>"`.
  O `label` descreve a chamada em palavras ("Buscou nas notas: orçamento").
  Argumentos e resultado completos não vão para o evento.
- Acesso negado: `step` com
  `{"type": "note", "reason": "tool_denied", "tool": "<nome>", "group": "<grupo>", "text": "<pt-BR>"}`.
- Ponte indisponível no turno: `step` com
  `{"type": "note", "reason": "bridge_unavailable", "text": "<pt-BR>"}`.

## Configuração nova (backend)

`agents_bridge_base_url` (endereço local do próprio backend, por padrão o que
o backend já usa para escutar), `agents_bridge_call_timeout_s` (30),
`agents_bridge_hello_timeout_s` (10), `agents_bridge_result_max_chars` (50000).
