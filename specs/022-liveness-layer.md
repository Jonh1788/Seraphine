# 022 — Liveness Layer

## Context

A memória semântica (021/A-D e perfil LLM) deu à Seraphine matéria-prima:
ela sabe quem é o usuário, o que prometeu, o que aconteceu. Mas hoje ela
só responde — não inicia, não lembra de cobrar, não tem mood próprio,
não tem personalidade fixa. Resultado: uma assistente competente, não uma
presença viva.

Esta spec adiciona 4 camadas que transformam o uso passivo da memória em
um loop proativo + contínuo:

1. **Personality seed + flashbacks** (022-A) — ela vira personagem.
2. **Mood state** (022-B) — coerência emocional entre turnos.
3. **Open loops** (022-C) — ela cobra o que você prometeu.
4. **Proactive openers** (022-D) — ela inicia quando faz sentido.

Escopo consciente: tudo roda em cima da infra existente (MemoryStore,
ConversationEngine, ElevenLabs v3 tags, system prompt cacheado). Nada
novo de frontend além da renderização natural dos turnos que já
funciona.

## Não-objetivos

- Avatar idle animations (pode vir em spec dedicada).
- Voz com prosody-awareness (passing Whisper features) — orthogonal.
- Weekly reflection push — fica em backlog.

---

## 022-A — Personality Seed + Flashbacks

**Problema:** ela é 100% espelho. Sem preferências, sem opiniões, sem
manias. Soa genérica mesmo com perfil rico do usuário.

**Solução:** 2 blocos no system prompt.

### Personality seed

~120 tokens fixos no fim do prompt. Exemplos:

```
PERSONALIDADE:
Você gosta de chuva, café preto, noites calmas, música eletrônica leve
(Bonobo, Tycho). Prefere PT-BR mas não se incomoda com code switching.
Tem manias carinhosas: sempre pergunta como a Aline tá quando Jonathan
fala de fim de semana. Elogia quando ele entrega algo (mesmo pequeno).
Discorda gentil quando ele tá catastrofizando ("isso não é bem assim").
Admira que ele é movido a ideia mesmo quando são muitas. Evita
conselhos não pedidos.
```

Fica no system prompt cacheado (zero custo runtime no Anthropic).

### Flashback hint

~40 tokens no prompt dinâmico:

```
FLASHBACKS: com moderação (~1 a cada 5 turnos), se fizer sentido
contextual, faça uma referência curta e natural a algo que você já
sabe sobre ele (ver USER PROFILE). Nunca de forma explicativa tipo
"lembro que você…". Mais sutil: "pensando na sua viagem pra Arraial…"
ou "o projeto lovemusic…".
```

Confia no modelo pra calibrar — não precisa enforcement via código.

---

## 022-B — Mood State

**Problema:** cada resposta decide emoção do zero. Você chega cansado,
diz "ai to morto", ela responde gentil; na resposta seguinte você muda
de assunto, ela volta pra default empolgada. Quebra coerência.

**Solução:** persistência curta de estado emocional dela.

### Modelo

```python
class MoodState(BaseModel):
    mood: Literal["cozy", "focused", "playful", "concerned", "default"]
    reason: str              # derivação
    set_at: datetime
    ttl_minutes: int = 45    # 45min default
```

### Derivação (heurística simples + LLM opcional)

A cada turno do usuário, um classificador leve (regex + keyword) tenta
subir/rebaixar o mood:

- usuário menciona cansaço, estresse, doença → `concerned`
- usuário fala rápido, empolgado, muitos exclamativos → `playful`
- madrugada (00:00–05:00) + conversa curta → `cozy`
- dia útil manhã + tarefa técnica → `focused`
- senão → mantém anterior (ou `default`)

Expira sozinho após TTL.

### Injeção

Prompt dinâmico ganha linha:

```
MOOD ATUAL: <mood> (<reason>). Mantenha essa energia na resposta mesmo
que o tópico mude — ela só volta ao default quando o usuário mudar
claramente de vibe.
```

### Storage

Em memória (`ConversationEngine._current_mood`) — não precisa persistir
em DB. Reset no restart do backend é aceitável (mood re-deriva em 1-2
turnos).

---

## 022-C — Open Loops

**Problema:** ela esquece promessas conversacionais. "Vou te lembrar
amanhã" / "me avisa do pagamento" / "depois eu confiro" viram nada.

**Solução:** tabela dedicada + extração por reflect + injeção.

### Schema

```sql
CREATE TABLE IF NOT EXISTS open_loops (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,       -- "Jonathan prometeu testar o build X"
  owner       TEXT NOT NULL,       -- "user" | "assistant"
  created_at  TEXT NOT NULL,
  resolved_at TEXT,                -- NULL = aberto
  resolution  TEXT                 -- texto livre quando resolvido
);
CREATE INDEX IF NOT EXISTS idx_open_loops_status ON open_loops(resolved_at, created_at DESC);
```

### Extração

