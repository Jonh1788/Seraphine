# Fase 6a: primeiros passos, times prontos e criação pela conversa (contrato)

Contrato entre o backend e a tela para a etapa 6a do plano
(`docs/agent-harness/PLANO.md`, seção 5.6). Backend e tela são implementados
ao mesmo tempo por pessoas diferentes, então nenhum dos lados pode se desviar
daqui. Se algo for impossível, parar e relatar em vez de inventar uma variante.

Apoia-se nas fases 1 e 3 e na continuidade da conversa (C1). Referências:

- capturas do dono em
  `E:\Projetos\Projeto-Seraphine\reports\capturas-agentes-chat-2026-11-12\`
  (nove telas do produto de referência; servem para entender o fluxo, nunca
  para copiar desenho, textos, nomes ou mascote);
- nota `onboarding_e_criacao_guiada.md` na pasta de notas do estudo;
- `COMPARACAO.md`, áreas 6 e 7.

## Por quê

Hoje o espaço de agentes abre vazio e o dono precisa saber sozinho que tem de
criar um projeto, preencher um formulário longo e escolher motor e provedor.
O que se quer: na primeira vez, a Seraphine conduz em três passos curtos,
oferece **times prontos**, monta um time **a partir do que o dono descreve**,
e cada agente criado já tem **uma conversa própria** onde o dono fala com ele.

## Regras desta etapa

1. **A guia é a própria Seraphine.** Uma frase por passo, escrita pelo app
   (sem chamada de modelo). Nenhum nome, texto, mascote ou desenho do produto
   de referência.
2. **Nada é criado sem um clique do dono.** A Seraphine propõe; "Criar meus
   agentes" cria. A tela mostra antes tudo o que vai ser criado, incluindo as
   pastas.
3. **O passo atual vem dos dados reais** (há motor pronto? há agente?), nunca
   de uma marca guardada. Só são guardadas as respostas do dono e o "agora não".
4. **Segurança igual à de hoje.** Agentes criados por time pronto ou pela
   conversa nascem com comandos em "pergunta" (todo comando pede aprovação),
   memória pessoal fechada, e nenhum grupo de ferramentas acima do que o
   contrato do time declara. O texto que o modelo devolve na criação pela
   conversa é dado: é validado campo a campo e nunca vira permissão acima do
   teto (abaixo).
5. **Só se promete o que existe.** Os times prontos descrevem apenas o que um
   agente consegue fazer hoje: ler e escrever arquivos na pasta dele, usar as
   ferramentas da Seraphine liberadas (notas, lembretes, tarefas do projeto,
   wiki), pesquisar na web quando o motor permite, e rodar comandos com
   aprovação. Agenda do Google, finanças e rotinas agendadas ainda não chegam
   aos agentes: nenhum texto pode prometê-las (rotinas vêm na etapa 6b).
6. **Segredos fora da tela.** Esta etapa não recebe nem mostra chaves de API.
   A tela diz o que falta e onde configurar.

## 1. Conversa própria de cada agente ("casa")

Hoje um agente só trabalha dentro de um projeto (pasta). Passa a existir a
**casa** do agente: um projeto criado pela Seraphine só para ele, com pasta
própria, cujo canal é a conversa direta entre o dono e esse agente.

- Objeto projeto, campos novos sempre presentes: `kind` (`"project" | "home"`)
  e `agent_id` (`string | null`, o dono da casa). Projetos existentes valem
  `kind: "project"`, `agent_id: null`.
- Pasta da casa: `<agents_home_dir>/<id do agente>`. `agents_home_dir` é
  configuração nova do backend; padrão `<pasta do usuário>/Seraphine/agentes`.
  O backend cria a pasta (e as de cima) quando cria a casa. A pasta passa
  pelas mesmas regras de validação de qualquer projeto.
- `POST /agents/defs/{id}/home` (token do dono): garante que a casa existe
  (cria se faltar, desarquiva se estava arquivada) e responde
  `{ "project": <projeto> }`. Chamar de novo devolve a mesma casa. Erros: 404
  agente não existe; 422 `home_unavailable` quando a pasta não pode ser criada
  ou não passa na validação (o `detail` diz por quê, em pt-BR).
- O agente dono da casa tem acesso a ela (entra em `project_ids`).
- **Mensagem numa casa:** `POST /agents/projects/{id}/messages` sem agente
  escolhido vai para o agente dono da casa (não passa pelo roteador
  automático). Mencionar ou escolher outro agente continua valendo.
- Nome do projeto-casa: o nome do agente. Renomear o agente renomeia a casa.
- Apagar o agente arquiva a casa. A pasta no disco nunca é apagada.
- `GET /agents/projects` devolve casas e projetos; a tela separa pelo `kind`.
- `PATCH`/`DELETE` de uma casa pela rota de projetos: `PATCH` só aceita
  `description`; mudar `name`, `path` ou `archived` responde 409
  `home_managed`. `DELETE` responde 409 `home_managed`.

## 2. Campos novos do agente

Objeto agente, campos novos sempre presentes:

| campo | tipo | significado |
|---|---|---|
| `description` | `string` | "o que ele faz", uma ou duas frases para o dono (até 300 caracteres). Padrão `""` |
| `suggestions` | `string[]` | até 3 pedidos de exemplo para a conversa vazia (cada um até 120 caracteres). Padrão `[]` |
| `home_project_id` | `string \| null` | id da casa, quando existe |
| `origin` | `string` | de onde veio: `"manual"`, `"pack:<id>"` ou `"guide"`. Padrão `"manual"` |

`POST /agents/defs` e `PATCH /agents/defs/{id}` aceitam `description` e
`suggestions`. `origin` e `home_project_id` não são editáveis por essas rotas.

Limites que passam a ser conferidos no backend em toda criação e edição
(422 `invalid` com a frase em pt-BR): nome 1 a 80; papel até 200; descrição
até 300; instruções até 20.000; cor no formato `#rrggbb`.

