# 085 - Cross-Domain Insights

## Objetivo

Expandir o InsightEngine para gerar correlacoes entre dominios (saude, produtividade, financas, habitos), transformando insights isolados em descobertas acionaveis que cruzam dados.

## Motivacao

- InsightEngine atual analisa cada dominio independentemente (finance, tasks, habits).
- O valor real esta nas correlacoes: sono vs produtividade, exercicio vs humor, gastos vs quebra de habitos.
- HealthKit, water, habits, tasks e finance ja tem dados historicos suficientes para correlacoes significativas.

## Entregas

1. **Correlation engine**
   - Novo modulo `seraphine/insights/correlations.py`.
   - Calcula correlacoes entre pares de series temporais (janela de 30 dias):
     - `sleep_hours` vs `tasks_completed`
     - `sleep_hours` vs `focus_minutes` (quando spec 090 existir)
     - `steps` vs `tasks_completed`
     - `workouts_count` vs `stalled_tasks`
     - `water_intake_pct` vs `tasks_completed`
     - `delivery_spend` vs `cooking_habit_streak`
     - `exercise_streak` vs `mood_avg` (quando spec 089 existir)
   - Usa Pearson correlation; reporta apenas |r| > 0.4 com p < 0.05.

2. **Insight types expandidos**
   - Novo tipo `cross_domain` alem dos existentes (`finance`, `task`, `habit`).
   - Template natural: "Nos ultimos 30 dias, nos dias que voce dormiu mais de 7h, completou 2.3x mais tarefas."
   - LLM formata a mensagem a partir do template + dados.

3. **Weekly correlations digest**
   - Adicionado ao weekly report existente como secao "Conexoes descobertas".
   - Top 3 correlacoes mais fortes da semana.

4. **API**
   - `GET /insights?type=cross_domain` filtra apenas insights de correlacao.
   - `GET /insights/correlations` retorna todas as correlacoes ativas com r, p, e mensagem.

5. **Dashboard widget**
   - InsightsDashboardWidget prioriza cross-domain insights sobre single-domain.
   - Card com icone de "conexao" distinto dos insights normais.

## Limites

- Correlacao nao e causalidade — mensagens sempre usam "nos dias que X, Y tende a Z", nunca "X causa Y".
- Nao implementar ML/regressao — Pearson simples e suficiente para v1.
- Nao alertar em tempo real — correlacoes calculadas no refresh periodico (6h).

## Dados necessarios

| Serie | Fonte | Granularidade |
|-------|-------|---------------|
| sleep_hours | health_snapshots | diaria |
| steps | health_snapshots | diaria |
| workouts_count | health_workouts | diaria |
| tasks_completed | seraphine_tasks (status=done, updated_at) | diaria |
| water_intake_pct | water_logs / water_profiles | diaria |
| habit_streak | habit_logs | diaria |
| finance_by_category | finance_entries | diaria |

## Criterios de aceite

- Insight cross-domain aparece no InsightsView com tipo distinto.
- Weekly report inclui secao de correlacoes.
- Correlacao com |r| < 0.4 nao e exibida.
- Dashboard widget mostra insight cross-domain quando disponivel.
- Mensagens nunca afirmam causalidade.
