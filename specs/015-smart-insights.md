# 015 — Smart Insights & Análise de Padrões

## Context

Seraphine coleta dados (tarefas, finanças, hábitos, calendário) mas não
faz nada proativo com eles. Esta spec adiciona análise de padrões que gera
insights acionáveis automaticamente.

## Escopo

### 015-A: Financial Patterns

Análise periódica dos dados financeiros pra detectar padrões.

**Insights gerados:**
- "Você gasta 40% mais em alimentação nas sextas-feiras"
- "Seus gastos com transporte aumentaram 25% este mês vs anterior"
- "Você tem R$ 2.300 em assinaturas recorrentes. Quer revisar?"
- "Padrão: você sempre gasta mais na primeira semana do mês"

**Implementação:**
```python
class InsightEngine:
    async def analyze_finance(month: int, year: int) -> list[Insight]:
        """Compara mês atual vs anterior, detecta outliers por categoria,
        identifica padrões por dia da semana."""

@dataclass
class Insight:
    id: str
    type: str        # 'finance' | 'tasks' | 'habits' | 'productivity'
    severity: str    # 'info' | 'warning' | 'positive'
    title: str
    description: str
    data: dict       # dados de suporte (valores, percentuais)
    created_at: str
    dismissed: bool
```

### 015-B: Task Patterns

- "Tarefas sem horário definido atrasam 3x mais"
- "Você completa mais tarefas de manhã (65% antes das 12h)"
- "3 tarefas estão pendentes há mais de 7 dias"
- "Você criou 12 tarefas esta semana mas completou apenas 4"

### 015-C: Proactive Nudges

Seraphine inicia conversa quando detecta algo relevante:

**Triggers:**
- Boot matinal → briefing com insights pendentes
- Tarefa atrasada 3+ dias → "O FP ainda não pagou, quer que eu cobre?"
- Padrão financeiro detectado → mostra insight card no dashboard
- Hábito quebrado → "Faz 3 dias que não registra exercício"

**Delivery:**
```python
# Injected no system prompt quando há nudges pendentes:
# "PROACTIVE NUDGES (mention naturally if relevant):
#  - Task 'Cobrar FP' is 5 days overdue
#  - User broke 3-day exercise streak
#  - Spending on food is 40% above monthly average"
```

### 015-D: Weekly Report

Toda segunda-feira, gera relatório semanal automático.

**Conteúdo:**
- Tarefas: criadas vs concluídas vs atrasadas
- Finanças: receita/despesa/saldo da semana
- Hábitos: streaks mantidos/quebrados
- Insights da semana
- Sugestão de foco pra semana

**Delivery:**
- Card especial no chat na primeira interação de segunda
- Opcionalmente enviado por email (Gmail integration)

### 015-E: Insights UI

Card no dashboard e view dedicada acessível pelo nav rail.

**Card:**
```
┌──────────────────────────────────────┐
│ 💡 Insight                          │
│                                      │
│ Seus gastos com alimentação          │
│ aumentaram 25% este mês.            │
│                                      │
│ [Ver detalhes]  [Dispensar]          │
└──────────────────────────────────────┘
```

## Dependências

- Finance module (dados)
- Task system (dados)
- Habits (014, opcional)
- Memory system (persistir insights)
- Dashboard (012, pra mostrar)

## Fora de escopo

- ML predictions (prever gastos futuros)
- Benchmarking contra outros usuários
