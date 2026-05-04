# 077 — Aura Task Sharing

**Status:** Implemented
**Scope:** Aura only (Seraphine remains single-tenant)
**Owner:** Jonathan

## Goal

Permitir que usuários da Aura compartilhem tarefas entre si por email. Quando qualquer participante muda o status de uma tarefa compartilhada (concluir / reabrir), a mudança é refletida para todos os participantes. Cards mostram quem concluiu.

## Non-goals

- Compartilhar com email não cadastrado na Aura (sem fluxo de convite/signup transacional).
- Aceite explícito de convite (compartilhamento é direto; participante pode sair).
- Transferência de dono.
- Compartilhamento de "projetos" inteiros (`aura.projects`) — só tarefas individuais.
- Alterar comportamento da Seraphine (`user_id IS NULL`): inalterado.

## User stories

1. Como dono de uma tarefa, abro o `TaskEditorModal`, digito o email de outro usuário e clico **Adicionar**. O outro usuário recebe push e vê a tarefa na lista dele.
2. Como participante (não-dono), posso editar título / descrição / due / priority da tarefa, e marcar como concluída. Não posso adicionar/remover participantes nem deletar a tarefa.
3. Como participante, posso clicar **Sair desta tarefa** a qualquer momento — sumo da lista da tarefa, mas a tarefa continua existindo para os demais.
4. Quando outro participante conclui a tarefa, vejo o card como `completed` com a label `"concluído por <email>"`. Recebo push notification.
5. Posso reabrir uma tarefa concluída por outro (volta a `pending`, limpa `completed_by`). Push notification dispara para os demais.
6. Pelo chat: `"compartilha a tarefa 'feira' com ana@y.com"` → o agente Aura usa a tool `share_task` e confirma.

## Decisions log (do brainstorming)

| # | Decisão |
|---|---|
| 1 | Compartilhar **só com email já registrado**. Email desconhecido → erro claro. |
| 2 | **Sem aceite**: aparece direto pro convidado; ele pode sair quando quiser. |
| 3 | **Edição compartilhada** (título/desc/due/priority). **Delete** só pelo dono. |
| 4 | **Concluir/reabrir** propaga pra todos. Card mostra `completed_by`. |
| 5 | **Push notification** em conclusão, reabertura, convite e remoção. |
| 6 | Compartilhar via **UI** (TaskEditorModal) **e tool de chat** (`share_task`). |
| 7 | **Só dono convida** (re-decidido depois da seção 3). |
| 8 | **Reabrir** permitido por qualquer participante. |

## Architecture

A funcionalidade vive no pacote compartilhado **`mod-tasks`**, mas é gated:

- **Migrations** (tabela `task_participants`, coluna `completed_by`) são idempotentes e rodam em qualquer DB que use `mod-tasks`. Tasks com `user_id IS NULL` (Seraphine) ficam fora da feature naturalmente, porque a feature exige um `user_id` por participante.
- **Endpoints de share** são montados apenas pelo backend Aura. O `mod-tasks/routes.py` exporta um `APIRouter` adicional ou os endpoints ficam no `apps/aura/backend/aura/projects/routes.py` (decisão de implementação durante o plan).
- **Lookups email ↔ user_id** são responsabilidade da Aura (tabela `users`). `mod-tasks` recebe dois callbacks injetados (`email_to_user_id`, `user_id_to_email`) no construtor do `TaskService`. Sem import direto de `aura.auth` em `mod-tasks`.
- **Push** é injetado opcional via `task_service.attach_push(push_service)`. Ausência → fire-and-forget vira no-op.

## Data model

### Migration M1 — `seraphine_tasks` (alter)

```sql
ALTER TABLE seraphine_tasks ADD COLUMN completed_by TEXT;  -- user_id de quem concluiu
```

Idempotente via `try/except sqlite3.OperationalError` no padrão já usado em `mod_tasks/schema.py`.

### Migration M2 — `task_participants` (create + backfill)

```sql
CREATE TABLE IF NOT EXISTS task_participants (
  task_id    INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  joined_at  TEXT    NOT NULL,
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id) REFERENCES seraphine_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_participants_user ON task_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_task_participants_task ON task_participants(task_id);
```

Backfill (na mesma migration; idempotente via `INSERT OR IGNORE`, seguro re-rodar):

```sql
INSERT OR IGNORE INTO task_participants (task_id, user_id, role, joined_at)
SELECT id, user_id, 'owner', created_at
FROM seraphine_tasks
WHERE user_id IS NOT NULL;
```

### Invariantes

- Toda task com `user_id != NULL` tem **exatamente uma** linha `role='owner'` em `task_participants`.
- O `user_id` da `seraphine_tasks` continua sendo o **dono original** (criador). Não muda quando participantes entram/saem. Serve como FK lógica pra "dono".
- `task_participants.role='owner'` é fonte de verdade para autorização. Caller é dono se existir `(task_id, caller_id, 'owner')`.

