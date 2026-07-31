# Seraphine Mobile — Fases 2-5 + widget nativo

**Data:** 2026-07-31
**Handoff:** `apps/seraphine/frontend/handoff_mobile 2/` (`README.md` + `Seraphine Mobile.dc.html`, 20 telas)
**Continua:** `docs/superpowers/specs/2026-07-13-mobile-fase1-fundacao-design.md`

## Problema

A Fase 1 entregou a fundação: shell phone com tab bar, orb, safe areas, navegação empurrada, e as telas **Hoje** e **Mais** nativas. Por decisão explícita daquela fase, as demais abas abrem **as views de desktop dentro do shell de telefone** — estado interino, para o app funcionar desde o dia 1.

É esse estado interino que hoje se lê como "telas quebradas": Tarefas aparece espremida a ~10% da largura (é o master-detail do desktop), o calendário corta o mês no dia 18 (grade estourando), e Trilhas, Diário e Memória idem. Não são bugs independentes — é `PhoneShell.tsx` montando componente de desktop:

```tsx
{tab === 'tarefas' && <TasksView … />}      // desktop
{tab === 'trilhas' && <TrilhasView … />}    // desktop
case 'calendario':  <CalendarView …/>       // desktop
```

Esta spec cobre o restante do roadmap num único ciclo: **Fases 2, 3, 4 e 5** mais o **widget nativo** que a Fase 1 tinha deixado fora.

## O que a investigação de hoje estabeleceu

Antes de tratar tudo como redesenho, medi o que de fato falha:

1. **As oito telas "quebradas" são a Fase 1 por desenho**, não regressão. Nada a consertar nelas — elas serão substituídas por telas mobile próprias.
2. **A tela Hoje é caso separado.** Ela é mobile-nativa e mesmo assim mostra só hábitos. Testando os endpoints em produção:

   | Bloco | Endpoint | Resultado |
   |---|---|---|
   | Seraphine sugere | `/notifications/queue` | `{"queue":[],"count":0}` — vazio de verdade |
   | Agenda | `/calendar/aggregate` (hoje) | `tasks: []`, `habits: []` — vazio de verdade |
   | Tarefas | `/tasks?limit=200` | **tem dados** |
   | Orçamento | `/finance/entries` | **tem dados** |

   Dois blocos somem porque o dia está vazio; dois somem apesar de haver dado. O primeiro caso é **falta de estado vazio desenhado**; o segundo é **bug de filtro** a ser encontrado na implementação.
3. **`useFetchJson` engole erro** (`.catch(() => {})`, `HojeScreen.tsx:42`) e a falha vira tela vazia silenciosa — indistinguível de "não há dados". Isso mascara os dois casos acima.

## Decisões (brainstorm de hoje)

| Questão | Decisão |
|---|---|
| Recorte | **Tudo num plano só** (Fases 2-5 + nativo). Registrado: o review fica mais raso que o ideal em 20 telas; risco aceito pelo autor. |
| Telas nativas | **Dentro do escopo** — widget WidgetKit e notificação rica com ações. Reverte a exclusão da Fase 1. |
| Dados | **Reais em todas as telas.** Nada de dado de exemplo. |
| Arquitetura | **Opção A** — telas mobile próprias em `src/mobile/`, consumindo camada de dados extraída e compartilhada com o desktop. |
| Execução | **Em ondas, com tasks paralelas dentro de cada onda.** Exige as duas mudanças abaixo. |

### Duas mudanças que o paralelismo exige

Sem elas, toda task de tela tocaria os mesmos dois arquivos e os agentes conflitariam:

1. **CSS por tela** — cada tela tem `mobile/screens/<Tela>.css`. O `mobile/obsidian.css` compartilhado fica só com o que é de fato comum (orb, card, eyebrow, animações, layout do shell). Elimina o conflito e é melhor estrutura de qualquer forma.
2. **Scaffolding único na onda 0** — uma task registra as 19 telas no `PhoneShell.tsx` de uma vez, apontando para placeholders. Depois disso, cada task de tela substitui **só o próprio arquivo** e ninguém mais toca no shell.

Ondas: **0** fundação (sequencial) → **1** as cinco camadas de dados (paralelo) → **2** as telas (paralelo, cada uma esperando seu `api.ts`) → **3** nativo (paralelo com tudo, é Swift) → **4** integração no simulador (sequencial).

