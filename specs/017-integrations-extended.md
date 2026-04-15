# 017 — Integrações Estendidas

## Context

Seraphine integra com Google Workspace, WhatsApp, e browser. Esta spec
expande com integrações de produtividade e lifestyle que aumentam o valor
da assistente no dia-a-dia.

## Escopo

### 017-A: Spotify / Apple Music

Controle de música via chat + recomendações baseadas em contexto.

**Funcionalidades:**
- "Coloca uma playlist pra focar" → busca e toca playlist
- "Que música tá tocando?" → mostra card com artista/álbum/capa
- Integração com modo foco: playlist automática durante pomodoro
- Histórico de gostos persistido na memória

**Implementação:**
- Spotify Web API (OAuth) ou AppleScript pra Apple Music (macOS nativo)
- Tool: `play_music`, `now_playing`, `pause_music`
- Card no chat com capa do álbum e controles inline

### 017-B: Clipboard Monitor

Detecta conteúdo copiado e oferece ações contextuais.

**Detecções:**
| Padrão | Ação oferecida |
|--------|----------------|
| URL | "Quer que eu abra/resuma esse link?" |
| CPF/CNPJ | "Quer salvar esse documento?" |
| Código PIX | "Quer fazer esse pagamento?" |
| Email | "Quer enviar email pra essa pessoa?" |
| Código (snippet) | "Quer que eu explique esse código?" |

**Implementação:**
- Tauri plugin ou polling do clipboard a cada 2s
- Regex patterns pra cada tipo
- Toast notification na parte inferior: "[Tipo] detectado. [Ação]"
- Click dispara tool correspondente

### 017-C: Terminal Integrado

Rodar comandos shell direto no chat da Seraphine.

**UX:**
```
User: "roda os testes do backend"
Seraphine: [executa] cd apps/seraphine/backend && uv run pytest
           [mostra output em code block]
           "6 testes passaram, 1 falhou. O test_memory_store tá
            falhando por timeout no ChromaDB."
```

**Já existe** parcialmente (shell tool + browser automation). Melhorar:
- Output formatado com syntax highlighting
- Streaming do output em tempo real
- Kill button pra comandos longos
- Histórico de comandos recentes

### 017-D: Notes / Quick Notes

Sistema simples de notas rápidas, sincronizável com Obsidian.

**Modelo:**
```python
@dataclass
class Note:
    id: str
    title: str
    content: str      # Markdown
    tags: list[str]
    created_at: str
    updated_at: str
```

**Funcionalidades:**
- "Anota isso: ..." → cria nota via chat
- View de notas com busca
- Export pra Obsidian vault (symlink ou copy)
- Markdown editor inline

### 017-E: Contacts / People

Lista de contatos frequentes com contexto.

**Modelo:**
```python
@dataclass
class Contact:
    id: str
    name: str
    phone: str | None
    email: str | None
    notes: str        # Contexto: "Fornecedor de TI", "Amigo da faculdade"
    last_interaction: str | None
```

**Integração:**
- WhatsApp: auto-populate de contatos frequentes
- Gmail: extrair contatos dos emails
- Chat: "Manda mensagem pro FP" → busca contato → WhatsApp/email

## Dependências

- Tauri plugins (clipboard, shell)
- Existing tools (shell, browser, WhatsApp)
- Memory system (persistir preferências)

## Fora de escopo

- Sincronização bidirecional com Notion
- Integração com Slack/Discord
- Home automation (IoT)