## 3. Estado dos primeiros passos

`GET /agents/setup` (token do dono) →

```json
{ "setup": {
    "areas": ["dia_a_dia", "estudos"],
    "areas_skipped": false,
    "default_engine": { "engine": "claude_code", "provider": "anthropic", "model": null },
    "dismissed": false,
    "home_dir": "C:\\Users\\...\\Seraphine\\agentes",
    "steps": [
      { "id": "areas", "done": true },
      { "id": "engine", "done": true },
      { "id": "agents", "done": false },
      { "id": "first_reply", "done": false }
    ],
    "done": 2,
    "total": 4
} }
```

- `areas`: `string[] | null` (`null` = ainda não respondeu). Valores aceitos:
  `dia_a_dia`, `estudos`, `trabalho`, `programacao`, `pesquisa_escrita`,
  `casa`, `outra`. Até 7, sem repetição.
- `default_engine`: `null` ou o motor que os agentes novos usam quando o
  pedido de criação não diz outro. É validado como o par motor e provedor de
  um agente.
- `dismissed`: o dono fechou os primeiros passos ("agora não").
- `steps[].done`, **calculado na hora, nunca guardado**:
  - `areas`: `areas` não é `null` ou `areas_skipped` é verdadeiro;
  - `engine`: existe pelo menos um motor que age em arquivos (`codex` ou
    `claude_code`) disponível e com o provedor padrão dele configurado, ou um
    provedor de conversa configurado;
  - `agents`: existe pelo menos um agente;
  - `first_reply`: existe pelo menos uma execução concluída (`done`).
- `home_dir`: só leitura, para a tela dizer onde as pastas serão criadas.

`PUT /agents/setup` (token do dono), corpo parcial com qualquer um de
`areas`, `areas_skipped`, `default_engine`, `dismissed` → mesma resposta.
Campo desconhecido ou valor inválido: 422.

As respostas ficam guardadas na tabela de chave e valor que o harness já usa
(chave `agents.setup`).

## 4. Motores: o que a tela de "Conectar um motor" lê