### Dataclass `SeraphineTask` (extensão)

```python
completed_by: str | None = None              # user_id (armazenado)
participants: list[str] = field(default_factory=list)  # emails (computado)
is_owner: bool = False                       # computado pro caller
completed_by_email: str | None = None        # computado a partir de completed_by
```

`participants`, `is_owner` e `completed_by_email` são **computados** no service (não ficam no row); populados via JOIN + lookup de email no `get_task` / `list_tasks`.

## Backend API

### Endpoints novos (Aura-only)

Todos sob `/tasks/{task_id}/participants`. Auth obrigatória.

| Método | Path | Quem | Comportamento |
|---|---|---|---|
| `POST` | `/tasks/{id}/participants` | dono | Body `{"email": "x@y.com"}`. 200 + lista atualizada. |
| `GET` | `/tasks/{id}/participants` | qualquer participante | 200 + `{"participants": ["a@x.com", "b@y.com"]}` |
| `DELETE` | `/tasks/{id}/participants/me` | qualquer participante (exceto dono) | 200. Caller deixa de ser participante. |
| `DELETE` | `/tasks/{id}/participants/{user_id}` | dono | 200. Remove participante. Não pode remover a si mesmo. |

**Status codes:**
- `400` — dono tentando sair (`/me` quando `role=owner`); auto-remoção via `/{user_id}`.
- `403` — caller não é participante (todos os endpoints) ou não é dono (`POST`, `DELETE /{user_id}`).
- `404` — task inexistente, ou task sem participantes (Seraphine), ou email não cadastrado.
- `409` — email já é participante.

### Endpoints existentes — autorização atualizada

| Endpoint | Antes | Depois |
|---|---|---|
| `GET /tasks` | `WHERE user_id=?` | `JOIN task_participants WHERE p.user_id=?` |
| `GET /tasks/{id}` | `WHERE id=? AND user_id=?` | JOIN + 404 se caller não está em `task_participants` |
| `PATCH /tasks/{id}` (update_task) | dono | qualquer participante |
| `PATCH /tasks/{id}/status` | dono | qualquer participante; setar/limpar `completed_by` |
| `DELETE /tasks/{id}` | dono | só dono (role='owner') |

### Tool de chat `share_task`

Adicionada em `apps/seraphine/backend/seraphine/tools/tasks.py` mas **registrada apenas no agente Aura** (gate na lista de tools do agente).

```json
{
  "name": "share_task",
  "description": "Compartilha uma tarefa existente com outro usuário Aura por email.",
  "input_schema": {
    "type": "object",
    "properties": {
      "task_id": {"type": "integer"},
      "email": {"type": "string"}
    },
    "required": ["task_id", "email"]
  }
}
```

Sem aprovação (segue padrão dos outros mutations de task em Aura). Erros traduzidos:
- `no_such_user` → "Não encontrei conta na Aura com esse email."
- `already_participant` → "Esse usuário já participa dessa tarefa."
- `not_owner` → "Só o dono da tarefa pode compartilhar."

## Service layer (`mod-tasks/service.py`)

### Novos métodos

```python
async def add_participant(task_id: int, caller_id: str, target_email: str) -> list[str]: ...
async def remove_participant(task_id: int, caller_id: str, target_user_id: str) -> None: ...
async def leave_task(task_id: int, caller_id: str) -> None: ...
async def list_participants(task_id: int) -> list[str]: ...  # emails
```

### Hooks injetados (no `__init__`)

```python
self._email_to_user_id: Callable[[str], Awaitable[str | None]] | None = None
self._user_id_to_email: Callable[[str], Awaitable[str | None]] | None = None
self._push: Any | None = None  # duck-typed; precisa expor send_to_user(user_id, payload) -> int
```

Métodos `attach_user_lookup(...)` e `attach_push(...)` setam após construção (mesmo padrão do `attach_whatsapp` no `PushService`).

### Comportamento crítico — `update_status`

```python
async def update_status(task_id, caller_id, new_status):
    self._authorize_participant(task_id, caller_id)  # 403 se não participante
    current = await self.get_task(task_id, caller_id)
    if current.status == new_status:
        return current  # idempotente, sem push
    completed_by = caller_id if new_status == 'completed' else None
    UPDATE seraphine_tasks SET status=?, completed_by=?, updated_at=? WHERE id=?
    if new_status == 'completed':
        await self._notify_completed(task_id, completer=caller_id)
    elif current.status == 'completed':  # reabertura
        await self._notify_reopened(task_id, reopener=caller_id)
```

### Push payloads

Reusa `PushService.send_to_user(user_id, payload)`. Envio é fire-and-forget (`asyncio.create_task` + try/except logado). Falha de push **não falha** o mutation.

