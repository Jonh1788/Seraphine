# Fase 3c: ferramentas que escrevem, recibos e pergunta ao dono (contrato)

Contrato entre o backend e a tela para a etapa 3c do plano
(`docs/agent-harness/PLANO.md`, seção 5.4). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Apoia-se na etapa 3b (`fase-3b-porteiro-e-ponte.md`): o porteiro, a ponte, o
token do turno, o acesso por grupo e os eventos `seraphine_tool` continuam
valendo como estão. Apoia-se também na 1b (estacionar) e na 1c (caixa de
entrada).

## Por quê

Com a 3b os agentes só consultam. Para serem úteis no dia a dia precisam
também **anotar** (uma nota, uma tarefa do projeto, um lembrete) e **perguntar
ao dono** quando falta uma decisão. Tudo o que escrevem tem de ser liberado
pelo dono, aparecer com clareza e poder ser desfeito.

## Regras desta etapa

1. **Escrever só com liberação explícita.** O nível `write` ("ler e
   escrever") passa a ser aceito, grupo por grupo. Nenhum grupo nasce com
   `write`: o padrão continua `read` ou `none`.
2. **Só escritas reversíveis.** As ferramentas desta etapa criam ou alteram.
   Nenhuma apaga, cancela, envia para fora do PC ou gasta dinheiro. Essas
   ficam para a fase 4, quando as aprovações cobrirem ações que não são
   comandos.
3. **Toda escrita deixa um recibo** e pode ser desfeita pelo dono por 5
   minutos (`agents_undo_window_s`, padrão 300).
4. **A escrita vale mesmo com o agente no nível "só leitura" de arquivos:** o
   nível de arquivos (editar a pasta do projeto) e o acesso às ferramentas da
   Seraphine são coisas separadas.

## Catálogo (acréscimos à 3b)

| Grupo | Padrão | Ferramenta | Nível exigido | O que faz |
|---|---|---|---|---|
| `notes` | `read` | `create_note` | `write` | Cria uma nota do dono. |
| `notes` | | `update_note` | `write` | Altera título, texto ou etiquetas de uma nota. |
| `project_tasks` (novo) | `read` | `list_project_tasks` | `read` | Lista as tarefas do projeto em que o agente está trabalhando. |
| `project_tasks` | | `create_project_task` | `write` | Cria uma tarefa nesse projeto. |
| `project_tasks` | | `update_project_task` | `write` | Altera título, descrição, prioridade ou situação de uma tarefa desse projeto. |
| `reminders` (novo) | `none` | `list_reminders` | `read` | Lista os lembretes do dono. |
| `reminders` | | `create_reminder` | `write` | Cria um lembrete para o dono. |
| `system` | sempre | `ask_owner` | nenhum | Faz uma pergunta ao dono e espera a resposta (abaixo). |

- As ferramentas de tarefas só enxergam o projeto da execução. Um agente não
  lista nem altera tarefas de outro projeto.
- Onde já existe uma ferramenta da assistente com a mesma função (notas,
  lembretes), ela é reaproveitada.
- `GET /agents/tools` passa a trazer, em cada ferramenta, `"level": "read" | "write"`
  (o nível que ela exige) no lugar de depender só de `read_only`
  (`read_only` continua presente e vale `level == "read"`), e em cada grupo
  `"levels": ["none", "read", "write"]` com os níveis que aquele grupo aceita.
- `PUT /agents/defs/{id}/grants` aceita `write` nos grupos que têm
  ferramenta de escrita.
- Uma ferramenta de escrita só é oferecida ao agente quando o grupo está em
  `write`; com o grupo em `read`, só as de leitura são oferecidas.

## Recibos e desfazer

Cada escrita bem-sucedida grava uma **ação** com o que é preciso para
desfazê-la (o estado anterior, ou o identificador do que foi criado).

Objeto ação:

| campo | tipo | significado |
|---|---|---|
| `id` | `string` | identificador |
| `run_id`, `agent_id`, `project_id` | `string` | de onde veio |
| `tool`, `group` | `string` | qual ferramenta |
| `label` | `string` | frase em pt-BR do que foi feito ("Criou a nota «Compras»") |
| `created_at` | `string` | quando |
| `undo_until` | `string` | até quando pode ser desfeita |
| `undone_at` | `string \| null` | quando foi desfeita |
| `can_undo` | `boolean` | se desfazer seria aceito agora |

- O evento `seraphine_tool` de fim (`phase: "completed"`) de uma escrita leva
  `"action_id"` e `"undo_until"`, e `"read_only": false`.
- `POST /agents/actions/{id}/undo` (token do dono): desfaz. Uma criação é
  removida; uma alteração volta ao estado anterior. Resposta
  `{ "action": <ação> }`. Erros 409 com `code`: `undo_expired` (passou do
  prazo), `already_undone`, `undo_conflict` (o item foi alterado depois por
  outra via, então desfazer apagaria essa alteração; nada é mudado). 404
  quando não existe.
- `GET /agents/actions?run_id=<id>` (token do dono): as ações de uma execução.
- Desfazer gera, na execução de origem, um `step` com
  `{"type": "note", "reason": "action_undone", "action_id": "<id>", "text": "<pt-BR>"}`
  e um quadro novo no canal ao vivo, `{"type": "action_update", "action": <ação>}`.
- O agente não é avisado no meio do turno de que algo foi desfeito; se a
  execução ainda estiver ativa, o aviso entra na caixa de entrada dela como
  uma mensagem de sistema, entregue na próxima pausa (regra da 1c).

## Pergunta ao dono (`ask_owner`)

`ask_owner` recebe `{ "pergunta": "<texto>", "opcoes": ["…", "…"] }` (opções
opcionais, até 4).

- O porteiro publica a pergunta no canal do projeto, em nome do agente, e
  responde à ferramenta que a pergunta foi enviada e que o agente deve
  **encerrar o turno agora**, sem continuar o trabalho que depende dela.
- Ao fim desse turno, em vez de terminar, a execução fica **estacionada**
  com `wait_kind: "owner_input"` (motivo novo, ao lado dos da 1b), sem hora de
  volta. Desiste em 24 horas, como o motivo `auth`, com erro `owner_no_answer`.
- A próxima mensagem do dono para aquele agente naquele projeto entra na
  caixa de entrada (1c) e **acorda** a execução, que retoma a mesma sessão com
  a resposta. O dono também pode cancelar.
- Só uma pergunta aberta por execução; uma segunda chamada no mesmo turno
  substitui a primeira. No máximo 5 perguntas por execução (depois disso a
  ferramenta responde com erro).

Objeto execução, campo novo sempre presente: `question` (`{ "text": string, "options": string[], "asked_at": string } | null`), preenchido enquanto
a execução espera a resposta.

## Estado da ponte

`GET /agents/bridge/status` (token do dono) →
`{ "engines": [ { "engine": "codex" | "claude_code", "label": "<pt-BR>", "state": "ok" | "failed" | "unknown", "last_ok_at": string | null, "last_failure_at": string | null, "last_failure": "<pt-BR>" | null } ] }`.
`ok` quando a última vez em que a ponte foi oferecida àquele motor ela avisou
"presente"; `failed` quando a última tentativa não avisou ou o motor a
recusou; `unknown` quando nunca foi usada desde que o backend subiu.

`POST /agents/bridge/test`, corpo `{ "engine": "codex" | "claude_code" }`
(token do dono): roda um turno mínimo e real daquele motor, numa pasta
temporária criada para o teste, pedindo só que chame `ping`, e responde
`{ "ok": boolean, "detail": "<pt-BR>", "took_ms": number }`. Usa a cota do
plano do dono (um turno curto); no máximo um teste por vez (409 `test_running`).
Limite de 60 segundos.

## Eventos (resumo dos novos)

- `seraphine_tool` de escrita: `read_only: false`, `action_id`, `undo_until`.
- `step` nota com `reason: "action_undone"`.
- `step` nota com `reason: "asked_owner"` quando a pergunta é publicada.
- `status` `parked` com `wait_kind: "owner_input"`.
- Quadro `action_update` no canal ao vivo.

## Códigos novos

Execução: erro `owner_no_answer`. Desfazer: `undo_expired`, `already_undone`,
`undo_conflict`. Teste da ponte: `test_running`.

## Configuração nova (backend)

`agents_undo_window_s` (300), `agents_owner_answer_max_s` (86400),
`agents_bridge_test_timeout_s` (60).
