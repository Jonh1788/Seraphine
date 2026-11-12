# Fase 1a: recuperação após reinício (contrato)

Contrato entre o backend e a tela para a etapa 1a do plano
(`docs/agent-harness/PLANO.md`). Backend e tela são implementados ao mesmo
tempo por pessoas diferentes, então nenhum dos lados pode se desviar daqui.
Se algo for impossível, parar e relatar em vez de inventar uma variante.

Referências de desenho: estudo principal, seção "Fase 1"
(`E:\Projetos\Projeto-Seraphine\reports\Agentes chat pelo código fonte.md`) e
a nota `execucoes_e_fila.md` na pasta de notas do estudo.

## Por quê

Hoje, se o backend reinicia ou cai enquanto um agente trabalha, a execução é
marcada como falha e pronto. Pior: no Windows o processo do motor (Codex ou
Claude Code) pode continuar vivo, órfão, mexendo nos arquivos sem ninguém ver.
Esta etapa faz o trabalho sobreviver a um reinício quando isso é seguro, e
parar com clareza quando não é.

## Regras

### 1. Nenhum motor sobrevive ao backend

Todo processo de motor e todo comando aprovado é iniciado preso ao processo do
backend, de modo que o sistema operacional o encerra quando o backend termina,
mesmo se o backend for morto à força. No Windows isso é um Job Object com
encerramento ao fechar. Como segunda garantia, a execução guarda o
identificador do processo do motor e o instante em que ele foi criado; no
arranque, se esse processo ainda existir e for o mesmo (mesmo instante de
criação), a árvore dele é encerrada antes de qualquer decisão.

### 2. A sessão do motor é guardada assim que é conhecida

Os motores avisam o identificador da sessão no começo do turno. O harness o
grava na execução nesse momento, e não só no fim do turno. Sem isso não há
como retomar.

### 3. Toda ação tem começo e fim registrados

Uma "ação" é qualquer coisa que o motor faz além de pensar e escrever: rodar
comando, alterar arquivo, chamar ferramenta. Cada ação vira dois eventos
`step` da execução, ligados por um identificador:

```json
{ "type": "<o tipo que o evento já tem hoje>", "phase": "started",   "call_id": "<id>", ... }
{ "type": "<o mesmo tipo>",                   "phase": "completed", "call_id": "<id>", ... }
```

- Quando o motor só informa o fim de uma ação (sem aviso de começo), grava-se
  um único evento com `"phase": "completed"`.
- Eventos `step` que não são ações (notas, raciocínio) não levam `phase`.
- O comando aprovado que o próprio harness executa segue a mesma regra: um
  `step` com `"type": "command"`, `"phase": "started"` e
  `"call_id": "<id da aprovação>"` antes de rodar; o evento `command` que já
  existe hoje conta como o fim (ele já leva `approval_id`).
- Todo evento `command` (do agente ou do harness) leva `"phase": "completed"`
  e o `call_id` da ação que ele encerra. No comando do harness, `call_id` e
  `approval_id` são iguais. Quem lê os eventos fecha a ação por
  `call_id`, ou por `approval_id` quando não há `call_id`.
- **Ação aberta** = um `started` sem `completed` (nem evento `command`)
  correspondente.

### 4. No arranque, três caminhos para cada execução que ficou "rodando"

Depois de garantir que não há motor órfão (regra 1), para cada execução com
estado `running`:

| Situação | O que acontece |
|---|---|
| **Há ação aberta** | Estado `failed`, erro `interrupted_mid_action`. Não é retomada nem pode ser continuada: uma ação pode ter parado no meio. Se a ação aberta era um comando aprovado, a saída da aprovação recebe um texto dizendo que o comando pode ter rodado em parte. |
| **Sem ação aberta**, com sessão guardada, motor que sabe retomar, menos de `agents_recovery_max` retomadas anteriores (padrão 2) e iniciada há menos de `agents_recovery_max_age_s` (padrão 21600 s) | Volta para `queued` e é retomada sozinha na mesma sessão, com um aviso ao agente de que o sistema reiniciou, que o que já foi feito continua feito e que não deve repetir ações concluídas. O contador `recoveries` sobe em 1. |
| **Qualquer outro caso** | Estado `failed`, erro `interrupted`. Pode ser continuada pelo dono (regra 6). |

