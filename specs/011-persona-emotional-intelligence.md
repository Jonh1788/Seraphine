# 011 — Persona & Inteligência Emocional

## Context

Seraphine funciona como assistente pessoal mas ainda responde de forma genérica.
Esta spec transforma a persona em algo memorável: humor contextual, avatar
expressivo com emoções reativas, proatividade baseada em padrões do usuário,
e memória emocional que humaniza a interação.

## Escopo

### 011-A: Humor Contextual

O LLM aprende o estilo de comunicação do usuário via memory facts e adapta
o tom: sarcástico, carinhoso, direto, informal. Persistido como fact de
personalidade no ChromaDB.

**Contratos:**

```python
# memory/manager.py — novo método
async def update_communication_style(self, episode: str) -> None:
    """Analisa a mensagem e atualiza o fact 'user_comm_style'
    com traços detectados (humor, formalidade, energia)."""

# Injected no system prompt como:
# "O estilo de comunicação do Jonathan é: informal, sarcástico, direto.
#  Adapte seu tom para combinar."
```

**System prompt injection:**
- Extraído da memory store a cada conversa
- Atualizado a cada 10 turns analisando o padrão

### 011-B: Avatar Mood System

Expressões faciais do VRM reagem ao contexto em tempo real.

**Estados emocionais:**

| Contexto | Expressão | BlendShapes |
|----------|-----------|-------------|
| Pesquisando | Concentrada | brow_down, mouth_neutral |
| Tarefa concluída | Feliz | smile, eye_squint |
| Tarefas atrasadas | Preocupada | brow_inner_up, mouth_frown |
| Erro de tool | Surpresa | brow_up, mouth_open |
| Idle longo | Tediada | eye_blink_slow, head_tilt |
| Bom dia/boa noite | Calorosa | smile_wide, eye_soft |

**Contratos:**

```typescript
// avatar/VrmAvatarController.ts
interface MoodState {
  emotion: 'neutral' | 'happy' | 'focused' | 'worried' | 'surprised' | 'bored' | 'warm';
  intensity: number; // 0-1
  duration: number;  // ms, after which returns to neutral
}

setMood(mood: MoodState): void;
```

**Triggers:**
- Tool chamado → `focused`
- Tool ok → `happy` (2s)
- Tool error → `surprised` (1s)
- Tarefa concluída → `happy` (3s)
- Muitas tarefas atrasadas → `worried` (persistent)
- Sem interação 5min → `bored`

### 011-C: Memória Emocional

Seraphine lembra o estado emocional do usuário entre sessões.

```python
# memory/manager.py
async def record_emotional_context(self, sentiment: str, topic: str) -> None:
    """Salva snapshot emocional: 'estressado com trabalho', 'animado com viagem'."""

async def get_recent_emotional_context(self) -> list[dict]:
    """Retorna últimos 5 contextos emocionais pra injetar no system prompt."""
```

**Na próxima sessão:** "Ontem você parecia estressado com o deploy. Resolveu?"

### 011-D: Proatividade no Boot

Ao abrir o app, Seraphine resume o dia antes do usuário perguntar.

```python
# conversation/engine.py — novo método
async def generate_daily_briefing(self) -> str:
    """Gera briefing combinando:
    - Tarefas do dia (pendentes, atrasadas)
    - Eventos do Google Calendar (próximas 12h)
    - Lembretes agendados
    - Finance entries pendentes de review
    - Clima atual
    - Contexto emocional recente
    """
```

**Frontend:**
- ChatView detecta sessão nova (primeira abertura do dia)
- Dispara `generate_daily_briefing` automaticamente
- Renderiza como primeiro turn do assistente

## Dependências

- 004-memory (ChromaDB facts)
- 005-avatar-lipsync (VRM blendshapes)
- Task system (para briefing)
- Google Calendar integration

## Fora de escopo

- Análise de sentimento em tempo real (muito caro computacionalmente)
- Personalidade configurável pelo usuário (aprende automaticamente)
