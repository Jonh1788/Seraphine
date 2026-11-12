# Fase 1b: estacionar em vez de falhar (contrato)

Contrato entre o backend e a tela para a etapa 1b do plano
(`docs/agent-harness/PLANO.md`). Backend e tela são implementados ao mesmo
tempo por pessoas diferentes, então nenhum dos lados pode se desviar daqui.
Se algo for impossível, parar e relatar em vez de inventar uma variante.

Referências de desenho: estudo principal, seção "Fase 1"
(`E:\Projetos\Projeto-Seraphine\reports\Agentes chat pelo código fonte.md`),
e as notas `execucoes_e_fila.md` e `roteamento_modelos_e_custo.md`.
Esta etapa se apoia na 1a (`fase-1a-recuperacao.md`).

## Por quê

Hoje, se o provedor de IA cai, se o limite do plano estoura ou se o login do
motor expira, a execução falha e o trabalho se perde. Nenhum desses casos é
culpa do trabalho: basta esperar ou o dono resolver. A execução deve ficar
**estacionada**, dizer por quê e até quando, e voltar sozinha (ou com um
clique) de onde parou. Não há troca automática de provedor no meio.

## Estado novo: `parked`

A execução ganha um sexto estado ativo, `parked` ("estacionada"). Estados
passam a ser: `queued`, `running`, `waiting_approval`, `parked`, `done`,
`failed`, `cancelled`.

Uma execução estacionada não ocupa vaga do teto global, mas continua sendo a
execução ativa do agente (outros pedidos ao mesmo agente esperam na fila).
Ela sobrevive a um reinício do backend sem mudança.

## Motivos (`wait_kind`)

| `wait_kind` | Quando | Como volta | Quando desiste |
|---|---|---|---|
| `outage` | O provedor está fora do ar, sobrecarregado, recusou por excesso de chamadas, ou a conexão caiu | Sozinha, numa escada de tentativas: +2 min, +15 min, +30 min, +60 min e depois de hora em hora | 24 h depois do primeiro estacionamento: `failed`, erro `provider_unavailable` |
| `plan_limit` | O limite de uso do plano acabou | Sozinha, na hora de volta informada pelo motor; se ele não informar, tenta a cada 30 min | Sem hora informada: 24 h, `failed`, erro `plan_limit`. Com hora informada: espera até ela (no máximo 8 dias) |
| `auth` | O login do motor expirou ou falta credencial | Só com o dono: ele resolve e pede para tentar de novo | 24 h sem ação: `failed`, erro `engine_auth` |

Regras comuns:

- Só estaciona o que os motores classificam com segurança num desses três
  motivos. Erro desconhecido continua sendo falha, como hoje.
- Se há **ação aberta** (definição da 1a) no momento do erro, a execução não
  estaciona: falha com `interrupted_mid_action`.
- Ao voltar, vale a regra "retomar ou recomeçar" da 1a: se o motor já tinha
  produzido algo, retoma a sessão com um aviso que repete o objetivo; se não,
  recomeça o turno do zero. Voltar de um estacionamento **não** conta em
  `recoveries`.
- O dono pode adiantar a volta a qualquer momento ("tentar agora") e pode
  cancelar uma execução estacionada.
- Uma execução que estaciona de novo pelo mesmo motivo sobe um degrau da
  escada; se voltar a trabalhar e produzir algo, a escada zera.

## Objeto execução: campos novos, sempre presentes

| campo | tipo | significado |
|---|---|---|
| `wait_kind` | `"outage" \| "plan_limit" \| "auth" \| null` | motivo; `null` fora de `parked` |
| `wait_until` | `string \| null` | instante (ISO 8601 UTC) da próxima tentativa automática; `null` em `auth` e fora de `parked` |
| `wait_since` | `string \| null` | instante do primeiro estacionamento desta sequência |
| `wait_attempts` | `number` | quantas vezes estacionou nesta sequência (0 fora de `parked`) |
| `wait_detail` | `string \| null` | uma frase em pt-BR, escrita pelo backend, dizendo o que está sendo esperado ou o que o dono precisa fazer (por exemplo, qual chave falta ou qual motor precisa de login). A tela a usa como explicação, em vez de adivinhar. `null` fora de `parked` |
| `wait_exact` | `boolean` | `true` quando `wait_until` é a hora de volta informada pelo provedor (a tela diz "volta às…"); `false` quando é só a próxima tentativa (a tela diz "nova tentativa" ou "nova verificação") |

**Pedido feito quando já se sabe que falta login ou credencial (acréscimo de
11/11/2026, achado no teste ao vivo).** Se, ao criar a execução, o motor ou o
provedor do agente não está pronto por um motivo de login ou credencial, a
execução é criada já em `parked` com `wait_kind: "auth"`, em vez de o pedido
ser recusado. Assim o pedido do dono não se perde: ele resolve o que falta e
pede para tentar de novo. Indisponibilidade por outros motivos continua
recusando o pedido na hora, como antes.

## Rotas

`POST /agents/runs/{id}/wake` (sem corpo): tira a execução do estacionamento
e a põe na fila agora. Resposta `{ "run": <execução> }`. Erros: 404; 409 com
`code` `not_parked` quando a execução não está estacionada.

O cancelamento existente passa a aceitar `parked`.

O resumo (`GET /agents/overview`) inclui execuções estacionadas em
`active_runs`.

## Eventos

- `status` com `{"status": "parked", "wait_kind": …, "wait_until": …, "wait_attempts": <n>}`
  a cada estacionamento.
- `status` com `{"status": "queued", "reason": "woke", "by": "timer" | "owner"}`
  a cada volta.
- `step` com `{"type": "note", "reason": "parked" | "woke", "text": "<pt-BR>"}`:
  uma nota por estacionamento e uma por volta, para a lista de atividade.
- O quadro `run_update` do canal ao vivo carrega os campos novos.

Mensagens no canal do projeto, em nome do agente: uma ao estacionar pela
primeira vez numa sequência (o que houve e quando volta, ou o que o dono
precisa fazer) e uma ao desistir. As tentativas intermediárias não geram
mensagem no canal, só eventos.

## Códigos de erro de execução novos

`provider_unavailable`, `plan_limit`. O código `engine_auth` já existe e passa
a ser usado só quando o estacionamento por login expira.

## Configuração nova (backend)

`agents_park_max_s` (86400), `agents_park_plan_poll_s` (1800),
`agents_park_plan_max_s` (691200). A escada de `outage` fica em código.
