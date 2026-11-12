# Fase 6c, parte 2: página do agente, pausar e arquivar, ajustes do espaço e desfazer um time (contrato)

Contrato entre o backend e a tela para a segunda parte da etapa 6c do plano
(`docs/agent-harness/PLANO.md`, seção 5.6). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Apoia-se na 6a (casa do agente, times, primeiros passos), na 6b (rotinas) e
na parte 1 da 6c (conversa com a Seraphine, propostas, histórico).
Referências: `COMPARACAO.md`, áreas 6, 20, 22 e 24; capturas 08 e 09 do dono
(telas de ajustes do produto de referência, só para entender o tipo de tela).

## Por quê

Faltam quatro coisas para o dono cuidar dos agentes sem formulário comprido:
ver num lugar só **o que é cada agente e o que falta para ele trabalhar bem**;
**pausar ou arquivar** um agente sem apagá-lo; uma tela de **ajustes do
espaço** com os motores, o uso e o acesso às ferramentas de todos os agentes
lado a lado; e **desfazer** um time recém-criado.

## Regras desta parte

1. **Pausar não é falhar.** Um agente pausado não responde e não roda
   rotinas; os horários das rotinas dele são registrados como pulados, não
   como falhas, e não contam para a pausa por falhas. (Isto muda a regra da
   6b, que os registrava como falha.)
2. **Arquivar guarda tudo.** Um agente arquivado some das listas, não
   recebe mensagens e não roda rotinas; a conversa, as rotinas, o histórico e
   a pasta ficam. Restaurar traz tudo de volta como estava (as rotinas voltam
   pausadas ou ligadas como estavam).
3. **Apagar continua existindo e é definitivo.** A tela exige digitar o nome
   do agente e mostra o que sai e o que fica.
4. **Acesso às ferramentas só muda pela mão do dono**, um clique por vez, e
   subir o acesso à memória pessoal pede confirmação.
5. **O uso mostrado é o que foi medido.** Tokens e número de execuções para
   todos; custo em dólar só onde o motor informa. Nada é estimado.
6. **Desfazer um time só remove o que não foi usado.** Um agente do time que
   já conversou é arquivado em vez de apagado.
7. O que a lista de pendências do agente mostra vem dos dados reais; só os
   "agora não" são guardados.

## 1. Pausar e arquivar

Objeto agente, campos novos sempre presentes: `archived` (`boolean`) e
`archived_at` (`string | null`). `enabled: false` passa a ser chamado, na
tela, de "pausado".

- `POST /agents/defs/{id}/archive` → `{ "def": <agente> }`. Recusa com 409
  `agent_busy` se há execução em andamento. Arquiva também a casa. Chamar de
  novo não muda nada.
- `POST /agents/defs/{id}/unarchive` → `{ "def": <agente> }`. Restaura o
  agente e a casa.
- `GET /agents/defs` ganha `?include_archived=true` (padrão: sem os arquivados).
- Agente arquivado: mensagem para ele responde com o erro `agent_archived`
  (frase em pt-BR), sem criar execução; "Rodar agora" de uma rotina dele
  responde 409 `agent_archived`; não entra no roteador nem nas propostas da
  Seraphine (a lista de agentes entregue ao cérebro não o inclui).
- Rotinas de agente pausado ou arquivado: o horário vira `skipped` com a
  frase "O agente está pausado." ou "O agente está arquivado."; não soma em
  `consecutive_failures`. "Rodar agora" com o agente pausado continua
  recusado (409 `agent_disabled`).
- `PATCH /agents/defs/{id}` em agente arquivado: 409 `agent_archived`
  (restaure antes).

## 2. Página do agente

`GET /agents/defs/{id}/page` (token do dono) → tudo o que a aba "Sobre" mostra:

```json
{ "def": <agente>,
  "home": <projeto> | null,
  "engine": { "ready": true, "label": "Plano do Claude (Claude Code)", "how": "" },
  "access": [ { "group": "notes", "label": "Notas", "level": "write" } ],
  "routines": { "total": 2, "active": 1, "next_run_at": "…" | null },
  "activity": { "runs": 12, "last_run_at": "…" | null, "tokens_in": 0, "tokens_out": 0 },
  "checklist": { "items": [ { "id": "engine", "done": true, "optional": false } ], "done": 2, "total": 4, "dismissed": false } }
```

Lista de pendências (`checklist.items`), calculada na hora:

| `id` | feito quando | opcional |
|---|---|---|
| `engine` | o motor do agente está pronto | não |
| `first_talk` | existe uma execução concluída dele | não |
| `access` | o dono conferiu o acesso: marcou "Está bom assim" ou já mudou algum nível | não |
| `routine` | o agente tem pelo menos uma rotina, ou o dono marcou "Agora não" | sim |

`PUT /agents/defs/{id}/checklist`, corpo parcial `{ "access_ok"?: boolean, "routine_skipped"?: boolean, "dismissed"?: boolean }`
→ `{ "checklist": <o mesmo objeto> }`. `dismissed` esconde a lista inteira
para aquele agente. Guardado na tabela de chave e valor (`agents.checklist.<id>`).
Apagar o agente apaga a chave.

## 3. Uso

`GET /agents/usage?days=` (7, 30 ou 90; padrão 30) →

```json
{ "days": 30,
  "totals": { "runs": 40, "routine_runs": 9, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.72 },
  "agents": [ { "agent_id": "bia", "name": "Bia", "archived": false, "runs": 12, "routine_runs": 4,
                "tokens_in": 0, "tokens_out": 0, "cost_usd": 0, "cost_known": false, "last_run_at": "…" | null } ],
  "by_day": [ { "date": "2026-11-12", "runs": 5, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0 } ] }
```

