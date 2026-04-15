# 014 — Sistema de Hábitos

## Context

Tarefas são pontuais. Hábitos são recorrentes sem data de conclusão — o
usuário quer manter uma streak diária. Beber água, exercício, leitura,
meditação. Visualização de streaks e progresso motiva continuidade.

## Escopo

### 014-A: Modelo de Dados

```python
@dataclass
class Habit:
    id: str               # UUID
    title: str
    icon: str             # SVG icon key (from svg_icons.py)
    color: str            # hex color for UI
    frequency: str        # 'daily' | 'weekdays' | 'custom'
    target_days: list[int] | None  # 0=Mon..6=Sun for 'custom'
    created_at: str
    active: bool

@dataclass
class HabitLog:
    id: int
    habit_id: str
    date: str             # YYYY-MM-DD
    completed: bool
    created_at: str
```

**SQLite tables:**
```sql
CREATE TABLE habits (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  icon TEXT DEFAULT 'check',
  color TEXT DEFAULT '#22d3ee',
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekdays','custom')),
  target_days TEXT,  -- JSON array [0,1,2,3,4] for weekdays
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(habit_id, date)
);
```

### 014-B: Service + Routes

```python
class HabitService:
    async def create(title, frequency, icon?, color?, target_days?) -> Habit
    async def list_active() -> list[Habit]
    async def toggle_today(habit_id) -> HabitLog
    async def get_streaks(habit_id) -> { current: int, best: int, total: int }
    async def get_calendar(habit_id, month, year) -> list[HabitLog]
    async def delete(habit_id) -> int

# Routes: /habits
GET    /habits              → list active habits with today's status
POST   /habits              → create habit
DELETE /habits/{id}         → delete
POST   /habits/{id}/toggle  → toggle today's log
GET    /habits/{id}/streaks → current/best/total streaks
```

### 014-C: UI — Habits View

Nova view no nav rail com ícone de flame/target.

**Layout:**
```
┌─────────────────────────────────────────────┐
│  Habitos                         + Novo     │
├─────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ 💧      │  │ 🏃      │  │ 📖      │    │
│  │ Agua    │  │ Exercicio│  │ Leitura │    │
│  │ ████ 12 │  │ ███░ 8  │  │ ██░░ 5  │    │
│  │  [✓]    │  │  [ ]    │  │  [✓]    │    │
│  └─────────┘  └─────────┘  └─────────┘    │
│                                             │
│  Hoje: 2/3 concluídos                       │
│  Melhor streak: Agua (12 dias)              │
└─────────────────────────────────────────────┘
```

**Cada card:**
- Ícone + título
- Progress bar com streak count
- Toggle button (check/uncheck hoje)
- Click abre detalhe com calendário de completions (grid mensal com dots)

### 014-D: Chat Integration

LLM tool `toggle_habit` pra marcar/desmarcar via conversa:

```
User: "Bebi água hoje"
Seraphine: [marca hábito] "Anotado! Streak de 13 dias! 🔥"
```

### 014-E: Dashboard Integration

Widget no dashboard (spec 012) mostrando progresso do dia:
"Hábitos: 2/3 hoje"

## Dependências

- SQLite (core-db)
- Nav rail (nova entrada)
- Dashboard (012, optional)

## Fora de escopo

- Gamificação (pontos, badges)
- Metas semanais/mensais
- Integração com Apple Health
