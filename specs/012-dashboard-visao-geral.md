# 012 — Dashboard / Visão Geral

## Context

Seraphine abre direto no chat. Falta uma tela inicial que dê contexto
imediato do dia sem o usuário precisar perguntar nada. Inspirado na
Visão Geral da Aura, mas com o avatar da Seraphine integrado.

## Escopo

### 012-A: Greeting Header

Cabeçalho com saudação contextual + data + relógio live.

```
┌──────────────────────────────────────────────────┐
│  Boa tarde, Jonathan!              16:42 • Qua   │
│  quarta-feira, 15 de abril                       │
│                                  ● Sistemas online│
└──────────────────────────────────────────────────┘
```

**Lógica:**
- 5-12h: "Bom dia"
- 12-18h: "Boa tarde"
- 18+: "Boa noite"
- Relógio atualiza a cada 30s
- Status indicator: verde se backend WS conectado

### 012-B: Briefing Card

Card com progresso do dia.

```
┌─────────────────────┐
│  Briefing do Dia    │
│  ████████░░  3/8    │
│  3 de 8 concluídos  │
└─────────────────────┘
```

**Dados:**
- `GET /tasks?due_from=today&due_to=today` → total + completed
- Progress bar com gradiente accent

### 012-C: Mini Módulos Grid

Grid 2x2 ou 3x2 com resumos rápidos:

| Módulo | Dados | Cor |
|--------|-------|-----|
| Tarefas | Pendentes / Em andamento / Concluídas hoje | Cyan |
| Finanças | Receita / Despesa / Saldo do mês | Green |
| Agenda | Próximo evento + horário | Purple |
| Clima | Temp atual + condição | Amber |

Cada módulo é um glass card clicável que navega pra view correspondente.

### 012-D: Próximos Eventos

Timeline vertical com os próximos 5 eventos/tarefas do dia, ordenados
por horário.

```
  09:00  ● Reunião de equipe
  14:00  ● Cobrar FP
  16:00  ● Comprar refrigerante
  18:00  ● Dentista
```

### 012-E: Avatar Mini

O avatar VRM em tamanho menor (200x200) no canto do dashboard,
com animação idle. Clicável pra ir pro chat.

## Contratos

```typescript
// Nova view: DashboardView.tsx
interface DashboardViewProps {
  onNavigate: (view: 'chat' | 'calendar' | 'tasks' | 'finance') => void;
}

// Backend endpoint (novo):
GET /dashboard/briefing
→ {
    tasks_today: { total: number, completed: number, overdue: number },
    next_events: Array<{ title: string, time: string, type: string }>,
    finance_month: { income: number, expenses: number, balance: number },
    weather?: { temp: number, description: string },
  }
```

## Dependências

- Task system
- Google Calendar
- Finance module
- Weather tool (opcional)
- Avatar system

## Fora de escopo

- Hábitos (spec 014)
- Radar de vida (futuro)