A tela usa `GET /agents/engines` e `GET /agents/providers`, que já existem, e
`POST /agents/bridge/test` para o botão "Testar" (Codex e Claude Code).

Acréscimo em cada item de `GET /agents/providers`, sempre presente:
`"how": "<pt-BR>"`: uma frase dizendo o que o dono faz para deixar aquele
provedor pronto, sem comandos perigosos e sem pedir segredo na tela (por
exemplo: plano do Claude: "Abra o Claude Code neste PC e entre com a sua
conta."; chave: "Ponha a chave no arquivo de configuração do servidor, na
variável X, e reinicie a Seraphine."; local: "Abra o Ollama neste PC.").
Quando o provedor já está pronto, `how` é `""`.

## 5. Times prontos

`GET /agents/packs` (token do dono) →

```json
{ "packs": [ {
    "id": "dia_em_ordem",
    "label": "Dia em ordem",
    "summary": "Lembretes, listas e notas",
    "detail": "Para quem quer tirar da cabeça o que precisa lembrar.",
    "areas": ["dia_a_dia", "casa"],
    "agents": [ <rascunho de agente>, ... ]
} ] }
```

**Rascunho de agente** (o mesmo formato em times prontos, na proposta da
conversa e no pedido de criação):

| campo | tipo | regra |
|---|---|---|
| `name` | `string` | 1 a 80 |
| `role` | `string` | até 200 (rótulo curto: "Lembretes e listas") |
| `description` | `string` | até 300 |
| `instructions` | `string` | 1 a 20.000 |
| `suggestions` | `string[]` | até 3, cada uma até 120 |
| `color` | `string` | `#rrggbb`; opcional (o backend escolhe da paleta) |
| `perm_edit` | `"free" \| "blocked"` | opcional, padrão `"free"` |
| `grants` | `{grupo: "none" \| "read" \| "write"}` | opcional; ver teto abaixo |
| `engine`, `provider`, `model` | `string` | opcionais; sem eles vale o `default_engine` do setup |

`perm_commands` não faz parte do rascunho: agentes criados por este caminho
nascem sempre com `"ask"`.

**Teto de acesso** para rascunhos (time pronto ou conversa): `notes` até
`write`, `reminders` até `write`, `project_tasks` até `write`, `wiki` até
`read`, `memory` sempre `none`. Um rascunho que peça mais é **rebaixado** ao
teto, sem erro, e a resposta de criação lista o que foi rebaixado.

Os times ficam num módulo de dados do backend (`agents/packs.py`), com textos
escritos para a Seraphine. Lista desta etapa (seis times; nomes de agentes
próprios, curtos e brasileiros, nunca os do produto de referência):

| id | Nome | Agentes (papel) | Áreas |
|---|---|---|---|
| `dia_em_ordem` | Dia em ordem | um agente de lembretes e listas; um de notas e organização | dia_a_dia, casa |
| `estudos` | Estudos | um de plano de estudos e revisão; um de resumos e fichamento | estudos |
| `programacao` | Programação | um que escreve código; um que revisa e testa | programacao, trabalho |
| `pesquisa_escrita` | Pesquisa e escrita | um pesquisador; um redator e revisor de texto | pesquisa_escrita, trabalho |
| `trabalho_autonomo` | Trabalho por conta própria | um de clientes e propostas; um de pendências e prazos | trabalho |
| `casa` | Casa | um de compras e tarefas da casa; um de contas a lembrar (só lembretes e listas, sem acesso a finanças) | casa, dia_a_dia |

Cada agente de time traz instruções completas (como trabalha, o que nunca
faz sem perguntar, como usa as ferramentas liberadas, jeito de falar simples)
e três sugestões de primeiro pedido.

## 6. Criar pela conversa (a Seraphine monta o time)

`POST /agents/guide/propose` (token do dono), corpo:

```json
{ "text": "preciso de ajuda com as contas da casa e com meus estudos de inglês",
  "previous": { "agents": [ <rascunho>, ... ] },
  "areas": ["casa", "estudos"] }
```

- `text`: 1 a 2.000 caracteres (o pedido, ou o ajuste quando há `previous`).
- `previous`: opcional; a proposta anterior, para o dono ajustar ("troque o
  nome", "junte os dois", "quero mais um para pesquisa").
- `areas`: opcional.

Resposta: `{ "proposal": { "say": "<uma ou duas frases da Seraphine>", "agents": [ <rascunho>, ... ] } }`.

- O backend faz **uma chamada ao cérebro configurado da Seraphine** pedindo só
  JSON, lê com tolerância, e **valida e normaliza** tudo: de 1 a 5 agentes;
  campos cortados nos limites; `grants` rebaixados ao teto; `perm_edit` só os
  valores aceitos; qualquer campo desconhecido é descartado; `engine`,
  `provider` e `model` vindos do modelo são ignorados.
- O pedido do dono e a proposta anterior entram marcados como dado, e a
  instrução ao modelo diz para só propor o que a regra 5 permite.
- Os nomes dos agentes que já existem vão junto, também como dado, para a
  proposta não repetir um deles (acrescentado depois da conferência ao vivo).
- Nada é criado por esta rota.
- Erros: 503 `guide_unavailable` (o cérebro não respondeu ou não devolveu uma
  proposta válida depois de uma segunda tentativa; `detail` em pt-BR sugere
  escolher um time pronto); 409 `guide_busy` (já há uma proposta em
  andamento); 422 corpo inválido. Limite de 90 segundos.

## 7. Criar o time

`POST /agents/team` (token do dono), corpo:

```json
{ "origin": "pack:dia_em_ordem",
  "agents": [ <rascunho>, ... ] }
```

- `origin`: `"pack:<id existente>"` ou `"guide"`.
- `agents`: 1 a 6 rascunhos (a tela pode ter editado nome, papel e descrição).

Para cada rascunho, em ordem e **cada um à parte** (uma falha não desfaz os
anteriores nem impede os seguintes): cria o agente (motor do rascunho ou o
`default_engine`; se nenhum dos dois existir, `claude_code` com `anthropic`),
aplica o acesso (com o teto), cria a casa.

Resposta 200:

```json
{ "created": [ { "def": <agente>, "home": <projeto> } ],
  "failed":  [ { "name": "…", "detail": "<pt-BR>" } ],
  "lowered": [ { "name": "…", "group": "memory", "asked": "read", "got": "none" } ] }
```

**Nome repetido:** um rascunho cujo nome já é o de um agente existente (sem
diferenciar maiúsculas, espaços das pontas ignorados) não é criado e entra em
`failed` com o `detail` "Já existe um agente com esse nome.". Isso também
evita criar o time duas vezes por um clique repetido.

Um agente cujo motor não está pronto é criado mesmo assim (a primeira
mensagem para ele estaciona com o motivo de login ou credencial, como já
acontece). Erros de corpo: 422. Se todos falharem, ainda responde 200 com
`created` vazio.

## 8. Tela

### 8.1 Primeiros passos (tela `setup`)

Abre sozinha quando o harness está pronto, não há nenhum agente e
`dismissed` é falso. Também abre pela linha "Continue de onde parou" do
Início. Três passos, com trilho à esquerda ("Faltam N etapas", "x de 3" e
barra de progresso), conteúdo no centro, **prévia** à direita e a frase da
Seraphine embaixo do trilho.

1. **"Com o que você quer ajuda?"** Fichas de escolha múltipla com as sete
   áreas; "Continuar" grava `areas`; "Pular esta etapa" grava
   `areas_skipped`.
2. **"Conectar um motor"**: uma linha por opção, na ordem: plano do Claude
   (Claude Code), plano do ChatGPT (Codex), modelos locais, chaves de API.
   Cada linha: nome, estado em chip com ícone e palavra ("Pronto", "Não
   conectado", "Falta a chave", "Sem resposta"), a frase `how` quando não
   está pronto, e "Testar" nas duas primeiras. O dono escolhe o **motor
   padrão** entre os prontos (o primeiro pronto vem marcado); "Continuar"
   grava `default_engine`; "Conectar depois" segue sem gravar. Aviso de uma
   linha: agentes que só conversam não usam as ferramentas da Seraphine.
3. **"Seus agentes"**: o diálogo da seção 8.2, embutido.

A prévia à direita mostra como o espaço vai ficar: a lista de agentes que
serão criados (vazia com um texto de espera nos dois primeiros passos; no
passo 3, os agentes do time escolhido ou da proposta).

"Agora não" (no cabeçalho) grava `dismissed` e leva ao Início.

### 8.2 Diálogo "Seus agentes"

Também abre por "Criar agente" na barra lateral e por "Novo agente" no elenco.
Dois painéis (abaixo de 960 px, dois passos):

- **Esquerda:** os times prontos (os das áreas escolhidas primeiro), depois
  "Nenhum desses: conte do que você precisa", e os atalhos "Criar um agente
  do zero" (abre o formulário atual em branco).
- **Direita, time escolhido:** nome e frase do time; um cartão por agente
  (nome, papel, descrição; nome, papel e descrição editáveis no lugar); a
  linha "Cada agente ganha uma pasta própria em {home_dir}"; a nota de
  aprovação ("Todo comando que um agente quiser rodar espera a sua
  aprovação."); o motor que vão usar (o padrão, com chip de estado); o botão
  "Criar meus agentes"; rodapé "N agentes".
- **Direita, "conte do que você precisa":** caixa de texto e "Montar meu
  time"; enquanto espera, estado "A Seraphine está montando…"; depois, a
  frase `say`, os mesmos cartões editáveis, uma caixa "Quer mudar algo?"
  (manda `previous`) e "Criar meus agentes". Erro 503: aviso com a sugestão
  de escolher um time pronto, sem perder o texto digitado.

Depois de criar: se algo falhou, o diálogo mostra o que foi criado e o que
falhou (com o motivo) antes de fechar; senão fecha e abre a conversa do
primeiro agente criado.

### 8.3 Conversa do agente

- Clicar num agente na barra lateral abre a **conversa dele** (garante a casa
  com `POST /agents/defs/{id}/home` e navega para ela). O cabeçalho mostra o
  agente (nome, papel, estado do motor) e um botão "Ajustar" que abre o
  formulário do agente no elenco.
- Na conversa de uma casa, o compositor não mostra o seletor "quem responde"
  (é sempre o dono da casa) e o texto de apoio usa o nome do agente.
- Conversa vazia: "Diga oi para {nome}" e as `suggestions` como botões que
  preenchem o compositor (não enviam sozinhos).
- Casas não aparecem na lista PROJETOS (barra lateral e Início).
- Agente cujo motor não está pronto: chip "Sem motor" ao lado do nome na
  barra lateral e no cabeçalho da conversa, com a frase `how`.

### 8.4 Início

Enquanto `done < total` e `dismissed` é falso: uma linha "Continue de onde
parou · {done} de {total}" no topo, que abre os primeiros passos, com as
quatro linhas do checklist (chip com ícone e palavra: "Feito" ou "Falta") e
"Agora não". Quando tudo está feito, a linha some.

## 9. Fora desta etapa (registrado no plano)

Rotinas dos agentes e rotinas dentro dos times (6b); ajustar agentes e
rotinas conversando com a Seraphine depois de criados (6b); página do agente
com checklist próprio, pausar, arquivar e histórico de instruções (6c);
configurações do espaço ("IA e uso", "Ferramentas e acesso") (6c); cofre de
chaves e conectores MCP externos (fase 9); importar agentes de outro app;
dispositivos (a Seraphine roda num PC só).

## Códigos novos

`home_unavailable`, `home_managed`, `guide_unavailable`, `guide_busy`.

## Configuração nova (backend)

`agents_home_dir` (padrão `<pasta do usuário>/Seraphine/agentes`),
`agents_guide_timeout_s` (90), `agents_team_max` (6).
