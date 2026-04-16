# 021 — Water Tracking (módulo dedicado)

## Context

Hábito de beber água é mais rico que um toggle diário: tem meta em ml
baseada em peso, incrementos variáveis (copo, garrafa), lembretes
regulares, e merece visualização especial (vaso enchendo).

## Escopo

### 021-A: Profile + Goal

Tabela `water_profile` (single row, id=1):
- `weight_kg: float`
- `height_cm: float` (opcional)
- `activity_level: str` ('sedentary' | 'moderate' | 'active')
- `daily_goal_ml: int` (calculado ou custom)
- `reminder_enabled: bool`
- `reminder_start: str` (HH:MM, default 08:00)
- `reminder_end: str` (HH:MM, default 22:00)
- `reminder_interval_hours: int` (default 2)

**Fórmula de meta**:
- Sedentário: `weight_kg × 30 ml`
- Moderado: `weight_kg × 35 ml`
- Ativo: `weight_kg × 40 ml`
- Limite: min 1500ml, max 5000ml

### 021-B: Tracking

Tabela `water_logs`:
- `id`, `amount_ml`, `logged_at` (ISO timestamp), `date` (YYYY-MM-DD)

Preset sizes:
- "copo" → 250ml
- "copão" → 400ml
- "garrafa pequena" → 500ml
- "garrafa" → 600ml
- "garrafão" → 1000ml

### 021-C: Backend

Module `seraphine/water/`:
- `models.py`, `schema.py`, `service.py`, `routes.py`

Service:
- `set_profile(weight_kg, height_cm?, activity_level, reminder_config?) -> Profile`
- `get_profile() -> Profile | None`
- `add_intake(amount_ml) -> { total_today, goal, percent }`
- `get_today() -> { total, goal, percent, logs }`
- `get_history(days) -> list[{ date, total, goal }]`
- `compute_goal(weight, activity) -> int`

Routes:
- `GET/PUT /water/profile`
- `POST /water/intake` body `{amount_ml}`
- `GET /water/today`
- `GET /water/history?days=7`
- `DELETE /water/logs/{id}` (corrigir erro)

### 021-D: Chat Tools

`LogWaterTool` (name `log_water`):
- Schema: `{amount_ml?: int, preset?: "copo"|"copão"|"garrafa"|"garrafa_pequena"|"garrafão"}`
- Fuzzy triggers: "bebi", "tomei água", "um copo", "uma garrafa"
- Retorna rich card com glass filling animation

`SetupWaterTool` (name `setup_water`):
- Schema: `{weight_kg: float, height_cm?: float, activity_level: str}`
- Calcula e salva a meta

### 021-E: Frontend

Componente `WaterWidget` renderizável no dashboard E no chat:
- **Visual**: SVG de um vaso/copo com water level animado (path com stroke-dashoffset ou clip-path)
- Mostra: "1.2L / 2.5L" + porcentagem
- Botões rápidos: "+250ml" "+500ml" (click incrementa)
- Ripple animation ao adicionar

Setup modal (primeira vez):
- Pergunta peso (slider ou input)
- Altura opcional
- Nível de atividade (radio buttons)
- Mostra goal calculada antes de salvar

No chat:
- Tool `log_water` retorna HTML card com SVG animado
- Card mostra progresso visual

### 021-F: Reminders

No backend, background task (similar ao recurring materialization):
- A cada boot + a cada 10min
- Se `reminder_enabled` e hora atual está entre `reminder_start` e `reminder_end`
- E faz `reminder_interval_hours` que não registrou nada
- Dispara notification via ReminderScheduler: "Bora beber água! 💧"

## Fora de escopo

- Sync com Apple Health (SDD 018)
- Tipos de líquido (café, chá, refri)
- Lembretes adaptativos baseados em hora da última dose
