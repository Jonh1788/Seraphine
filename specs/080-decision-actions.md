# 080 - Decision Actions

## Objetivo

Fechar o ciclo operacional da Seraphine: detectar contexto, sugerir uma decisao, aplicar uma acao segura, acompanhar o efeito e capturar informacao nova com roteamento inteligente.

## Entregas

1. **Decisoes acionaveis**
   - `POST /work/autopilot/{suggestion_id}/apply`
   - `POST /work/autopilot/{suggestion_id}/dismiss`
   - `POST /work/autopilot/{suggestion_id}/snooze`
   - Acoes persistidas em SQLite para nao reaparecerem imediatamente.

2. **Aplicacao segura do autopilot**
   - Projeto sem tarefa -> cria tarefa vinculada.
   - Projeto vencido -> cria tarefa de replanejamento vinculada.
   - Projeto sem prazo -> cria tarefa para definir prazo.
   - Triagem sem projeto -> retorna instrucao contextual; nao inventa projeto automaticamente.

3. **Detalhe de projeto hidratado**
   - `GET /work/projects/{id}` inclui `items` com dados resumidos de tarefas, notas e triagens vinculadas.

4. **Modo Hoje**
   - `GET /work/today` retorna prioridade principal, projeto em risco, proxima tarefa, proxima decisao e contadores.
   - Dashboard mostra esse bloco como missao operacional.

5. **Inbox com resolucao**
   - Inbox aplica/dispensa/adia sugestoes do autopilot direto dali.

6. **Captura inteligente**
   - `POST /work/capture` classifica texto simples como tarefa, nota ou projeto e auto-vincula quando possivel.
   - Quick Capture passa a usar essa rota.

## Limites

- Acoes destrutivas continuam fora do autopilot.
- Nenhuma sugestao altera prazo/status de projeto sem confirmacao explicita.
- Heuristicas sao deterministicas; ML fica para uma iteracao futura.