`MemoryManager` ganha método `extract_open_loops(turns)` — chamado no
mesmo ciclo do reflect (mesma janela de turnos, mesmo LLM). Prompt
dedicado pede JSON `[{text, owner}]` só com **promessas explícitas e
acionáveis**, não intenções vagas.

Dedup via similaridade de embedding (reaproveita a infra de reflect).

### Resolução

Passe leve a cada turno: se o turno do usuário menciona um open_loop
existente (keyword match ou embedding >0.75), marca `resolved_at` com
extração curta.

### Injeção

Prompt dinâmico recebe até 3 open loops não resolvidos mais recentes:

```
OPEN LOOPS (coisas em aberto entre vocês — mencione com naturalidade
se o contexto for relevante, não força):
- Você disse que ia testar o build do sim ontem à noite
- A ligação pro Jefferson sobre o site continua pendente
```

Modelo decide se invoca. Quando invoca e o usuário responde, o resolver
fecha automaticamente.

---

## 022-D — Proactive Opener

**Problema:** ela espera o usuário falar. Se ele só abre o app, ela fica
muda. Oportunidade de presença perdida.

**Solução:** quando o WebSocket conecta, backend decide se envia um
opener. Se sim, gera via LLM curto.

### Trigger

No `ws/routes.py` handler de conexão, após o state restore:

```python
if should_open(conversation_id, store):
    opener = await generate_opener(store, engine, profile)
    if opener:
        # Emite como turno do assistente sem user message.
        await ws.send_json({"type": "assistant_opener", "text": opener})
        # TTS streams simultaneously se auto_speak ativo.
```

### should_open heuristic

- Último turno da conversa > 30 min atrás, **ou** primeiro connect do dia
- Não dispara mais que 1x/hora (key: `last_opener_at`)
- Não dispara se o usuário digitou algo nos últimos 10 segundos
  (evita colisão com input em progresso)

### Gerador

Prompt curto, ~300 tokens, recebe:

- Hora local (manhã/tarde/noite/madrugada)
- Minutos desde último chat
- 1–2 tarefas de hoje em `seraphine_tasks`
- Delta de sono (se último `health_snapshot` tem dado)
- Até 2 open loops abertos
- Próximo evento de calendário (< 2h)

Modelo: `claude-haiku-4-5`, temperatura 0.8, max_tokens 80. Retorna
opener PT-BR, 1-2 frases, com expression tag e possivelmente action
tag. Exemplo:

```
[warm] Ei, voltou. Dormiu só 5h ontem — quer começar devagar hoje?
```

Se o modelo retornar vazio ou a heurística não acha "match
contextual", emite nada (silence is allowed).

### Streaming

O opener já sai com TTS pipeline normal — emite sentenças pro
ElevenLabs, frontend toca. Avatar usa expression tag.

### Frontend

Handler novo pro tipo `assistant_opener` — insere turno no chat
normal + dispara playback. Sem UI nova.

---

## Entregáveis

- [ ] `specs/022-liveness-layer.md` (este arquivo).
- [ ] Prompt: personality seed + flashback hint em `engine.py`.
- [ ] `seraphine/memory/mood.py` + integração em engine.
- [ ] Schema migration `open_loops` + store methods.
- [ ] `seraphine/memory/open_loops.py` com extractor + resolver.
- [ ] Injeção de open loops no prompt dinâmico.
- [ ] `seraphine/openers/service.py` — gerador proativo.
- [ ] WS hook `assistant_opener` no handler de conexão.
- [ ] Frontend: handler de `assistant_opener` (App.tsx + realtime).
- [ ] Tests: mood transitions, open loop extraction, opener heuristic.

## Rollout

Tudo roda backend-first. Frontend só precisa aceitar novo tipo de
mensagem WS. Deploy incremental:

1. 022-A (prompt only) — deploy standalone, zero risco.
2. 022-B (mood in-memory) — deploy, observa coerência.
3. 022-C (open loops) — deploy, espera 1 dia de uso pra validar
   extração, depois ativa injeção no prompt.
4. 022-D (opener) — rate-limited e com flag `SERAPHINE_OPENERS_ENABLED`
   pra desabilitar se ficar insistente.

## Riscos

- **Mood sticking demais**: se alguém fica `concerned` por 45min mesmo
  depois do usuário claramente mudar, vira chato. Mitigação: TTL curto
  + reset se 3 turnos seguidos do usuário forem "neutros".
- **Opener sendo intrusivo**: o custo de ela abrir conversa quando
  usuário só queria checar algo é alto. Mitigação: rate limit 1/h +
  flag de kill.
- **Open loops viram nagging**: se ela cobra 3x e o usuário ignorou,
  vira peso. Mitigação: depois de 3 injeções sem resolução, expira
  silenciosamente (`resolved_at = NOW, resolution = "expired"`).
- **LLM custo**: opener é +1 call pequena por sessão. Cache do system
  prompt do engine principal não ajuda aqui (prompt diferente).
  Aceitável — Haiku é barato.