**Retomar ou recomeçar (achado no teste ao vivo de 11/11/2026).** Ter o
identificador da sessão não prova que a sessão guarda a tarefa: se o backend
cai logo depois de a sessão nascer, o motor ainda não gravou o pedido nela, e
retomar essa sessão devolve um agente sem objetivo e sem as instruções. Por
isso, no segundo caminho:

- Se o motor produziu ao menos um evento próprio no turno interrompido
  (mensagem, passo ou comando depois do último `status: running`), a sessão é
  **retomada**, e o aviso de retomada repete o objetivo da execução.
- Se não produziu nenhum, e era o primeiro turno da execução, o turno
  **recomeça do zero** com o pedido completo (sessão nova, `session_ref`
  antigo apagado), precedido de uma linha dizendo que o sistema reiniciou antes
  de o agente começar. Conta como retomada (`recoveries` + 1) e respeita os
  mesmos limites.
- Em turnos posteriores (por exemplo, depois de uma aprovação entregue), a
  sessão com certeza guarda o contexto, então é retomada.

Em todos os casos o canal do projeto recebe uma mensagem em português claro,
em nome do agente, dizendo o que aconteceu. Nos dois casos de falha, a
mensagem inclui até onde o agente tinha chegado (o último texto que ele
escreveu naquela execução, limitado a 2.000 caracteres), quando houver.

Execuções `queued` e `waiting_approval` não são afetadas por um reinício
(já é assim hoje).

### 5. Desligamento em duas fases

Ao parar o serviço: (1) deixa de iniciar execuções novas; (2) espera até
`agents_shutdown_drain_s` (padrão 20 s) as execuções em andamento terminarem o
turno; (3) encerra os motores que restarem. Uma execução cortada no passo 3
**não** é marcada como falha nesse momento: ela fica `running` e o próximo
arranque decide pela regra 4.

### 6. Continuar

`POST /agents/runs/{id}/continue` (sem corpo) cria uma **execução nova** que
dá seguimento à antiga: mesmo agente, projeto, tarefa e objetivo.

- Permitido quando a execução antiga está `cancelled`, ou `failed` com erro
  `interrupted`, e ainda não foi continuada.
- Se a antiga tem sessão guardada e o motor sabe retomar, a nova retoma essa
  sessão com um aviso de continuação; senão, começa do zero com o mesmo
  objetivo e uma nota de que é uma segunda tentativa.
- Resposta: `{ "run": <execução nova> }`.
- Erros 409 com `code`: `continue_not_allowed` (estado ou erro não permite,
  inclusive `interrupted_mid_action`), `already_continued`, e `agent_busy`
  (o agente tem outra execução na fila, rodando ou esperando).
- O aviso de continuação também repete o objetivo da execução.
- 404 quando a execução não existe.

## Objeto execução (em todo lugar onde uma execução é devolvida)

Campos atuais permanecem. Campos novos, sempre presentes:

| campo | tipo | significado |
|---|---|---|
| `recoveries` | `number` | quantas vezes foi retomada sozinha após reinício |
| `can_continue` | `boolean` | se `POST …/continue` seria aceito agora (sem considerar agente ocupado) |
| `continued_from` | `string \| null` | id da execução que esta continua |
| `continued_by` | `string \| null` | id da execução que continuou esta |

Estados de execução não mudam: `queued`, `running`, `waiting_approval`,
`done`, `failed`, `cancelled`.

Códigos de erro de execução novos: `interrupted_mid_action`. O código
`interrupted` continua existindo, agora só para o terceiro caminho da regra 4.

## Eventos

- `status` com `{"status": "queued", "reason": "recovered", "recoveries": <n>}`
  quando uma execução é retomada sozinha.
- `step` com `{"type": "note", "text": "<pt-BR>"}` descrevendo a retomada ou a
  interrupção (já é o formato das notas de hoje). A nota de retomada automática
  leva também `"reason": "recovered"` e o texto "Retomada depois de um reinício
  (1ª vez)." ou "Recomeçou depois de um reinício (1ª vez)."; a tela a mostra
  uma vez só, como linha discreta de sistema.
- Eventos `step` de ação ganham `phase` e `call_id` (regra 3). A tela deve
  mostrar uma ação uma vez só: o par `started`/`completed` é a mesma linha,
  que passa de "em andamento" para "feita".
- O quadro `run_update` do canal ao vivo carrega os campos novos da execução.

## Configuração nova (backend)

`agents_shutdown_drain_s` (20), `agents_recovery_max` (2),
`agents_recovery_max_age_s` (21600).
