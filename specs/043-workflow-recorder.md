# 043 — Workflow Recorder — DEFERRED

## Context

"Grava isso": você executa uma sequência (screen_click + type + key),
Seraphine salva como workflow nomeado, reexecuta com "roda <nome>".
Macros personalizadas via LLM.

## Escopo

- `workflow_start_record(name)` — começa capture. `workflow_stop` —
  finaliza + salva em nova tabela `workflows(name, steps_json)`.
- Tool `workflow_run(name)` — executa passos sequencialmente com
  screenshot entre cada pra verificação.
- UX: UI de gravação dedicada mostrando steps acumulados + re-record
  per step.

## Por que deferred

- Captura de eventos GUI no macOS sem accessibility intrusivo é
  não-trivial. Precisa de CGEventTap (Objective-C / Swift).
- UX complexa — parar no lugar certo, editar passos, re-gravar
  trecho. Não é MVP de 2h.
- Workflow tem brittleness alta — coord. fixas quebram quando layout
  muda. Precisaria vision LLM pra "encontrar botão X" em runtime.

## Next

Reavaliar depois do 035 em produção real por 2 semanas — se clicks
individuais tão confiáveis, adicionar gravação. Senão, repensar a
abstração.