Registrado: o review continua sequencial, passando pelo autor. O ganho do paralelismo é de relógio na escrita, não no esforço total.

Opções descartadas, com o motivo: **responsivo nos componentes de desktop** (o handoff pede outra estrutura — mapa serpenteado em SVG, headers com orb, tab bar com orb elevado, telas empurradas; CSS não transforma um master-detail nisso, e cada mexida arrisca o app do Mac); **duplicar o fetch no mobile** (duas cópias de cada chamada divergem, e uma mudança de backend quebra o mobile em silêncio).

## Arquitetura

```
src/
  mobile/                        já existe (Fase 1)
    obsidian.css                 orb, cards, animações, layout sob html[data-shell='phone']
    PhoneShell.tsx  TabBar.tsx  PushedScreen.tsx  Orb.tsx
    HojeScreen.tsx  MaisScreen.tsx  ChatTab.tsx
    screens/                     NOVO — uma tela por arquivo
      ChatScreen.tsx  VozScreen.tsx  TarefasScreen.tsx  TrilhasMapaScreen.tsx
      FinancasScreen.tsx  HabitosScreen.tsx  DiarioScreen.tsx  InboxScreen.tsx
      LicaoTeoriaScreen.tsx  LicaoExercicioScreen.tsx  WhatsAppThreadScreen.tsx
      MemoriaScreen.tsx  CalendarioScreen.tsx  InsightsScreen.tsx
      OnboardingBoasVindasScreen.tsx  OnboardingPermissoesScreen.tsx
      ChatVazioScreen.tsx
    components/                  NOVO — só o que repete entre telas
      SugereCard.tsx  Eyebrow.tsx  StatCard.tsx  CategoriaChip.tsx
  <modulo>/api.ts                NOVO por módulo — camada de dados extraída
```

**Regra de fronteira:** uma tela mobile nunca chama `fetch` direto. Ela consome `<modulo>/api.ts`. É o formato que `habits/` já tem (`api.ts` + `types.ts`) e que os outros módulos vão ganhar.

**Duas telas substituem código da Fase 1, não convivem com ele:**

- `ChatScreen.tsx` **substitui** o `ChatTab.tsx` atual, que hoje só embrulha o `ChatView` de desktop. O `ChatTab.tsx` é removido na mesma task.
- `VozScreen.tsx` é **interface nova sobre o pipeline de realtime que já existe** (`realtime/RealtimeController`), não um motor de voz novo. Ela desenha o estado (pill "ao vivo", timer, orb com anéis, transcrição, waveform, controles) e comanda o controller existente. Nenhuma mudança no áudio, no VPIO ou no wake word.

### Extração da camada de dados

O fetch hoje mora dentro de views enormes. Para cada módulo abaixo, o fetch e as mutações saem para `<modulo>/api.ts` (funções puras que devolvem tipos de `types.ts`), e **a view de desktop passa a importar dessa camada** — sem mudança visual no desktop.

Inventário verificado no código (não presumido):

| Já tem `api.ts` | Precisa extrair |
|---|---|
| `habits/` · `journal/` · `courses/` · `insights/` · `notes/` · `mood/` | `tasks/` (1561 linhas) · `calendar/` (1734) · `memory/` (1194) · `finance/` · `inbox/` |

São **cinco** extrações, em cinco diretórios disjuntos. Cada uma extrai **apenas o que a tela mobile daquele módulo consome** — a task da tela nomeia as funções antes de escrevê-las. `habits/api.ts` é o modelo de formato.

Nota sobre `tasks/`: a `TasksView` também busca finanças, recorrências e lembretes — é parte do porquê das 1561 linhas. A extração cobre **só a parte de tarefas**; o resto fica onde está.

Essa extração é o principal risco de regressão no desktop e por isso cada uma é task própria, com os testes da view rodando antes e depois.

### Telas empurradas

`PushedScreen` já existe. As telas 11-16 do handoff (Lição teoria, Lição exercício, WhatsApp thread, Memória, Calendário, Insights) usam header com voltar e **sem tab bar** — comportamento que o `PushedScreen` da Fase 1 já implementa.

### Widget nativo (tela 20)

Fora do webview, e por isso a parte mais cara do plano:

