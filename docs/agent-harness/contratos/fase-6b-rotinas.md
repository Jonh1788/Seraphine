# Fase 6b: rotinas dos agentes (contrato)

Contrato entre o backend e a tela para a etapa 6b do plano
(`docs/agent-harness/PLANO.md`, seção 5.6). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Apoia-se na etapa 6a (`fase-6a-primeiros-passos-e-times.md`: casa do agente,
rascunho de agente, times prontos, proposta pela conversa), na continuidade
da conversa e nas fases 1 e 3. Referências: `COMPARACAO.md`, área 10; notas
`agentes_memoria_rotinas_conectores.md` (seção 5) e
`onboarding_e_criacao_guiada.md` na pasta de notas do estudo; captura
`07-os-seus-agentes-pacotes-e-rotinas.png` do dono.

## Por quê

Hoje um agente só trabalha quando o dono escreve para ele. O que se quer: o
dono combina uma vez ("todo dia útil às 8h, liste o que está pendente") e o
agente faz sozinho no horário, relatando na conversa dele.

## Regras desta etapa

1. **Uma rotina é um pedido guardado, de um agente, com um horário.** No
   horário, a Seraphine começa uma execução desse agente com esse pedido, na
   conversa própria dele (a casa), e o relato aparece ali.
2. **Segurança igual à de qualquer execução.** Uma rotina age com as
   permissões do agente: todo comando continua pedindo aprovação (a execução
   espera, como hoje), o acesso às ferramentas da Seraphine é o do agente.
   Nenhuma permissão nova nasce de uma rotina.
3. **Horário local deste PC.** Não há fuso por rotina.
4. **Uma execução por vez por rotina.** Se a anterior ainda não terminou, o
   horário seguinte é registrado como pulado.
5. **PC desligado ou dormindo:** ao voltar, a rotina roda **uma vez** se o
   horário perdido tem menos de 12 horas; horários mais antigos são
   registrados como perdidos. Nunca roda todos os horários perdidos em fila.
6. **Limites:** intervalo mínimo de 15 minutos entre horários; no máximo 20
   rotinas ativas por agente; título até 120 caracteres; pedido de 1 a 2.000.
7. **Pausa por falhas:** na 5ª falha seguida a rotina é pausada, com um aviso
   único na conversa do agente.
8. **Relato "só com novidade" (padrão):** o agente é instruído a responder
   apenas `SEM_NOVIDADE` quando não há nada novo; nesse caso nada é publicado
   na conversa e a execução fica registrada como "sem novidade".
9. **Só o dono cria, muda e apaga rotinas** (pela tela, por um time pronto ou
   aceitando uma proposta). Nesta etapa os agentes não têm ferramenta de
   rotinas.
10. **O texto que o modelo devolve** (na proposta de time e no rascunho de
    rotina por frase) é dado: é validado campo a campo e nada é criado sem um
    clique do dono.

## 1. Horário (`schedule`)

Objeto, com `kind` e os campos daquele tipo. Horas em `"HH:MM"` (24 h, local).

| `kind` | campos | significado |
|---|---|---|
| `daily` | `time` | todo dia |
| `weekdays` | `time` | de segunda a sexta |
| `weekly` | `time`, `days` (lista de 1 a 7 inteiros, 0 = segunda … 6 = domingo, sem repetição) | nos dias da semana escolhidos |
| `monthly` | `time`, `day` (1 a 28, ou `"last"`) | uma vez por mês |
| `interval` | `every_minutes` (15 a 1440) | de tanto em tanto tempo, a contar da criação ou da última mudança |
| `once` | `at` (data e hora ISO, no futuro ao criar) | uma vez só; depois de rodar, a rotina se desliga |

