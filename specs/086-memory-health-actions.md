# 086 - Memory Health Actions

## Objetivo

Adicionar acoes corretivas ao painel de diagnostico de memoria para que o usuario consiga resolver problemas sem sair da UI.

## Motivacao

- MemoryView mostra status do Ollama, ChromaDB, contagem de facts e ultima reflexao.
- Quando algo esta vermelho, o usuario nao tem como agir — precisa abrir terminal e rodar comandos manuais.
- Operacoes de manutencao (rebuild embeddings, purge orphans, force reflection) devem ser acessiveis com um clique.

## Entregas

1. **Acoes no backend**
   - `POST /memory/actions/rebuild-embeddings` — re-embeda todos os facts no ChromaDB. Retorna progresso via WS (`memory_rebuild_progress` events).
   - `POST /memory/actions/purge-orphans` — remove embeddings no ChromaDB que nao tem fact correspondente no SQLite.
   - `POST /memory/actions/force-reflection` — dispara ciclo de reflexao imediato (extract facts + rebuild profile).
   - `POST /memory/actions/compact` — remove facts com confidence < 0.3 e arquiva facts sem acesso ha 90 dias.
   - `GET /memory/actions/status` — retorna estado de cada acao (idle, running, last_run, last_error).

2. **UI de acoes**
   - Botoes no tab "Audit" do MemoryView, cada um com:
     - Estado: idle (azul), running (spinner), success (verde, desaparece em 5s), error (vermelho com mensagem).
     - Confirmacao antes de executar purge e compact (usa `useConfirm`).
   - Progress bar para rebuild-embeddings (pode levar minutos com muitos facts).

3. **Health checks expandidos**
   - Adicionar ao diagnostico:
     - Orphan count (embeddings sem fact).
     - Low-confidence facts count (< 0.3).
     - Stale facts count (sem acesso ha 90+ dias).
     - Last reflection timestamp.
     - Embedding model version vs current.

## Limites

- Nao adicionar auto-repair — acoes sempre manuais com confirmacao.
- Nao expor delete all facts (destrutivo demais).
- Nao alterar o fluxo automatico de reflexao (proactive scheduler).

## Contratos

- `POST /memory/actions/{action}` -> `{ status: "started" | "already_running" }`
- `GET /memory/actions/status` -> `{ actions: { [name]: { state, last_run, last_error, progress? } } }`
- WS event: `{ type: "memory_rebuild_progress", payload: { done: int, total: int } }`

## Criterios de aceite

- Botao "Rebuild Embeddings" dispara re-embed e mostra progresso.
- Botao "Purge Orphans" remove embeddings orfas com confirmacao.
- Health check mostra contagem de orphans e stale facts.
- Acao em andamento mostra spinner e bloqueia re-click.
- Erro exibido inline no botao.
