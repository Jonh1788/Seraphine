# Fase 1d: limites da execução e reconexão (contrato)

Contrato entre o backend e a tela para a etapa 1d do plano
(`docs/agent-harness/PLANO.md`), que fecha a fase 1. Backend e tela são
implementados ao mesmo tempo por pessoas diferentes, então nenhum dos lados
pode se desviar daqui. Se algo for impossível, parar e relatar em vez de
inventar uma variante.

Referências de desenho: estudo principal, seção "Fase 1"
(`E:\Projetos\Projeto-Seraphine\reports\Agentes chat pelo código fonte.md`),
e as notas `execucoes_e_fila.md` e `laco_do_agente_computador_e_navegador.md`.
Esta etapa se apoia na 1a, 1b e 1c (contratos na mesma pasta).

## Por quê

Duas pontas soltas da fase 1:

1. Nada impede um agente de trabalhar sem fim, de repetir a mesma ação em
   laço ou de ficar mudo para sempre. O dono só descobre olhando.
2. Se a página perde um aviso do canal ao vivo (a conexão cai, ou o backend
   descarta um aviso porque a página está lenta), ela fica mostrando um estado
   velho até ser recarregada.

## Parte 1: limites da execução

Os motores rodam um turno por vez como processo; o harness não controla as
chamadas ao modelo dentro do turno, mas vê cada ação e cada mensagem que o
motor emite. Os limites são medidos nesses eventos.

| Limite | Padrão | O que acontece ao atingir |
|---|---|---|
| Ações por execução (`agents_run_max_actions`) | 200 | Ao chegar a 2 antes do teto, uma nota avisa na atividade. No teto, o turno é encerrado e a execução termina `failed` com erro `step_limit`. |
| Silêncio do motor (`agents_engine_silence_s`) | 900 s | Sem nenhum evento do motor por esse tempo durante um turno, o turno é encerrado e a execução termina `failed` com erro `engine_silent`. |
| Duração de um turno (`agents_turn_max_s`) | 10800 s | O turno é encerrado e a execução termina `failed` com erro `turn_timeout`. |
| Laço (`stuck_loop`) | ver abaixo | O turno é encerrado e a execução termina `failed` com erro `stuck_loop`. |

**Laço.** Considera-se travado quando, dentro de uma mesma execução, ocorre
qualquer um destes: a mesma ação (mesmo tipo e mesmo alvo ou comando) 3 vezes
seguidas; a mesma ação falhando com o mesmo erro 3 vezes dentro das últimas 8
ações; 4 ações seguidas falhando. Ações só de leitura repetidas não contam
como laço antes de 6 repetições seguidas.

Regras comuns:

- Encerrar o turno usa o mesmo caminho de "Parar e mandar" da 1c (o processo
  do motor é encerrado), mas a execução termina.
- Nos quatro casos o canal do projeto recebe uma mensagem em português claro,
  em nome do agente, dizendo o que aconteceu e até onde ele tinha chegado, e
  a execução fica com `can_continue: true` (o dono decide se vale continuar).
- Se uma ação estava aberta no momento em que o harness encerrou o turno, a
  mensagem diz que ela pode ter ficado pela metade.
- Mensagens pendentes na caixa de entrada ficam `undelivered` (regra da 1c).
- O tempo em que a execução espera aprovação ou está estacionada não conta
  para silêncio nem para a duração do turno. O tempo de um comando aprovado
  que o harness executa já tem seu próprio limite e não conta como silêncio.

**Ação só de leitura cortada (ajuste da 1a).** Na decisão do arranque, uma
ação aberta que é só de leitura não bloqueia a retomada automática. São só
de leitura: as ferramentas de ler arquivo, listar e buscar em arquivos e
buscar na web dos motores (no Claude Code: `Read`, `Glob`, `Grep`,
`WebSearch`; no Codex: busca na web). Comandos de terminal nunca são tratados
como só de leitura.

## Parte 2: canal ao vivo sem buracos

Todo quadro que o backend envia pelo canal ao vivo (`/agents/ws`) passa a
levar dois campos:

| campo | tipo | significado |
|---|---|---|
| `boot` | `string` | identificador do processo do backend que enviou (muda a cada reinício) |
| `seq` | `number` | número de sequência crescente, de 1 em 1, por conexão |

- A numeração é por conexão: cada conexão começa em 1 no quadro `ready`.
  Quando o backend descarta um quadro para uma conexão lenta, o número pulado
  denuncia o buraco.
- Quadros `heartbeat` e `pong` também são numerados.
- A página guarda o último `seq` e o `boot`. Se chegar um `seq` que não é o
  anterior mais 1, ou se o `boot` mudar numa reconexão, ela faz uma
  **ressincronização**: relê o resumo, as execuções ativas, os eventos das
  execuções que está mostrando (a partir do último evento que conhece) e as
  mensagens das conversas abertas.
- A ressincronização também acontece em toda reconexão depois de uma queda
  (já existe em parte: hoje só o resumo é relido).

Rota nova para a ressincronização dos eventos de uma execução já existe
(`GET /agents/runs/{id}/events?after=<id>`); nenhuma rota nova é necessária.

## Objeto execução: campo novo, sempre presente

| campo | tipo | significado |
|---|---|---|
| `actions_count` | `number` | quantas ações a execução já fez (para a nota de aviso e para a tela) |

## Eventos

- `step` com `{"type": "note", "reason": "limit_warning", "text": "<pt-BR>"}`
  quando faltam 2 ações para o teto.
- `step` com `{"type": "note", "reason": "limit_stop", "limit": "step_limit" | "engine_silent" | "turn_timeout" | "stuck_loop", "text": "<pt-BR>"}`
  quando o harness encerra o turno por um limite.

## Códigos de erro de execução novos

`step_limit`, `engine_silent`, `turn_timeout`, `stuck_loop`. Todos permitem
`continue` (a regra de `can_continue` passa a aceitar `failed` com `interrupted`
ou com um destes quatro).

## Configuração nova (backend)

`agents_run_max_actions` (200), `agents_engine_silence_s` (900),
`agents_turn_max_s` (10800). Os números do detector de laço ficam em código.
