# 019 — Avatar Companion Window

## Context

Usuário quer ter o avatar VRM da Seraphine flutuando numa janela separada,
sempre no topo, com fundo transparente, ocupando um canto da tela enquanto
ele usa outros apps. Tipo um "tamagotchi" ou o Clippy do Office, mas com
uma assistente real.

## Escopo

### 019-A: Janela Tauri Dedicada

Segunda janela Tauri `avatar-companion`:
- Tamanho: 320×480 (retrato, para caber o modelo inteiro)
- `transparent: true` — sem fundo
- `alwaysOnTop: true`
- `decorations: false` — sem barra de título
- `skipTaskbar: true` — não aparece no dock
- `resizable: true` — pode redimensionar livremente
- `visible: false` — inicia oculta
- Posição inicial: canto inferior direito da tela

### 019-B: Conteúdo

Renderiza apenas:
- Canvas Three.js com o VRM carregado
- Animações idle (piscar, respirar, olhar ao redor) — já existe
- SpringBone physics — já existe
- Lipsync via WebSocket audio (quando TTS toca)
- Mood events via WebSocket (expressões reativas)

**NÃO renderiza:** nav rail, chat, headers, nada. Só o avatar.

### 019-C: Atalho Global

`Cmd+Shift+A` — toggle show/hide da janela companion.

### 019-D: Interação

- **Drag**: segurar Shift + arrastar pra mover (pra não conflitar com
  clicks que o avatar pudesse receber)
- **Click no avatar**: foca a janela principal
- **Double-click**: fecha a janela companion

### 019-E: Sincronização com Main Window

A companion window tem sua própria conexão WebSocket com o backend. O
backend faz broadcast de eventos (mood, reminder, speech) para todos os
clients conectados, então a companion recebe os mesmos eventos e
reage identicamente ao avatar da main window.

**Vantagens:**
- Sem necessidade de IPC entre janelas Tauri
- Companion funciona mesmo se main window estiver hidden
- Lipsync perfeito (ambos recebem o mesmo stream de áudio)

**Nota:** O backend já faz broadcast via `app.state.ws_clients`, nenhuma
mudança necessária.

### 019-F: Configuração (opcional, futuro)

- Tamanho da janela (pequeno/médio/grande)
- Posição favorita (cantos predefinidos)
- Transparência do canvas (slider)
- Toggle: click-through (ignora mouse) vs interativo

## Implementação

### Arquivos novos
- `/Users/jonh1788/Dev/Projeto-Seraphine/apps/seraphine/frontend/avatar-companion.html`
- `/Users/jonh1788/Dev/Projeto-Seraphine/apps/seraphine/frontend/src/avatar-companion/main.tsx`
- `/Users/jonh1788/Dev/Projeto-Seraphine/apps/seraphine/frontend/src/avatar-companion/AvatarCompanion.tsx`

### Arquivos modificados
- `src-tauri/tauri.conf.json` — adicionar window
- `src-tauri/src/lib.rs` — atalho global + posicionamento
- `vite.config.ts` — adicionar entry
- `src/styles.css` — classes pra janela transparente

## Fora de escopo

- Click-through mode (ignora mouse) — v2
- Sincronização de estado de conversa (companion é "read-only")
- Múltiplos avatares (só 1)
- Customização visual além do modelo VRM carregado