| Evento | Pra quem | Title | Body |
|---|---|---|---|
| Conclusão | participantes ≠ completer | "Tarefa concluída" | `{email} concluiu: {title}` |
| Reabertura | participantes ≠ reopener | "Tarefa reaberta" | `{email} reabriu: {title}` |
| Convite | convidado | "Nova tarefa compartilhada" | `{owner_email}: {title}` |
| Remoção | removido | "Removido de tarefa" | `{owner_email} removeu você de: {title}` |

URL no payload: `/tasks?focus={id}` para deep link.

## Frontend (Aura)

### `TaskEditorModal` — nova seção "Participantes"

Visível só quando a task tem `id` (já criada) — listagem sempre visível pra qualquer participante; controles de adicionar/remover só pro dono.

```
┌─ Participantes ────────────────────┐
│ matheus@x.com (você, dono)         │
│ ana@y.com               [×]        │  ← × só pro dono
│ + email                    [Add]   │  ← input + botão; só dono
└────────────────────────────────────┘
[Sair desta tarefa]                    ← só pra não-dono
```

### `TaskCard`

Mudanças mínimas:

- **Ícone `Users`** (Lucide) ao lado do título quando `participants.length > 1`. Tooltip lista emails.
- Quando `status='completed'` e `completed_by_email != user.email` → label discreto: `"concluído por <email>"`. Quando == self → `"concluído por você"`.

Sem mudança no agrupamento (`late/today/upcoming/done`).

### Tipos `api/tasks.ts`

```ts
interface Task {
  // ...existentes
  participants: string[];          // emails
  completed_by_email: string | null;
  is_owner: boolean;
}
```

### Toast errors

| Backend | UI message (PT-BR) |
|---|---|
| 404 (email) | "Este email não tem conta na Aura." |
| 409 | "Este usuário já participa desta tarefa." |
| 403 | "Apenas o dono pode fazer esta ação." |
| 400 (dono saindo) | "O dono não pode sair. Delete a tarefa ou remova individualmente os participantes." |

## Edge cases

| Caso | Comportamento |
|---|---|
| Dono deleta task com participantes | `ON DELETE CASCADE` remove `task_participants`. Push pra ex-participantes. |
| Dono sai (`DELETE /me`) | 400 com mensagem clara. Sem feature de transferência. |
| Convidar a si mesmo | 409 (`PRIMARY KEY` constraint). |
| Task Seraphine (`user_id IS NULL`) | Endpoints de share retornam 404 (não tem participantes). |
| Concluir já concluída | No-op early-return; sem push duplicado. |
| `completed_by` aponta pra usuário deletado | `user_id_to_email` retorna `None`; UI mostra "concluído por usuário removido". |
| Race em conclusão simultânea | Last-write-wins; `completed_by` do segundo UPDATE vence. Aceitável. |
| Push sem subscription registrada | `send_to_user` retorna 0 silenciosamente. |
| Email vazio / inválido no POST | 422 (validação Pydantic). |

## Testes

### Backend (`packages/mod-tasks/tests/`)

- `test_participants_crud.py` — add/remove/list/leave; matriz de autorização (dono vs membro vs estranho).
- `test_status_propagation.py` — B conclui → A vê `completed`+`completed_by=B`; A reabre → `pending`+`completed_by=NULL` pra todos.
- `test_aura_only_isolation.py` — share endpoints retornam 404 pra task com `user_id=NULL`; tasks Seraphine inalteradas.
- `test_lookup_injection.py` — service usa callbacks injetados; sem import de `aura.auth`.
- `test_cascade_delete.py` — deletar task remove rows de `task_participants`.

### Frontend (`apps/aura/frontend/src/components/__tests__/`)

- `TaskEditorModal.test.tsx` — seção Participantes só aparece com `task.id`; controles de add/remove só pro dono; "Sair" só pro não-dono.
- `TaskCard.test.tsx` — ícone Users com >1 participante; label `completed_by` correto.

### Push (`apps/aura/backend/tests/`)

- `test_share_push.py` — mock `PushService.send_to_user` é chamado com user_ids corretos (excluindo o ator) em conclusão, reabertura, convite, remoção.

## Open questions / risks

- **Privacidade de email**: lista de participantes expõe emails de todos pra todos. Aceitável dado que pra entrar é preciso do email. Não-issue.
- **Limite de participantes por tarefa**: sem limite duro; soft cap razoável seria 20 (não bloqueia, alerta). MVP: sem limite.
- **Auditoria**: sem log de "fulano editou X em Y momento". MVP fora de escopo.

## Out of scope (não fazer agora)

- Transferência de propriedade.
- Aceite/recusa de convite.
- Compartilhamento de projetos inteiros.
- Email transacional (signup invite).
- Limites por participante / quotas.
- Visualização "tarefas que compartilho" como aba separada (filtro `participants.length > 1` já basta no MVP).