- Conta execuções criadas na janela (dia local). `routine_runs` são as de
  `requested_by: "routine"`. `cost_known` é verdadeiro quando alguma execução
  daquele agente na janela informou custo. `by_day` traz todos os dias da
  janela, do mais antigo ao mais novo, com zeros onde não houve nada.
- Agentes apagados não aparecem; os arquivados aparecem com `archived: true`.

## 4. Desfazer a criação de um time

- `POST /agents/team` e a aplicação de uma proposta `create_agents` passam a
  guardar um **lote** (os agentes e rotinas criados) e a devolver
  `"batch": { "id": string, "undo_until": string } | null` (`null` quando
  nada foi criado). Em propostas, o lote entra em `result.batch`.
- `POST /agents/team/batches/{id}/undo` →
  `{ "removed": [ { "agent_id", "name" } ], "archived": [ { "agent_id", "name" } ], "kept": [ { "agent_id", "name", "detail" } ] }`.
  Para cada agente do lote que ainda existe: sem nenhuma execução, é apagado
  (com rotinas, histórico e casa arquivada; a pasta fica); com execução, é
  arquivado; com execução em andamento, fica como está e entra em `kept` com
  a frase. Erros: 404; 409 `undo_expired` (passou de `agents_team_undo_s`,
  padrão 86.400 s); 409 `already_undone`.
- `GET /agents/team/batches/{id}` → `{ "batch": { "id", "undo_until", "undone_at": string | null, "can_undo": boolean, "agents": [ { "agent_id", "name", "exists": boolean } ] } }`.

## 5. Tela

### 5.1 Aba "Sobre" na conversa do agente

Quarta aba, depois de "Rotinas". Mostra, em blocos curtos: o que ele faz
(descrição e papel); o motor, com chip de estado e a frase do que falta; o
acesso às ferramentas em palavras ("Notas: lê e escreve", "Memória pessoal:
sem acesso"), com o atalho "Mudar o acesso" (abre os ajustes do espaço na
seção de acesso, com a linha do agente em destaque); a pasta dele (caminho,
com "Copiar"); as rotinas (quantas, quantas ativas, a próxima) com atalho
para a aba; a atividade (execuções, última vez, tokens); a versão e o atalho
"Ver o histórico"; e as ações: "Ajustar", "Pedir à Seraphine", "Pausar" /
"Retomar", "Arquivar" (com confirmação que diz o que acontece) e "Apagar"
(diálogo que exige digitar o nome e lista o que sai: o agente, as rotinas, o
histórico; e o que fica: as mensagens já trocadas e a pasta no disco).

### 5.2 Lista de pendências do agente

No topo da aba "Conversa" da casa do agente, enquanto `done < total` e não
foi dispensada: um cartão recolhível "Para {nome} trabalhar bem · {done} de
{total}", com as linhas (chip "Feito" ou "Falta"; a de rotina marcada como
opcional) e, em cada linha que falta, a ação: "Conectar um motor" (abre os
ajustes), sugestão de primeiro pedido (preenche o compositor), "Ver o
acesso" e "Está bom assim", "Nova rotina" e "Agora não". "Dispensar" esconde
o cartão. Completa, some.

### 5.3 Agente pausado e arquivado

- Pausado: chip "Pausado" na barra lateral e no cabeçalho; o compositor da
  conversa dele fica desligado com a frase "{nome} está pausado. Retome para
  conversar." e o botão "Retomar".
- Arquivados não aparecem na barra lateral. No elenco, um filtro "Mostrar
  arquivados" lista-os com "Restaurar" e "Apagar".

### 5.4 Ajustes do espaço de agentes

Item "Ajustes" no fim da barra lateral do espaço de agentes. Uma tela com
seções em abas:

- **"IA e uso"**: as linhas de motores do passo "Conectar um motor" (estado,
  frase do que falta, "Testar", escolha do motor padrão, "Verificar de
  novo"); e o uso: seletor de período (7, 30, 90 dias), os totais, um gráfico
  simples de barras por dia (execuções), e a tabela por agente (execuções,
  das quais rotinas, tokens de entrada e de saída, custo quando conhecido ou
  "não informado pelo motor", última vez). Uma frase fixa: "O custo em dólar
  só aparece quando o motor informa. Planos por assinatura não têm custo por
  uso."
- **"Ferramentas e acesso"**: uma tabela com os agentes nas linhas e os
  grupos de ferramentas nas colunas; cada célula é um botão que alterna
  entre os níveis que aquele grupo aceita (Sem acesso → Lê → Lê e escreve),
  gravando na hora (com "Desfazer" no aviso do resultado). Subir o acesso à
  memória pessoal pede confirmação. Agente cujo motor só conversa: linha
  travada com a explicação. A legenda diz o que cada grupo é.
- **"Espaço"**: a pasta onde ficam as pastas dos agentes; "Rever os primeiros
  passos" (abre a tela da 6a); "Limpar a conversa com a Seraphine".

### 5.5 Desfazer um time

- No painel de resultado do diálogo "Seus agentes" e no cartão de uma
  proposta `create_agents` aplicada: "Desfazer a criação" enquanto
  `undo_until` não passou, com confirmação que explica a regra 6. O resultado
  diz o que foi apagado, o que foi arquivado e o que ficou.

## Códigos novos

`agent_archived`, `undo_expired`, `already_undone` (este último já existe
para recibos; o sentido aqui é o mesmo).

## Configuração nova (backend)

`agents_team_undo_s` (86400).
