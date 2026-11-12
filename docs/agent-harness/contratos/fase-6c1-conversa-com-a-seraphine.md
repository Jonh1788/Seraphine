# Fase 6c, parte 1: conversa com a Seraphine, propostas e histórico do agente (contrato)

Contrato entre o backend e a tela para a primeira parte da etapa 6c do plano
(`docs/agent-harness/PLANO.md`, seção 5.6). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Apoia-se na 6a (`fase-6a-primeiros-passos-e-times.md`: rascunho de agente,
criação de time, proposta pela conversa) e na 6b (`fase-6b-rotinas.md`).
Referências: `COMPARACAO.md`, áreas 6 e 13; nota
`onboarding_e_criacao_guiada.md` (seções sobre a guia e os cartões de
proposta) na pasta de notas do estudo.

## Por quê

Depois de criados, agentes e rotinas só mudam por formulário. O que se quer:
o dono conversa com a Seraphine no espaço de agentes ("deixe a Bia mais
direta", "crie um agente para cuidar das minhas viagens", "passe a rotina da
Lia para as 7h") e ela devolve **cartões de proposta**; cada cartão mostra
exatamente o que muda e só vale depois do clique do dono. E toda mudança no
texto de um agente fica num **histórico**, com volta a qualquer versão.

## Regras desta parte

1. **A Seraphine propõe, o dono aplica.** Nenhuma resposta da conversa muda
   nada sozinha. Cada proposta é um cartão com "Aplicar" e "Descartar".
2. **O que uma proposta pode fazer** (e só isto): criar agentes; mudar o
   nome, o papel, a descrição, as instruções e as sugestões de um agente;
   criar uma rotina; mudar título, pedido, horário e relato de uma rotina;
   pausar ou retomar uma rotina.
3. **O que uma proposta nunca faz:** mudar motor, provedor, modelo, permissões
   de arquivos ou de comandos, acesso às ferramentas da Seraphine, orçamento,
   projetos; ligar ou desligar um agente; apagar qualquer coisa. Isso continua
   só no formulário, pela mão do dono.
4. **O texto do modelo é dado.** A resposta do cérebro é validada campo a
   campo quando vira proposta e **de novo** quando é aplicada, contra o estado
   daquele momento. Agentes criados por proposta seguem as regras da 6a
   (comandos em "pergunta", teto de acesso). Um identificador que não existe
   invalida a proposta, não a conversa.
5. **Proposta vencida não se aplica.** Vale 24 horas. Se o alvo mudou desde
   que ela foi feita, fica "desatualizada" e não pode ser aplicada.
6. **Tudo o que muda o texto de um agente entra no histórico**, com quem
   mudou (o dono, pela conversa com a Seraphine, por um time pronto) e quando.
7. A conversa não lê as mensagens trocadas com os agentes, nem a memória
   pessoal, nem arquivos: só a lista de agentes (com os textos deles) e de
   rotinas, e o que o dono escreve ali.

## 1. Conversa com a Seraphine

Uma conversa só, do dono com a Seraphine, dentro do espaço de agentes.

Objeto mensagem da conversa:

| campo | tipo | significado |
|---|---|---|
| `id` | `string` | identificador |
| `author` | `"owner" \| "seraphine"` | quem escreveu |
| `body` | `string` | o texto |
| `proposal_ids` | `string[]` | propostas que vieram com esta resposta (só em `seraphine`) |
| `created_at` | `string` | data |

Rotas (token do dono):

- `GET /agents/guide/messages?limit=` (padrão 50, máximo 200) →
  `{ "messages": [ <mensagem> ], "proposals": [ <proposta> ] }`: as mensagens
  em ordem (mais antigas primeiro) e todas as propostas citadas por elas.
- `POST /agents/guide/messages`, corpo `{ "body": "<1 a 2.000>", "about"?: { "agent_id"?: string, "routine_id"?: string } }`
  → `{ "message": <a do dono>, "reply": <a da Seraphine>, "proposals": [ <proposta> ] }`.
  O backend guarda a mensagem do dono, faz **uma chamada ao cérebro
  configurado** (mesmo limite de tempo, mesma marca de ocupado e mesma
  segunda tentativa da proposta de time) e guarda a resposta com as propostas
  válidas. `about` diz sobre o que o dono está falando (quando ele abriu a
  conversa a partir de um agente ou de uma rotina). Erros: 503
  `guide_unavailable` (a mensagem do dono fica guardada; `detail` em pt-BR);
  409 `guide_busy`; 422 corpo inválido.
- `DELETE /agents/guide/messages` → `{ "ok": true }`: limpa a conversa
  (mensagens e propostas que não foram aplicadas; as aplicadas continuam no
  histórico dos agentes).

O que o backend entrega ao cérebro, tudo como dado em JSON: a mensagem do
dono; as últimas 12 mensagens da conversa; a lista de agentes (id, nome,
papel, descrição, se está ligado; e as instruções completas, cortadas em
6.000 caracteres por agente, dos agentes citados pelo nome na mensagem ou
indicados em `about`, ou de todos quando há até 6); a lista de rotinas (id,
agente, título, pedido, frase do horário, horário, relato, ligada); a data e
a hora locais. A instrução ao modelo diz o que ele pode propor (regra 2), o
que não pode (regra 3), o que os agentes conseguem fazer hoje (regra 5 da
6a, com rotinas), e pede **somente JSON**:
`{ "say": "<resposta ao dono>", "proposals": [ … ] }`. Quando o pedido do
dono não exige mudança (uma pergunta), `proposals` vem vazia e a Seraphine
só responde. Quando o pedido é algo que a regra 3 proíbe, ela responde
dizendo onde o dono faz isso, sem proposta.

Limites: até 4 propostas por resposta; `say` até 1.200 caracteres.

## 2. Propostas

Objeto proposta:

| campo | tipo | significado |
|---|---|---|
| `id` | `string` | identificador |
| `kind` | `"create_agents" \| "update_agent" \| "create_routine" \| "update_routine"` | o que faz |
| `status` | `"pending" \| "applied" \| "dismissed" \| "expired" \| "stale" \| "failed"` | estado |
| `title` | `string` | frase curta em pt-BR do que a proposta faz, escrita pelo backend ("Mudar as instruções de Bia", "Criar 2 agentes", "Nova rotina de Lia: Revisão do dia") |
| `payload` | objeto | abaixo, por `kind` |
| `before` | objeto \| `null` | o estado atual dos campos que mudam (para a tela mostrar antes e depois); `null` em criações |
| `target` | `{ "agent_id"?: string, "routine_id"?: string }` | o alvo, quando há |
| `result` | objeto \| `null` | depois de aplicar: `{ "agent_ids"?, "routine_ids"?, "failed"?: [ {name, detail} ] }` |
| `detail` | `string` | frase em pt-BR quando `stale`, `failed` ou `expired` |
| `created_at`, `expires_at`, `decided_at` | `string \| null` | datas |

`payload` por tipo:

- `create_agents`: `{ "agents": [ <rascunho de agente da 6a, com `routines` da 6b> ] }`, 1 a 5.
- `update_agent`: `{ "agent_id": string, "changes": { "name"?, "role"?, "description"?, "instructions"?, "suggestions"? } }`,
  com pelo menos um campo e os limites da 6a.
- `create_routine`: `{ "agent_id": string, "title", "prompt", "schedule", "report"? }` (regras da 6b).
- `update_routine`: `{ "routine_id": string, "changes": { "title"?, "prompt"?, "schedule"?, "report"?, "enabled"? } }`,
  com pelo menos um campo.

Regras:

- Uma proposta que não passa na validação ao chegar do modelo é descartada
  (a resposta continua); se nenhuma sobra e o modelo queria propor, a
  resposta ganha, no fim, a frase "Não consegui montar a proposta. Pode
  descrever de outro jeito?".
- `update_*` guarda uma impressão digital do alvo no momento da proposta. Ao
  aplicar, se o alvo não existe mais ou a impressão mudou, a proposta vira
  `stale` com `detail` e a rota responde 409 `proposal_stale`.
- Uma proposta nova para o **mesmo alvo e mesmo tipo** marca a pendente
  anterior como `dismissed` (com `detail` "substituída por uma proposta mais nova").
- Vencimento: `expires_at` = criação + `agents_proposal_ttl_s` (padrão 86.400).
  Vencida, vira `expired` na leitura.

Rotas (token do dono):

- `POST /agents/guide/proposals/{id}/apply` → `{ "proposal": <proposta>, "agents": [ <agente> ], "routines": [ <rotina> ] }`
  (os objetos criados ou alterados). Aplica pelos mesmos caminhos validados
  das rotas existentes (criação de time da 6a com `origin: "guide"`, edição de
  agente, criação e edição de rotina da 6b). `create_agents` com falha
  parcial: `status` fica `applied` e `result.failed` lista as falhas; se
  nenhum agente foi criado, `failed` com `detail`. Erros: 404; 409
  `proposal_not_pending` (já decidida ou vencida); 409 `proposal_stale`; 409
  `routine_limit` e 422 vindos da aplicação (a proposta vira `failed` com o
  `detail`).
- `POST /agents/guide/proposals/{id}/dismiss` → `{ "proposal": <proposta> }`. 409 `proposal_not_pending`.

## 3. Histórico do agente

Cada vez que nome, papel, descrição, instruções ou sugestões de um agente
mudam (e na criação), o backend guarda uma versão.

Objeto versão:

| campo | tipo | significado |
|---|---|---|
| `version` | `number` | 1, 2, 3… por agente |
| `name`, `role`, `description`, `instructions` | `string` | o texto naquela versão |
| `suggestions` | `string[]` | idem |
| `changed_by` | `"owner" \| "guide" \| "pack" \| "restore"` | de onde veio a mudança |
| `note` | `string` | frase curta em pt-BR ("Criado.", "Mudança pedida na conversa com a Seraphine.", "Voltou para a versão 2.") |
| `changed_fields` | `string[]` | quais dos cinco campos mudaram em relação à versão anterior |
| `created_at` | `string` | data |

- `GET /agents/defs/{id}/versions` → `{ "versions": [ <versão> ] }`, da mais
  nova para a mais antiga (no máximo as 50 mais recentes).
- `POST /agents/defs/{id}/versions/{version}/restore` → `{ "def": <agente>, "version": <a versão nova criada pela volta> }`.
  Volta os cinco campos ao que eram naquela versão (cria uma versão nova,
  `changed_by: "restore"`). 404 quando não existe; 409 `version_current`
  quando já é igual ao estado atual.
- Agentes que já existiam antes desta etapa ganham a versão 1 na primeira
  leitura do histórico ou na primeira mudança (`note`: "Como estava quando o
  histórico começou.").
- O objeto agente ganha `version` (`number`, sempre presente; 0 quando ainda
  não há histórico).
- Uma mudança que não altera nenhum dos cinco campos não cria versão.

## 4. Tela

### 4.1 Conversa com a Seraphine

- Primeiro item da lista de agentes na barra lateral do espaço de agentes:
  "Seraphine", com a legenda "monta e ajusta os seus agentes". Abre a tela da
  conversa.
- A tela: cabeçalho com a marca da Seraphine e uma linha fixa ("Ela propõe,
  você decide. Nada muda antes do seu clique."), as mensagens, e o compositor.
  Enquanto espera: "A Seraphine está pensando…" (região viva). Erro 503: a
  mensagem do dono continua na conversa, com o aviso e "Tentar de novo"
  (reenvia o mesmo texto). Erro 409: aviso para esperar.
- Conversa vazia: uma frase de boas-vindas e quatro sugestões que preenchem o
  compositor (sem enviar), escritas pela tela a partir do que existe (por
  exemplo, citando o nome de um agente ou de uma rotina quando há).
- "Limpar conversa" no cabeçalho, com confirmação.
- **Cartão de proposta**, sob a resposta que o trouxe: o `title`; o que muda
  em palavras; para `update_*`, **antes e depois** de cada campo (instruções
  longas recolhidas, com "Ver o texto inteiro"); para criações, os mesmos
  cartões de agente e as mesmas linhas de rotina da 6a e da 6b (somente
  leitura); o prazo ("vale até amanhã às 14:00"); botões "Aplicar" e
  "Descartar". Estados em chip com ícone e palavra: "Esperando você",
  "Aplicada", "Descartada", "Venceu", "Desatualizada", "Não deu certo" (com o
  `detail`). Depois de aplicada: links "Abrir a conversa de {nome}" /
  "Ver a rotina" e, para `update_agent`, "Ver o histórico".
- Entradas: o botão "Ajustar" da conversa de um agente ganha, ao lado, "Pedir
  à Seraphine", que abre a conversa com `about.agent_id` e o compositor
  preenchido com "Sobre {nome}: "; na aba "Rotinas", cada rotina ganha a ação
  "Pedir à Seraphine" (`about.routine_id`, "Sobre a rotina «{título}»: ").
- No Início, quando há proposta pendente: uma linha em "ESPERANDO VOCÊ",
  "A Seraphine tem {n} proposta(s) esperando", que abre a conversa.

### 4.2 Histórico no formulário do agente

No formulário do agente (elenco), uma seção recolhida "Histórico": a lista
das versões (número, quem mudou em palavras, quando, quais campos), "Ver o
que mudou" (antes e depois dos campos que mudaram naquela versão) e "Voltar
para esta versão" (com confirmação; a atual não tem esse botão). Depois de
voltar, o formulário mostra o texto restaurado.

## Códigos novos

`proposal_not_pending`, `proposal_stale`, `version_current`.

## Configuração nova (backend)

`agents_proposal_ttl_s` (86400), `agents_guide_history` (12),
`agents_guide_instructions_chars` (6000).

## Fica para a parte 2 da 6c

Página do agente com checklist próprio, pausar e arquivar; configurações do
espaço ("IA e uso", "Ferramentas e acesso"); desfazer a criação de um time.
