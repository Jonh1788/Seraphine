# 016 — Visual Polish & UX Avançado

## Context

Seraphine funciona mas a experiência visual pode ser elevada com animações,
temas, onboarding e transições que transmitem qualidade premium.

## Escopo

### 016-A: Temas

Sistema de temas com variáveis CSS swappable.

**Temas iniciais:**
- **Midnight** (atual): dark navy, purple accent
- **Aurora**: dark com verde/teal accent
- **Sakura**: dark com rosa/cherry accent
- **Daylight**: tema claro (bg branca, text escuro)

**Implementação:**
```css
[data-theme="aurora"] {
  --accent: #14b8a6;
  --accent-hi: #2dd4bf;
  --accent-dim: #0d9488;
  --user: #4ade80;
}
```

**UI:**
- Settings com preview de cada tema
- Persistido em localStorage
- `document.documentElement.dataset.theme = 'aurora'`

### 016-B: Onboarding

Primeira abertura: setup guiado em 3 telas.

1. **Bem-vindo** — "Olá! Eu sou a Seraphine" + avatar animado
2. **Configurar** — Nome, LLM backend (Ollama/Claude), conectar Google
3. **Pronto** — "Tudo certo! Me pergunte qualquer coisa" → abre chat

**Detecção:** `localStorage.getItem('seraphine.onboarded')` — se null, mostra.

### 016-C: Transições entre Views

Animações suaves ao trocar de view (chat → calendar → tasks).

```css
.view-enter {
  animation: viewSlideIn 250ms ease-out;
}

@keyframes viewSlideIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

**Variações:**
- Slide up (default)
- Fade (modais)
- Scale (quick capture window)

### 016-D: Micro-interações

Detalhes que elevam a qualidade percebida:

- **Toggle task:** check icon anima (scale bounce)
- **Novo card no chat:** fade-in suave
- **Enviar mensagem:** input pill comprime suavemente
- **Avatar:** respiração idle sutil (chest movement)
- **Drag kanban:** card ganha sombra e eleva
- **Hover nav rail:** tooltip com label desliza

### 016-E: Responsividade

Adaptar pra diferentes tamanhos de janela Tauri:

| Largura | Layout |
|---------|--------|
| > 1200px | Nav rail + content + sidebar |
| 900-1200px | Nav rail + content (sidebar collapse) |
| < 900px | Bottom nav + content full |

### 016-F: Loading States

Skeleton screens em vez de spinners:

```css
.skeleton {
  background: linear-gradient(90deg,
    var(--bg-2) 25%,
    var(--bg-3) 50%,
    var(--bg-2) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}
```

- Chat: skeleton bubbles enquanto carrega histórico
- Calendar: skeleton grid
- Tasks: skeleton cards
- Finance: skeleton stats

## Dependências

- CSS custom properties (já usa)
- Tauri window API (para responsividade)

## Fora de escopo

- Drag-and-resize de painéis
- Layout customizável (drag widgets)
- Acessibilidade avançada (screen reader full support)
