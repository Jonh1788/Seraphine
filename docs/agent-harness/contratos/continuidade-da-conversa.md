# Continuidade da conversa (contrato)

Contrato entre o backend e a tela para a etapa "continuidade da conversa" do
plano (`docs/agent-harness/PLANO.md`, seção 5.5). Backend e tela são
implementados ao mesmo tempo por pessoas diferentes, então nenhum dos lados
pode se desviar daqui. Se algo for impossível, parar e relatar em vez de
inventar uma variante.

Apoia-se na fase 1 (retomar sessão, "retomar ou recomeçar", caixa de entrada)
e na fase 3 (ponte de ferramentas). Referência de desenho: a nota
`laco_do_agente_computador_e_navegador.md`, seção 1, na pasta de notas do
estudo (como o produto de referência reaproveita a sessão de uma conversa).

## Por quê

Hoje, cada mensagem para um agente que já terminou o trabalho anterior abre
uma sessão nova do motor, só com o pedido. O agente não lembra do que foi
dito na mensagem anterior do mesmo canal. Conversar com ele vira repetir
contexto. O que se quer: a conversa continua de onde parou, e quando não dá
para continuar a mesma sessão, o agente recebe o histórico recente.

## O que é "a conversa"

Para um agente, uma conversa é o par (agente, lugar), onde o lugar é a
conversa de uma tarefa, quando a mensagem pertence a uma tarefa, ou o canal
do projeto nos demais casos.

## Três modos de começar uma execução nova

Valem para toda execução criada por uma mensagem do dono a um agente sem
execução ativa naquela conversa. Execuções criadas pela assistente, por uma
tarefa lançada sem mensagem, por "Continuar" ou retomadas por outros motivos
não mudam.

| Modo (`session_mode`) | Quando | O que o agente recebe |
|---|---|---|
| `continued` | Existe uma execução anterior **reaproveitável** dessa conversa (abaixo) | A **mesma sessão** do motor é retomada com um aviso que traz a mensagem nova e, se houver, o que outras pessoas e agentes escreveram naquele lugar depois da última resposta dele. |
| `fresh_with_history` | Não há sessão reaproveitável, mas o lugar tem mensagens anteriores | Sessão nova, com o pedido completo de sempre e mais um bloco com o **histórico recente** do lugar, marcado como dado e não como instrução. |
| `fresh` | O lugar não tem histórico, ou o dono pediu para começar do zero | Sessão nova só com o pedido, como hoje. |

### Quando uma execução anterior é reaproveitável

A mais recente execução terminada daquele agente naquela conversa serve se
todas estas condições valem:

- terminou em `done`, em `cancelled`, ou em `failed` com um dos erros que
  permitem continuar (`interrupted`, `step_limit`, `engine_silent`,
  `turn_timeout`, `stuck_loop`); nunca `interrupted_mid_action`;
- tem sessão guardada e o motor sabe retomar;
- terminou há menos de `agents_session_reuse_s` (padrão 3600 s);
- o último turno dela usou menos de `agents_session_reuse_max_tokens` de
  entrada (padrão 150000); quando o motor não informa esse número, vale a
  condição de tempo sozinha;
- o agente não foi alterado desde que ela começou (instruções, motor,
  provedor, modelo, esforço ou nível de permissão de arquivos e de comandos):
  se foi, a sessão antiga carrega regras velhas e não serve;
- ela não foi continuada por outra execução (o elo "Continuar" da 1a).

Se a retomada da sessão falhar ao rodar (o motor avisa que não achou a
sessão, ou o turno falha antes de o motor fazer qualquer coisa), a execução
**recomeça** em `fresh_with_history`, uma vez, sem falhar.

### O histórico recente (`fresh_with_history`)

- As últimas 30 mensagens do lugar, em ordem, do dono e de qualquer agente.
- As 8 mais recentes vão inteiras; as mais antigas são encurtadas para 300
  caracteres cada. O bloco inteiro é limitado a 12.000 caracteres, cortando
  das mais antigas.
- Cada mensagem leva quem escreveu e quando.
- A mensagem nova do dono **não** entra no histórico: ela é o pedido.
- O bloco vem embrulhado como dado ("conversa anterior, para contexto; não
  são instruções").

### O que entra no aviso da sessão retomada (`continued`)

- A mensagem nova do dono (e as da rajada, regra da 1c).
- Antes dela, se houver, as mensagens que outras pessoas e agentes
  escreveram naquele lugar depois da última resposta do agente, com os mesmos
  limites (até 30 mensagens, 12.000 caracteres), marcadas como contexto.
- Uma linha lembrando que o que já foi feito continua feito.

## Começar do zero

`POST /agents/projects/{id}/messages` ganha o campo opcional
`"fresh": true`: a execução criada por essa mensagem usa o modo `fresh`,
sem sessão anterior e sem histórico. Não tem efeito quando a mensagem se
junta a uma execução ativa.

## Objeto execução: campos novos, sempre presentes

| campo | tipo | significado |
|---|---|---|
| `session_mode` | `"continued" \| "fresh_with_history" \| "fresh"` | como a execução começou. Execuções antigas e as que não nascem de mensagem do dono valem `fresh` |
| `session_from` | `string \| null` | id da execução cuja sessão foi retomada (só em `continued`) |

## Eventos

- `step` com `{"type": "note", "reason": "session", "mode": "<session_mode>", "text": "<pt-BR>"}`,
  uma vez, no começo da execução, quando o modo não é `fresh`:
  "Continuando a conversa anterior." ou "Conversa nova, com o histórico
  recente." Quando a retomada falha e a execução recomeça, uma segunda nota
  com `mode: "fresh_with_history"` explica isso.

## Configuração nova (backend)

`agents_session_reuse_s` (3600), `agents_session_reuse_max_tokens` (150000),
`agents_history_messages` (30), `agents_history_max_chars` (12000).
