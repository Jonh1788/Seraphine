# 088 - Mood Tracking + Correlacoes

## Objetivo

Persistir o humor inferido pela Seraphine durante conversas como serie temporal e criar visualizacoes + correlacoes com saude e produtividade.

## Motivacao

- O avatar ja recebe `mood` events do backend via WS com labels de emocao (happy, sad, excited, thinking, etc.).
- Esses dados sao efemeros — usados apenas para animar o avatar e descartados.
- Persistir humor como serie temporal abre correlacoes valiosas (sono vs humor, exercicio vs humor, produtividade vs humor).

## Entregas

1. **Persistencia de mood**
   - Nova tabela: `mood_logs(id, timestamp, label, valence, arousal, source, turn_id)`
   - `valence`: -1.0 (negativo) a +1.0 (positivo). Mapeado automaticamente do label.
   - `arousal`: 0.0 (calmo) a 1.0 (energetico). Mapeado do label.
   - `source`: `conversation` (inferido do chat), `manual` (input direto do usuario), `voice` (futuro: prosody).
   - Backend: ao emitir `mood` event no conversation engine, tambem persistir no SQLite.

2. **Mapeamento de labels**
   - Tabela fixa no codigo:
     - happy: valence=0.8, arousal=0.6
     - sad: valence=-0.6, arousal=0.3
     - excited: valence=0.9, arousal=0.9
     - frustrated: valence=-0.7, arousal=0.8
     - calm/soft: valence=0.4, arousal=0.2
     - thinking: valence=0.1, arousal=0.4
     - worried: valence=-0.4, arousal=0.6
     - sarcastic: valence=0.0, arousal=0.5
     - laughing: valence=0.9, arousal=0.8
     - warm: valence=0.7, arousal=0.4

3. **Mood widget no dashboard**
   - Grafico de linha com valence media por dia nos ultimos 14 dias.
   - Ponto colorido por label predominante do dia.
   - Hoje: mood atual com icone de expressao.

4. **Mood check-in manual**
   - Quick action no dashboard ou via chat: "como voce ta se sentindo?"
   - Slider de valence + arousal ou selecao de emoji predefinido.
   - Persiste como source=manual.

5. **API**
   - `GET /mood/today` -> `{ current: MoodLog, avg_valence, avg_arousal, logs: MoodLog[] }`
   - `GET /mood/trend?days=N` -> `{ days: { date, avg_valence, avg_arousal, predominant_label }[] }`
   - `POST /mood/checkin` -> `{ label, valence?, arousal? }`

6. **Correlacoes com InsightEngine**
   - Alimentar o correlation engine (spec 085) com `mood_avg_valence` como serie temporal.
   - Correlacoes: sono vs humor, exercicio vs humor, tasks_completed vs humor.

7. **Alertas proativos**
   - Se valence media dos ultimos 3 dias < -0.3, Seraphine pergunta proativamente: "Notei que os ultimos dias foram mais pesados. Quer conversar sobre isso?"
   - Rate-limited a 1x por semana.

## Limites

- Nao usar analise de voz/prosody nesta versao (source=voice e placeholder).
- Nao implementar diagnostico clinico — apenas tracking pessoal.
- Nao compartilhar dados de humor com terceiros.

## Criterios de aceite

- Mood events da conversa sao persistidos no SQLite.
- Dashboard mostra grafico de humor dos ultimos 14 dias.
- Check-in manual cria mood log.
- Alerta proativo dispara apos 3 dias negativos.
- Trend API retorna dados corretos.
