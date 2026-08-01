# Mobile v3 — 10 telas novas + orçamento de custo

**Data:** 2026-08-01
**Handoff:** `apps/seraphine/frontend/handoff_mobile_v3/Seraphine Mobile.dc.html` (30 frames; os 10 novos começam em "Configurações") + `README.md`
**Antecessor:** onda `2026-07-31-mobile-fases2-5` (20 telas, widget, notificação) — mergeada em `main`

---

## Objetivo

Completar o app iOS com as 10 telas que o handoff v3 acrescenta, construir o orçamento mensal de custo que duas delas exigem, e corrigir duas divergências entre o que o app mostra e o que o sistema faz.

Não é redesenho: as 20 telas anteriores ficam como estão. Tokens, moldura e padrões iOS do handoff original continuam valendo sem alteração.

---

## Princípio herdado, e ele é o mais importante

A onda anterior estabeleceu uma regra que se provou em ~25 reviews: **nada renderiza um valor que o dado não sustenta, e nada falha em silêncio.** Toda tela cobre três estados distintos — dado, vazio e erro — e o carregamento é esqueleto sem texto.

O handoff v3 já foi escrito nesse espírito (ele mesmo marca o que é proposta, e diz "não inventar preços"), então a regra segue binding em toda tela nova.

Um corolário que vale explicitar, porque estas telas são sobre dinheiro: **um custo exibido errado é pior que um custo ausente.** Uma tela de gastos que mostra número inventado corrói a confiança em todo o resto do app.

---

## Arquitetura

Igual à onda anterior, que sobreviveu a 16 agentes em paralelo sem uma colisão de seletor:

- Telas em `src/mobile/screens/<Nome>Screen.tsx`, com `.css` próprio de prefixo único e teste próprio.
- Entrada em `src/mobile/screens/registry.ts` (`ScreenKey` + `SCREENS` lazy).
- Consumo das camadas de api existentes — **nunca `fetch` ou `API_BASE` direto na tela**.
- Zero emoji: ícones inline de `src/icons/Icons.tsx`.
- Nada pode `return null`.

### Uma exceção deliberada: `MobileSheet`

Os três modais (nova tarefa, novo evento, nova memória) compartilham moldura idêntica: raio 28 no topo, grabber 38×4, backdrop `rgba(0,0,0,.55)` + blur 3px, padding inferior 34 (home indicator).

A regra da onda 2 era "arquivos próprios, nada compartilhado", e o review final registrou a duplicação resultante como o preço do paralelismo — 16 `@keyframes` idênticos sob 16 nomes, texto de erro repetido 26 vezes. Triplicar a moldura de sheet repetiria o erro sabendo dele.

**Decisão:** um `src/mobile/MobileSheet.tsx` + `.css`, com o conteúdo de cada modal em arquivo próprio. É a única peça compartilhada nova desta onda.

### Modais não são telas de registry

São sobreposições sobre a tela atual, com estado no componente que as abre. O handoff os desenha como frames inteiros porque a moldura de iPhone é o formato do mockup, não porque sejam rotas.

Isso importa por precedente: na onda anterior, rotear pela registry **descartava silenciosamente** callbacks que o shell não repassa (`PhoneShell` monta só `id/onBack/onOpen/onDone`). Um modal com autosave roteado pela registry perderia o handler de salvar sem erro de tipo.

---

## As 10 telas

### 1. Configurações (uma tela rolável; o handoff divide em dois frames por altura)

Perfil (orb 46px, nome, "Sincronizado com o Mac", chevron) + grupos.

| Grupo | Linhas | Fonte do dado |
|---|---|---|
| ASSISTENTE | Wake word · Responder com voz · Pensar antes de responder · Personalidade · Modelo | `realtimeStore`, `chat_model` via `/deepsearch/chat-model` |
| NOTIFICAÇÕES | Lembretes · Streak em risco · Não perturbe | a definir (ver Propostas) |
| CONEXÕES | Google Agenda · WhatsApp · YouTube Music | status real de cada integração |
| DADOS | Memória (N itens) · Apagar histórico | `memory/api.ts` |

**Correções ao README do handoff, verificadas no código:**

