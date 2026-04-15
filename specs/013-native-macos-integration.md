# 013 — Integração Nativa macOS

## Context

Seraphine roda no Tauri mas não aproveita recursos nativos do macOS.
Notificações, atalhos globais, quick capture e modo foco transformam
a experiência de "webapp em janela" para "app nativo inteligente".

## Escopo

### 013-A: Notificações Nativas

Quando um lembrete dispara e o app está minimizado/background, usar
notificações nativas do macOS via Tauri notification plugin.

**Dependência Tauri:**
```toml
# src-tauri/Cargo.toml
tauri-plugin-notification = "2"
```

**Fluxo:**
1. Backend dispara reminder via WS `type: "reminder"`
2. Se WS conectado → mostra no chat (já funciona)
3. Frontend TAMBÉM dispara notificação nativa:
   ```typescript
   import { sendNotification } from '@tauri-apps/plugin-notification';
   sendNotification({ title: 'Seraphine', body: message });
   ```
4. Click na notificação → foca a janela e scrolla pro lembrete

### 013-B: Global Shortcut — Quick Capture

`Cmd+Shift+S` abre mini janela flutuante pra captura rápida.

**Tauri config:**
```json
{
  "windows": [
    { "label": "quick-capture", "width": 400, "height": 200,
      "visible": false, "decorations": false, "alwaysOnTop": true,
      "center": true, "transparent": true }
  ]
}
```

**UX:**
1. Atalho global registrado via `tauri-plugin-global-shortcut` (já tem)
2. Abre mini janela com input field
3. Enter → cria tarefa via `POST /tasks` → fecha janela
4. Escape → cancela

### 013-C: Command Palette

`Cmd+K` abre palette de comandos estilo Spotlight/Raycast.

**Comandos:**
- "Nova tarefa" → abre NewTaskModal
- "Abrir calendário" → navega
- "Abrir finanças" → navega
- "Buscar tarefa..." → filtra tarefas por título
- "Perguntar..." → foca input do chat

**Implementação:**
- Componente `CommandPalette.tsx` com fuzzy search
- Lista filtrável de ações + tarefas recentes
- Glass card flutuante no centro

### 013-D: Modo Foco / Pomodoro

Timer integrado com fases de trabalho e descanso.

**Estados:**
```typescript
type FocusPhase = 'work' | 'break' | 'long_break' | 'idle';

interface FocusState {
  phase: FocusPhase;
  remaining: number; // seconds
  cycle: number;     // current pomodoro cycle (1-4)
  task?: string;     // tarefa vinculada
}
```

**Durações default:**
- Work: 25min
- Break: 5min
- Long break (a cada 4 ciclos): 15min

**Integração avatar:**
- Work → expressão `focused`
- Break → expressão `warm` + idle animation
- Conclusão de ciclo → `happy`

**UI:**
- Pill no header mostrando timer countdown
- Click expande painel de controle
- Pode vincular uma tarefa ("focando em: Cobrar FP")

### 013-E: Atalhos de Teclado

| Atalho | Ação |
|--------|------|
| Cmd+1 | Chat |
| Cmd+2 | Calendário |
| Cmd+3 | Tarefas |
| Cmd+4 | Finanças |
| Cmd+5 | Memórias |
| Cmd+K | Command palette |
| Cmd+N | Nova tarefa |
| Space (hold) | Push-to-talk |
| Escape | Fechar modal |

**Implementação:**
- Event listener global no `App.tsx`
- Teclas numéicas controlam `activeView`
- Cmd+N abre NewTaskModal de qualquer view

## Dependências

- Tauri 2 plugins: notification, global-shortcut (já tem shell)
- Task system
- Avatar mood system (013-D integration)

## Fora de escopo

- Integração com Focus mode do macOS (DND API)
- Menu bar app / tray icon com timer
