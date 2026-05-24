# 079 - Work Autopilot

## Objetivo

Fazer a Seraphine operar o contexto de trabalho de forma mais ativa: detectar projetos sem proxima acao, vincular itens novos ao projeto certo, mostrar trabalho no Dashboard, renderizar projetos no chat e priorizar decisoes na Inbox.

## Entregas

1. **Autopilot de Trabalho**
   - `GET /work/autopilot` retorna sugestoes calculadas a partir de projetos, links, tarefas e triagens.
   - Sugestoes iniciais: projeto sem tarefa vinculada, projeto vencido, projeto de alta prioridade sem prazo, triagem ativa sem projeto.

2. **Vinculacao Inteligente**
   - `WorkProjectService.auto_link_item()` tenta vincular tarefas, notas e triagens novas a projetos ativos.
   - Heuristica inicial: nome, area e tags do projeto contra titulo/texto do item.

3. **Dashboard de Trabalho**
   - Dashboard consome `/work/briefing` e `/work/autopilot`.
   - Mostra projetos ativos, prazos, triagens em andamento e primeira acao sugerida.

4. **Project Chat Blocks**
   - Ferramentas de trabalho retornam `metadata.project`.
   - Chat renderiza `WorkProjectChatBlock` e persiste `<!--project-data:...-->` para reload.

5. **Inbox de Decisao**
   - Inbox ganha filtro `decisions`.
   - Projetos urgentes e sugestoes do autopilot entram como itens de decisao.

6. **Rotinas Executaveis**
   - Rotinas de trabalho orientam a Sera a usar ferramentas reais: listar/criar projetos, criar tarefas e vincular itens.

## Nao objetivos

- Nao criar modelo de ML para classificacao de projetos nesta iteracao.
- Nao executar sugestoes automaticamente sem confirmacao.
- Nao mudar o backend LLM: cliproxy continua sendo o caminho padrao.

## Criterios de aceite

- Backend compila.
- Frontend builda.
- `/work/autopilot` responde com `{ suggestions: [] }` mesmo sem projetos.
- Criacao de tarefa via chat tenta auto-link com projeto ativo compativel.
- Chat mostra card de projeto para criar/listar/vincular.