- O README diz que "Modelo" é proposta porque a troca só existiria no Research. **Não é mais.** `src/settings/ChatModelPanel.tsx` já é a preferência global do chat, via `GET`/`PUT /deepsearch/chat-model`. A tela mobile espelha o que existe.
- O rodapé "Seraphine 2.4.0 · iOS" é literal do mockup. A versão real sai de `tauri.conf.json` (hoje 0.2.1) — ler, não escrever.
- Toda linha cujo dado não existe deve mostrar estado honesto, não um valor plausível.

### 2. Trilhas · lista

Espelha `src/courses/TrilhasView.tsx` (178 linhas). Consome `courses/api.ts`.

Header com pills de XP e streak; card de criar trilha; cards de curso nos três estados reais — `em andamento` (barra de progresso), `gerando…` (badge âmbar pulsando, **poll de 4s**), `concluída` (opacity .65).

O estado `gerando…` é o que exige cuidado: a geração de curso leva minutos (o backend faz deepsearch + N lições). A barra a 35% do mockup é decorativa — **não afirmar progresso que a API não reporta.** Se a api só diz "gerando", a barra é indeterminada.

### 3. Planejamento

Espelha o Planejamento do desktop. Timeline com coluna de hora e blocos com `border-left` na cor da categoria; bloco de foco sugerido com borda tracejada; seção "A ENCAIXAR" com chips arrastáveis; CTA "Aceitar plano".

Arrastar em iOS exige cuidado com o scroll da tela — decisão de implementação, mas o comportamento tem que ser testável sem gesto real.

### 4–6. Os três modais

**Nova tarefa** — adaptação fiel de `src/tasks/TaskEditorModal.tsx` (496 linhas), que deve ser lido antes.
- **Autosave**, não Cancelar/Salvar: `PATCH /tasks/:id` com debounce de 800ms, rodapé mostrando `salvando… / salvo / erro ao salvar`.
- Status (4 valores com cor), Prioridade (3), Categoria (taxonomia de finanças, sem emoji), Data + hora, Lembrete (4 opções), Tags (chips com Enter/vírgula para adicionar, Backspace vazio remove a última), Descrição.
- Lixeira com confirmação Sim/Não.

O rodapé de autosave é o ponto onde a regra da onda se aplica com mais força: `erro ao salvar` tem que aparecer de verdade. Um autosave que falha em silêncio faz o usuário perder trabalho achando que salvou.

**Novo evento** — tem Cancelar/Salvar porque é criação, não edição. Dia inteiro (toggle), Início/Fim, Local, Repetir, e a taxonomia real de calendário do `CalendarView` (Agenda `#42a5f5` · Finanças `#66bb6a` · Tarefas `#9a93ff` · Lembretes `#ffa726` · Outros `#78909c`).

**Nova memória** — dica em accent-soft, campo livre, categoria (as mesmas da tela Memória) e confiança Alta/Média/Baixa com ponto colorido.

### 7. Seletor de modelo

Adaptação do `<select>` de `ChatModelPanel.tsx` para toque: com 300+ opções de OpenRouter, um `<select>` nativo é inviável no celular.

Busca no topo; card destacado do Padrão (cliproxy) com selo **"flat $0 · sem custo por chamada"**; lista OpenRouter agrupada por provedor com selo **medido**.

**Os rótulos vêm verbatim do backend.** `GET /deepsearch/models` devolve ids **já prefixados** (`openrouter:<id>`) — prefixar de novo foi o bug de produção de 2026-07-31, que gravava `openrouter:openrouter:...` e derrubava o chat inteiro com 400. A tela usa `m.id` como está.

Não inventar preços por modelo: a api não os expõe.

### 8–9. Custos & Energia (duas telas: visão geral e detalhe)

Adaptação de `src/telemetry/TelemetryView.tsx` (402 linhas) + `telemetry/api.ts`.

Fontes verificadas respondendo em produção:
- `GET /telemetry/summary?days=7|30` → `{days, total{input_tokens,output_tokens,cost_usd,calls}, by_model[], by_feature[], by_backend[]}`
- `GET /llm/engine`
- energia via comando Tauri `read_power` (`src-tauri/src/telemetry.rs`)

**Visão geral:** hero dourado com o custo medido do período (pt-BR, vírgula; sub-centavo com 4 casas — o backend já devolve 6 desde 2026-07-31), barra flat vs medido, tiles de tokens e chamadas, e o motor de inferência.