- **Target novo no Xcode:** extensão WidgetKit em Swift, dentro de `src-tauri/gen/apple`. O `project.yml` do Tauri regenera o projeto — a extensão precisa sobreviver a isso, então entra como target versionado, não como edição manual do `.xcodeproj`.
- **App Group** compartilhado entre app e extensão, para o widget ler agenda/streak/XP sem rede.
- **Escrita do snapshot:** o app grava um JSON no container do App Group a cada sync; o widget lê. Sem chamada de rede na extensão.
- **Notificação rica:** `UNNotificationCategory` com as ações "Marcar pago" e "Adiar 1h", tratadas no app.
- Widget e notificação **não** têm equivalente em web — não há como validá-los no Chrome; só no simulador/dispositivo.

## Inventário das 20 telas

Cada task do plano abre o trecho correspondente em `Seraphine Mobile.dc.html` (o arquivo é export de ferramenta de design, com estilos inline e sem classes — as telas se localizam pelo rótulo, ex. `Trilhas · mapa` na linha 194).

**Núcleo, com tab bar (1-10):** Hoje¹ · Chat · Voz · Tarefas · Trilhas mapa · Finanças · Hábitos · Diário · Inbox · Mais¹
**Empurradas (11-16):** Lição teoria · Lição exercício · WhatsApp thread · Memória · Calendário · Insights
**Experiência (17-20):** Onboarding boas-vindas · Onboarding permissões · Estado vazio do chat · Lock screen (nativo)

O onboarding aparece **no primeiro uso** (flag persistida localmente) e os botões de permissão chamam as pontes Swift que já existem — microfone e notificações têm caminho pronto; calendário exige verificar se o bridge existe antes de prometer o botão. O "Já uso no Mac — sincronizar" da tela 17 aponta para o backend que ambas as plataformas já compartilham, sem pareamento novo.

¹ Hoje e Mais existem da Fase 1; entram para acertar estados vazios e o bug de filtro, não para reconstrução.

## Estados vazios

Requisito explícito, vindo do diagnóstico: **nenhum bloco pode sumir por falta de dado.** Todo bloco de conteúdo tem estado vazio desenhado conforme o handoff. Um dia sem compromissos deve dizer que não há compromissos, não deixar um buraco que se lê como tela quebrada.

Igualmente: `useFetchJson` passa a distinguir **erro** de **vazio**, e o erro aparece na interface. Falha de rede silenciosa foi o que mascarou o problema do Hoje.

## Testes

- **Unit (vitest):** helpers puros (formatação, agrupamento, cálculo de progresso) e smoke render de cada tela com dados de exemplo — que a tela monta sem quebrar, e que o estado vazio aparece quando a lista está vazia.
- **Camada de dados:** cada `api.ts` extraído ganha teste com `fetch` mockado, cobrindo o caminho feliz e o erro. É o contrato que desktop e mobile passam a compartilhar.
- **Regressão de desktop:** para cada módulo extraído, a suíte existente daquela view roda antes e depois. Nenhuma mudança visual no desktop é aceitável.
- **`pnpm exec tsc --noEmit` limpo** e zero emoji (o projeto usa SVG inline; a regra vale para as telas novas).
- **Manual:** `pnpm tauri ios dev` no simulador para safe areas reais; o Chrome em viewport de iPhone serve para iterar rápido, mas não substitui o simulador.
- **Nativo:** widget e notificação só no simulador/dispositivo — sem cobertura automatizada.

## Fora de escopo

- Wake word no iOS (segue fora, como na Fase 1).
- Remoção do `MobileShell.tsx` legado (238 linhas, órfão, ninguém monta) — continua adiada para não misturar limpeza com entrega.
- Mudança visual no desktop. A extração de dados é refatoração interna; se o desktop mudar de aparência, é bug.
- Backend novo. Todas as telas consomem endpoints que já existem.

## Riscos

1. **Extrair dados de views de 1.500 linhas** é onde mora a chance de quebrar o app do Mac. Mitigação: uma task por módulo, testes da view antes e depois.
2. **O widget nativo é outro ofício** (Swift, App Group, target no Xcode) e a regeneração do projeto pelo Tauri pode apagá-lo se ele for adicionado à mão. Mitigação: tratar como target versionado desde a primeira task.
3. **20 telas num plano só** deixa o review raso — decisão consciente do autor, registrada aqui para o review final saber que não foi descuido.
