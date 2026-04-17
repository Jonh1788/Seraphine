# 038 — Memory Browser UI

## Context

Depois dos SDDs 022-032 o DB ganhou 10+ tabelas de memória:
- facts, user_profile, narratives, decisions
- people, person_mentions
- open_loops, discoveries, finance_nudges
- anticipation_rules, turn_feedback, style_prefs
- voice_memos, daily_reflections

Hoje só `/memory/facts` e `/memory/profile` têm UI. Usuário não sabe o
que Seraphine lembra nem consegue limpar.

## Escopo

### Backend

Endpoint agregador:
- `GET /memory/browser` — retorna contagem por tabela + top 5 mais
  recentes de cada.
- `GET /memory/browser/:type` — paginação por tipo (people,
  narratives, decisions, open_loops, discoveries, finance_nudges,
  voice_memos, reflections).
- `DELETE /memory/browser/:type/:id` — remove item. Tudo auditado via
  event_timeline.

### Frontend

Nova aba "Memory Browser" dentro do MemoryView existente:
- Sidebar com 10 tipos + counts
- Listagem paginada do tipo selecionado
- Card expandível com metadados + ação "esquecer"

## Riscos

- **Delete sem confirm**: modal "isso apaga X da memória da Seraphine.
  Confirma?" pra todos, sem exceção.
- **Performance**: 10 contagens num query cada. Add composite query.