**Detalhe:** por funcionalidade (colunas verticais, maior gasto em âmbar), por modelo (barras horizontais; quando todo o período é flat, ordenar por volume de chamadas), e os três medidores de energia em W. Sem suporte a energia → mensagem explícita, não um zero.

---

## Trabalho de backend

### Orçamento mensal (novo)

O teto e a projeção do handoff não existem hoje. Serão construídos:

- Migração no schema de telemetria com o orçamento mensal em USD.
- `GET /telemetry/budget` e `PUT /telemetry/budget`.
- O `summary` passa a expor o teto para a tela calcular percentual, dias restantes e projeção **sobre dado real** em vez de estimar no cliente.

Sem orçamento configurado, a tela não mostra barra de teto — mostra o convite a definir um.

### `FLAT_BACKENDS` como fonte única

Divergência real, hoje em produção:

| onde | valor |
|---|---|
| `backend/seraphine/telemetry/pricing.py:15` | `{cliproxy, claude_max}` |
| `frontend/src/telemetry/TelemetryView.tsx:30` | `{cliproxy, claude_max, ollama, local}` |

Consequência: uma chamada `ollama` ou `local` é **gravada** com custo de nuvem inventado (o default conservador de 3/15 USD por milhão) e **exibida** como flat. O total e a barra discordam, e as telas novas herdariam isso.

**Decisão:** o backend é o dono — ele precifica. Expõe a lista, o front consome, e um teste trava a paridade entre os dois lados.

---

## Os dois bugs (dentro desta onda, por decisão)

### Frase do wake word

`src/mobile/screens/ChatScreen.tsx:288` mostra `ouvindo "oi Sera"`, e o handoff v3 repete isso nas Configurações. O modelo embarcado em 2026-08-01 foi treinado em **"Ei Seraphine"** (`ei_seraphine_v9.onnx`, limiar 0.92).

Quem disser "oi Sera" não aciona nada. Corrigir toda ocorrência visível ao usuário para a frase real, e travar com teste — a string é contrato com o modelo, não texto de UI.

### Divergência de `FLAT_BACKENDS`

Acima.

---

## Propostas do handoff — resolução

| Item | Decisão |
|---|---|
| Teto do mês / projeção | **Construir**, backend incluído (decidido) |
| Modelo nas Configurações | **Já existe** — espelhar `ChatModelPanel`, não é proposta |
| Personalidade | Só entra com efeito real no comportamento; caso contrário, fora |
| Não perturbe | Só entra se silenciar notificação de verdade; caso contrário, fora |
| Slot "Sincronizado com o Mac" | Só com timestamp real de sincronização |

O critério é o mesmo em todos: um controle que não faz nada é pior que um controle ausente, porque promete.

---

## Testes

Herdado da onda anterior, onde a prática pegou defeitos reais:

- **RED primeiro** em toda task.
- **Mutação obrigatória**: alterar a implementação e mostrar qual teste cai. Um teste que passa com a lógica desligada não conta — na onda anterior isso pegou dois testes de filtro que passavam com o filtro desativado.
- **Três estados por tela** (dado, vazio, erro), com o vazio afirmando que **não** é erro.
- Ausência é afirmada, não omitida: um teste que simplesmente não verifica um elemento não é o mesmo que um que verifica sua ausência.

Restrições de ambiente, pré-existentes e não são achados: `pnpm test` completo trava em `src/App.test.tsx` (WebGL); `pnpm lint` não roda (`@eslint/js` ausente); o vitest coleta 5 specs Playwright de `e2e/` como falha.

---

## Riscos

**O maior é o de dinheiro.** Duas telas exibem gasto, e a divergência de `FLAT_BACKENDS` prova que já erramos nisso. A correção da fonte única precisa vir **antes** das telas de Custos, não depois.

**Autosave sem rede.** O modal de tarefa salva sozinho; sem conexão, o estado tem que ser visível, não otimista.

**Poll de 4s em Trilhas.** Deixar de cancelar ao desmontar é vazamento — a onda anterior encontrou exatamente essa classe de bug no `RealtimeController`, onde o microfone seguia ligado após sair da tela.

**Sheet e teclado no iOS.** Os três modais têm campos de texto; o teclado sobrepondo o rodapé de autosave esconde justamente o indicador de erro.
