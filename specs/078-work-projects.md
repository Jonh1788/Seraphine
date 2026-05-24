# 078 - Work Projects

## Objetivo

Transformar `Trabalhos` de uma colecao visual de tarefas/triagens em um hub real de trabalho. O hub deve persistir projetos, ligar tarefas/triagens/notas/links a esses projetos, permitir criacao por UI ou chat, e gerar briefing acionavel sem depender de agrupamento inferido por tag.

## Entregas

1. **Modelo real de Projetos**
   - Persistir projetos em SQLite via `work_projects`.
   - Campos: nome, descricao, area, status, prioridade, tags, links, prazo e timestamps.
   - Persistir vinculos em `work_project_links` com tipo, id externo, titulo e metadados.

2. **Detalhe de Projeto**
   - `GET /work/projects/{id}` retorna projeto, vinculos e um resumo operacional.
   - O frontend deve abrir um detalhe de projeto dentro da aba `Trabalhos`.

3. **Criar Trabalho via Chat e UI**
   - UI cria projeto sem sair de `Trabalhos`.
   - Ferramentas de chat: criar, listar e vincular item a projeto.

4. **Inbox por Contexto**
   - A Inbox passa a reconhecer projetos como contexto proprio.
   - Projetos de alta prioridade ou vencidos entram como itens de atencao.

5. **Rotinas ligadas a Trabalho**
   - Rotinas prontas para planejar projeto, revisar sprint, fechar entrega e preparar reuniao de projeto.

6. **Briefing de Trabalho**
   - `GET /work/briefing` agrega projetos ativos, tarefas abertas, triagens em andamento e proximos prazos.
   - O hub mostra esse briefing como fonte primaria da visao geral.

## Nao objetivos

- Nao trocar o backend LLM: o runtime continua usando cliproxy conforme decisao anterior.
- Nao migrar tarefas para dentro de projetos nesta iteracao; vinculos sao associativos.
- Nao alterar o fluxo de triagem de CV existente.

## Contratos

- Todas as rotas ficam sob `/work`.
- Retornos principais:
  - `GET /work/projects` -> `{ projects: WorkProject[] }`
  - `POST /work/projects` -> `{ project: WorkProject }`
  - `GET /work/projects/{id}` -> `{ project, links, summary }`
  - `POST /work/projects/{id}/links` -> `{ link }`
  - `GET /work/briefing` -> `{ projects, open_tasks, active_triages, due_projects }`

## Criterios de aceite

- Build do frontend passa.
- Backend compila com os novos modulos.
- Um projeto criado pela UI aparece na aba `Projetos` e no briefing.
- Ferramenta de chat consegue criar/listar projetos.
- Inbox inclui projetos urgentes sem quebrar filtros existentes.
