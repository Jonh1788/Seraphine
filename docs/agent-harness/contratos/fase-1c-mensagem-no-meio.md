# Fase 1c: mensagem no meio do trabalho, parar e continuar (contrato)

Contrato entre o backend e a tela para a etapa 1c do plano
(`docs/agent-harness/PLANO.md`). Backend e tela são implementados ao mesmo
tempo por pessoas diferentes, então nenhum dos lados pode se desviar daqui.
Se algo for impossível, parar e relatar em vez de inventar uma variante.

Referências de desenho: estudo principal, seção "Fase 1"
(`E:\Projetos\Projeto-Seraphine\reports\Agentes chat pelo código fonte.md`),
e as notas `execucoes_e_fila.md` e `conversa_e_colaboracao.md`.
Esta etapa se apoia na 1a e na 1b (contratos na mesma pasta).

## Por quê

Hoje, se o dono manda outra mensagem ao mesmo agente enquanto ele trabalha, a
mensagem vira uma execução nova que espera na fila e começa sem contexto. E
várias mensagens em sequência viram vários pedidos. O que se quer: a mensagem
nova **se junta** ao trabalho em curso; o dono pode também **parar e mandar**;
uma rajada de mensagens vira um pedido só; e parar um trabalho guarda o que já
foi escrito e deixa continuar depois.

## Limite dos motores (o que isto pode e não pode fazer)

Os motores da Seraphine rodam um turno por vez, como um processo de linha de
comando. Não dá para injetar texto num turno em andamento. Por isso:

- **Juntar** entrega a mensagem na **próxima pausa** do agente: quando o turno
  atual termina, o harness retoma a mesma sessão com as mensagens que
  chegaram, em vez de encerrar a execução.
- **Parar e mandar** encerra o turno atual (o processo do motor é encerrado) e
  retoma a sessão na hora com a mensagem nova.

## Caixa de entrada da execução

Cada execução ativa tem uma caixa de entrada: mensagens do dono que chegaram
para aquele agente, naquele projeto, enquanto a execução existia.

- Uma mensagem do dono para um agente que tem execução ativa **no mesmo
  projeto** (`queued`, `running`, `waiting_approval` ou `parked`) não cria
  execução nova: entra na caixa de entrada dessa execução.
- Agente ocupado em **outro** projeto: continua como hoje (execução nova, que
  espera a vez).
- Entrega: sempre numa fronteira de turno. Ao fim de um turno com mensagens
  na caixa, a execução não termina: a sessão é retomada com as mensagens, na
  ordem em que chegaram, num único aviso. Se a execução estava esperando uma
  aprovação ou estacionada, as mensagens são entregues junto com a decisão ou
  com a volta.
- Se o turno termina pedindo aprovação e há mensagens na caixa, o pedido de
  aprovação vale e as mensagens esperam a decisão.
- Uma execução que termina (`done`, `failed`, `cancelled`) com mensagens ainda
  na caixa não as perde em silêncio: elas ficam marcadas como não entregues e
  aparecem assim na tela.
- Limite: 20 mensagens pendentes por execução; acima disso o envio é recusado
  com 409 `inbox_full`.

## Rajada: janela de silêncio

Quando uma mensagem cria uma execução nova, o motor só começa depois de
`agents_quiet_window_s` (padrão 2,5 s) sem mensagem nova para aquele agente
naquele projeto. Cada mensagem que chega nesse intervalo se junta ao pedido e
reinicia a janela, no máximo 4 vezes (até 12,5 s no total com o padrão: a
janela inicial mais quatro reinícios). As
mensagens da rajada são entregues juntas no primeiro turno, como um pedido só.
Com `agents_quiet_window_s = 0` não há espera.

Execuções criadas por tarefa, pela assistente ou por "continuar" não esperam a
janela.

## Enviar mensagem

`POST /agents/projects/{id}/messages` ganha um campo opcional no corpo:

```json
{ "body": "…", "agent_id": "auto" | "<id>", "mode": "join" | "interrupt" }
```

- `mode` só importa quando o agente escolhido tem execução ativa no projeto.
  Padrão: `join`.
- `interrupt` ("Parar e mandar"): válido só se a execução está `running`. O
  turno atual é encerrado, a mensagem (e o que mais houver na caixa) é
  entregue na hora, retomando a sessão. Se uma ação estava aberta no momento
  (definição da 1a), o aviso ao agente diz qual foi e que ela pode ter ficado
  pela metade, para ele conferir antes de seguir. Em outro estado, `interrupt`
  se comporta como `join`.

Resposta (campos atuais permanecem):

| campo | tipo | significado |
|---|---|---|
| `run` | execução ou `null` | a execução que vai tratar a mensagem (a nova, ou a que já existia) |
| `joined` | `boolean` | `true` quando a mensagem entrou na caixa de uma execução que já existia |
| `interrupted` | `boolean` | `true` quando o turno em curso foi encerrado para entregar a mensagem |

## Objeto mensagem: campo novo, sempre presente

| campo | tipo | significado |
|---|---|---|
| `delivery` | `"pending" \| "delivered" \| "undelivered" \| null` | só para mensagens do dono ligadas a uma execução: `pending` (o agente lê na próxima pausa), `delivered` (entregue ao agente), `undelivered` (a execução acabou antes). `null` para as demais |

Mensagens que entram numa caixa de entrada passam a ter `run_id` da execução.

## Objeto execução: campo novo, sempre presente

| campo | tipo | significado |
|---|---|---|
| `inbox_count` | `number` | quantas mensagens esperam entrega nesta execução |

## Parar

O cancelamento existente (`POST /agents/runs/{id}/cancel`) passa a:

- publicar no canal, em nome do agente, uma mensagem dizendo que o trabalho foi
  parado pelo dono, com até onde ele tinha chegado (o último texto escrito
  naquela execução, limitado a 2.000 caracteres), quando houver;
- se uma ação estava aberta, dizer na mesma mensagem que ela pode ter ficado
  pela metade.

`can_continue` já é `true` para execução cancelada (1a). Continuar uma
execução parada entrega também as mensagens que ficaram não entregues na
caixa dela.

## Eventos

- `step` com `{"type": "note", "reason": "inbox", "text": "<pt-BR>", "count": <n>}`
  quando mensagens são entregues ao agente ("Leu 2 mensagens novas").
- `step` com `{"type": "note", "reason": "interrupted_by_owner", "text": "<pt-BR>"}`
  quando o turno é encerrado por "Parar e mandar".
- Quadro novo no canal ao vivo, `{"type": "message_update", "message": <mensagem>}`,
  quando o `delivery` de uma mensagem muda.
- O quadro `run_update` carrega `inbox_count`.

## Códigos novos

409 no envio de mensagem: `inbox_full`.

## Configuração nova (backend)

`agents_quiet_window_s` (2.5), `agents_quiet_window_max` (4),
`agents_inbox_max` (20).