Qualquer outro campo ou valor: 422 com a frase em pt-BR. O backend também
devolve `schedule_text`, a frase em pt-BR daquele horário ("Todo dia útil às
08:00", "Toda segunda e quinta às 19:30", "Todo dia 5 às 09:00", "A cada 30
minutos", "Uma vez, em 14/11 às 10:00").

## 2. Objeto rotina

| campo | tipo | significado |
|---|---|---|
| `id` | `string` | identificador |
| `agent_id` | `string` | de quem é |
| `project_id` | `string` | onde roda e relata: a casa do agente (o backend garante a casa ao criar) |
| `title` | `string` | 1 a 120 |
| `prompt` | `string` | 1 a 2.000: o pedido |
| `schedule` | objeto | seção 1 |
| `schedule_text` | `string` | frase em pt-BR |
| `report` | `"news" \| "always"` | "só com novidade" (padrão) ou "sempre" |
| `enabled` | `boolean` | ligada |
| `paused_reason` | `"failures" \| null` | preenchido quando a pausa veio de falhas seguidas |
| `next_run_at` | `string \| null` | próximo horário (ISO, UTC); `null` quando desligada |
| `upcoming` | `string[]` | os próximos 3 horários (ISO, UTC); vazio quando desligada |
| `last_run_at` | `string \| null` | quando rodou pela última vez |
| `last_status` | `string \| null` | estado final da última (seção 3) |
| `consecutive_failures` | `number` | falhas seguidas |
| `week` | `{ "ok": number, "total": number }` | nos últimos 7 dias: quantas terminaram bem (`reported` ou `quiet`) e quantas tiveram horário |
| `running` | `boolean` | há uma execução dela em andamento |
| `origin` | `string` | `"manual"`, `"pack:<id>"`, `"guide"` ou `"copy"` |
| `created_at`, `updated_at` | `string` | datas |

## 3. Livro das execuções da rotina

Cada horário de uma rotina vira no máximo uma linha (`rotina` + `horário`
são únicos). Objeto:

| campo | tipo | significado |
|---|---|---|
| `id` | `string` | identificador |
| `routine_id` | `string` | a rotina |
| `scheduled_for` | `string` | o horário (ISO, UTC) |
| `trigger` | `"schedule" \| "manual" \| "catchup"` | no horário, "Rodar agora", ou ao voltar de um período desligado |
| `status` | `"running" \| "reported" \| "quiet" \| "failed" \| "cancelled" \| "skipped" \| "missed"` | um só estado final |
| `run_id` | `string \| null` | a execução do agente, quando houve |
| `detail` | `string` | frase em pt-BR quando falhou, foi pulada ou perdida |
| `finished_at` | `string \| null` | fim |

Estados: `reported` (terminou e relatou), `quiet` (terminou sem novidade),
`failed` (a execução falhou, o agente está desligado ou foi apagado),
`cancelled` (o dono parou), `skipped` (a anterior ainda rodava), `missed`
(horário perdido há mais de 12 horas). Uma execução que espera aprovação ou
resposta do dono continua `running`.

## 4. Rotas (todas com o token do dono)

- `GET /agents/routines` (opcional `?agent_id=`) → `{ "routines": [ <rotina> ] }`.
- `POST /agents/routines`, corpo `{ "agent_id", "title", "prompt", "schedule", "report"?, "enabled"? }`
  → `{ "routine": <rotina> }`. `enabled` padrão `true`. Erros: 404 agente não
  existe; 422 campo inválido; 409 `routine_limit` (já há 20 ativas daquele agente).
- `PATCH /agents/routines/{id}`, corpo parcial com `title`, `prompt`,
  `schedule`, `report`, `enabled` → `{ "routine": <rotina> }`. Ligar
  (`enabled: true`) limpa `paused_reason` e zera `consecutive_failures`.
  Mudar `schedule` ou religar recalcula `next_run_at`. 409 `routine_limit` ao ligar.
- `DELETE /agents/routines/{id}` → `{ "ok": true }`. Apaga a rotina e o livro
  dela; uma execução em andamento continua até o fim.
- `POST /agents/routines/{id}/run` ("Rodar agora") → `{ "routine": <rotina>, "run": <execução> }`.
  Funciona com a rotina desligada. 409 `routine_running` se já há uma
  execução dela em andamento. Não muda `next_run_at`.
- `POST /agents/routines/{id}/copy` → `{ "routine": <rotina> }`: cópia com o
  título "{título} (cópia)", `origin: "copy"`, que nasce **desligada**.
- `GET /agents/routines/{id}/runs?limit=` (padrão 20, máximo 100) →
  `{ "runs": [ <linha do livro> ] }`, da mais recente para a mais antiga.
- `POST /agents/routines/draft`, corpo `{ "text": "<1 a 500>", "agent_id"? }`
  → `{ "draft": { "title", "prompt", "schedule", "schedule_text", "report" }, "say": "<frase>" }`.
  Uma chamada ao cérebro configurado da Seraphine lê a frase do dono ("todo
  dia útil às 8 me mande as pendências") e devolve os campos; o backend
  valida tudo com as regras da seção 1 (horário inválido ou ausente → uma
  segunda tentativa; depois 503 `guide_unavailable`). Nada é criado. Mesmo
  limite de tempo e mesmo cuidado da proposta de time (a frase é dado).
  409 `guide_busy` se o cérebro já está ocupado com uma proposta.

Apagar um agente apaga as rotinas dele. Desligar um agente (`enabled: false`)
não apaga: os horários viram `failed` com a frase "o agente está desligado"
(e contam para a pausa por falhas).

## 5. Como uma rotina roda

- Um relógio no backend (a cada `agents_routine_tick_s`, padrão 30 s) pega as
  rotinas ligadas com `next_run_at` vencido. Para cada uma: se a anterior
  ainda roda, registra `skipped`; se o horário venceu há mais de
  `agents_routine_catchup_s` (padrão 43.200 s), registra `missed`; senão
  começa a execução (`trigger` `schedule`, ou `catchup` quando o atraso passa
  de 5 minutos). Em seguida avança `next_run_at` para o próximo horário
  **depois de agora** (vários horários perdidos viram uma execução só).
- A execução é uma execução comum do agente, no projeto da rotina, com
  `requested_by: "routine"`. Entra na fila como qualquer outra (um agente
  ocupado termina o que está fazendo antes).
- O pedido entregue ao agente leva: que é uma execução de rotina sem o dono
  presente (não fazer perguntas de esclarecimento; se faltar algo, dizer no
  relato), o título e o pedido da rotina e, quando `report` é `news`, a regra
  do `SEM_NOVIDADE`.
- Ao terminar: `done` com resposta igual a `SEM_NOVIDADE` (sem diferenciar
  maiúsculas, espaços e pontuação das pontas ignorados) e `report: "news"` →
  `quiet`, e a mensagem final **não** é publicada na conversa; `done` nos
  demais casos → `reported`; `failed` → `failed`; `cancelled` → `cancelled`.
  `reported` e `quiet` zeram `consecutive_failures`; `failed` soma um.
- Na 5ª falha seguida (`agents_routine_fail_pause`): `enabled` vira falso,
  `paused_reason` vira `"failures"`, e uma mensagem de sistema entra na
  conversa do agente, uma vez: "A rotina «{título}» foi pausada depois de 5
  falhas seguidas. {último motivo}".
- Rotina `once`: depois de rodar (qualquer estado final que não `skipped`),
  `enabled` vira falso.
- Reinício do backend: o relógio volta sozinho; uma linha `running` cuja
  execução não está mais ativa é fechada com o estado final daquela execução.

## 6. Acréscimos em objetos existentes

- Execução: `routine_id` (`string | null`) e `routine_title` (`string | null`),
  sempre presentes.
- Mensagem: `routine_id` (`string | null`), sempre presente, preenchido nas
  mensagens publicadas por uma execução de rotina.
- Canal ao vivo: quadro novo `{"type": "routine_update", "routine": <rotina>}`
  a cada mudança de uma rotina (criada, alterada, rodou, pausou) e
  `{"type": "routine_deleted", "id": "<id>"}`.
- `GET /agents/overview` ganha `"routines_active": number`.

## 7. Rotinas nos times prontos e na proposta pela conversa

- Rascunho de agente (6a) ganha `routines`: lista opcional de até 3 itens
  `{ "title", "prompt", "schedule", "report"? }`, validados pelas regras
  desta etapa.
- Times prontos: cada agente de time traz **uma** rotina útil e discreta
  (por exemplo, uma vez por dia útil ou por semana), com `report: "news"`.
- Proposta pela conversa: o modelo pode propor até 2 rotinas por agente;
  rotina com horário inválido é descartada (o agente continua na proposta).
  A instrução ao modelo passa a dizer que rotinas existem (horário local,
  mínimo de 15 minutos) e continua proibindo prometer agenda do Google e
  finanças.
- `POST /agents/team`: depois de criar o agente e a casa, cria as rotinas do
  rascunho, **ligadas**. Se uma rotina falhar, o agente continua criado e a
  falha entra em `failed` da resposta como `{ "name": "{agente}: rotina «{título}»", "detail": … }`.
  A resposta ganha `"routines": [ <rotina> ]` com as criadas.
- Os textos dos times e da instrução ao modelo podem citar rotinas; continuam
  sem prometer agenda nem finanças.

## 8. Tela

### 8.1 Aba "Rotinas" na conversa do agente

Na conversa própria do agente (casa), ao lado de "Conversa" e "Tarefas".

- Lista das rotinas do agente. Cada linha: título, `schedule_text`, estado em
  chip com ícone e palavra ("Ativa", "Pausada", "Pausada por falhas",
  "Rodando agora"), "Próxima: {quando}" (data e hora em palavras: "hoje às
  19:30", "amanhã às 08:00", "seg., 16/11 às 08:00"), "{ok} de {total} bem
  esta semana" quando `total > 0`, e a última execução (estado em palavras e
  quando).
- Ações por linha: "Rodar agora", "Pausar"/"Retomar", "Editar", "Duplicar"
  (a cópia nasce pausada, e a tela diz isso), "Apagar" (com confirmação).
  Na pausa por falhas: o aviso com o último motivo e "Retomar".
- "Ver execuções": as últimas 20 linhas do livro (quando, como começou,
  estado em palavras, frase de detalhe, link para a execução quando houver).
- Vazio: "Nenhuma rotina ainda. Combine uma vez e {nome} faz no horário." e
  o botão "Nova rotina".
- **Formulário** (criar e editar): título; pedido; horário por seletor (tipo,
  hora, dias da semana em fichas, dia do mês, intervalo em minutos, data e
  hora para "uma vez"); relato ("Só quando houver novidade" / "Sempre");
  prévia "Próximas" com os 3 próximos horários calculados pela tela a partir
  do seletor; caixa "Descreva em uma frase" que chama o rascunho e preenche o
  formulário (o dono confere e salva). Erros do backend aparecem no lugar.
- Uma linha de ajuda fixa: "Uma rotina age com as permissões de {nome}.
  Comandos continuam esperando a sua aprovação."

### 8.2 Tela "Rotinas" (todas)

Item novo "Rotinas" na barra lateral do espaço de agentes (abaixo de
"Agentes"), com a contagem das ativas. Lista todas as rotinas agrupadas por
agente, com as mesmas linhas e ações, e um filtro "Só ativas". Vazio: um
texto curto e o atalho para escolher um agente.

### 8.3 Na conversa

- Mensagem publicada por uma rotina: chip "Rotina · {título}" junto do nome
  do agente; clicar no chip abre a aba "Rotinas".
- Lista "O que ele fez" de uma execução de rotina começa com a linha "Rotina
  «{título}», no horário." (ou "…, a pedido." / "…, ao voltar.").

### 8.4 No diálogo "Seus agentes" e nos primeiros passos

- Cartão de cada agente do time (pronto ou proposto) mostra as rotinas dele:
  título, `schedule_text`, e uma caixa de marcar "Criar esta rotina" (marcada
  por padrão). Desmarcada, a rotina não vai no pedido de criação.
- Rodapé: "N agentes · M rotinas". Depois de criar, o resultado diz quantas
  rotinas foram criadas.

### 8.5 Início

"TRABALHANDO AGORA" mostra execuções de rotina como as demais, com o chip
"Rotina". Um bloco curto "PRÓXIMAS ROTINAS" lista as 3 próximas (agente,
título, quando), escondido quando não há rotina ativa.

## Códigos novos

`routine_limit`, `routine_running`.

## Configuração nova (backend)

`agents_routine_tick_s` (30), `agents_routine_catchup_s` (43200),
`agents_routine_fail_pause` (5), `agents_routine_min_interval_min` (15),
`agents_routine_max_active` (20).

## Fora desta etapa

Agente criando ou mudando rotina por ferramenta; gatilhos que não são
horário (evento, e-mail, webhook, "arquivo novo"); ajustar agentes e rotinas
conversando com a Seraphine depois de criados (fica para a 6c); notificação
do navegador quando uma rotina relata (fase 8).
