# 084 - Notes: Backlinks, Tags e Inline Tasks

## Objetivo

Evoluir o editor de notas de um CRUD markdown basico para um sistema de conhecimento pessoal com backlinks bidirecionais, tags com filtro, e checkboxes que sincronizam com o TaskService.

## Motivacao

- Notas atuais sao ilhas isoladas — nao ha como conectar "reuniao com joao" a "projeto X".
- Tags existem no modelo mas nao ha UI de filtro.
- Checkboxes em markdown (`- [ ] fazer algo`) nao criam tasks reais, perdendo integracao com TasksView e Inbox.

## Entregas

1. **Backlinks bidirecionais**
   - Sintaxe: `[[titulo da nota]]` no editor.
   - Backend: ao salvar nota, extrair `[[...]]` e persistir em `note_links(source_id, target_id)`.
   - Se a nota alvo nao existe, criar automaticamente como rascunho vazio.
   - `GET /notes/{id}` retorna campo `backlinks: NoteRef[]` — notas que referenciam esta.
   - UI: secao "Referenciada por" no rodape do editor, clicavel.

2. **Tags com filtro lateral**
   - `GET /notes/tags` retorna tags usadas com contagem.
   - Sidebar de tags no NotesView com filtro por clique (multi-select).
   - Tags como pills coloridas no card de cada nota.
   - Autocomplete de tags existentes no editor.

3. **Inline tasks sincronizadas**
   - Parser detecta `- [ ] texto` e `- [x] texto` no markdown.
   - Ao salvar nota: para cada checkbox novo, cria task via TaskService com `source: "note"`, `source_id: note_id`.
   - Toggle de checkbox no editor -> `PATCH /tasks/{id}` para atualizar status.
   - Task completada na TasksView -> atualiza o checkbox na nota.
   - Indicador visual: checkboxes sincronizados tem icone de link.

4. **Busca melhorada**
   - `GET /notes?q=` busca em titulo + conteudo + tags.
   - Highlight do termo encontrado nos resultados.

## Limites

- Nao implementar editor WYSIWYG — continua markdown com preview.
- Nao adicionar pastas/hierarquia de notas.
- Backlinks sao somente entre notas, nao cross-domain (nota->task).

## Contratos

- `POST /notes` / `PATCH /notes/{id}` — body inclui `tags: string[]`, backend extrai links automaticamente.
- `GET /notes/{id}` -> `{ note, backlinks: NoteRef[], linked_tasks: TaskSummary[] }`
- `GET /notes/tags` -> `{ tags: { name: str, count: int }[] }`
- Nova tabela: `note_links(id, source_id, target_id, created_at)`

## Criterios de aceite

- `[[nota X]]` no editor cria link e e clicavel no preview.
- Nota referenciada mostra backlinks.
- Filtrar por tag mostra apenas notas com aquela tag.
- Checkbox criado em nota aparece como task no TasksView.
- Task completada no TasksView marca checkbox na nota.
