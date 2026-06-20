# 095 - Contextual Shortcuts por App Ativo

## Objetivo

Expandir o `activeAppReactor` para oferecer acoes contextuais relevantes baseadas no app que o usuario esta usando, tornando a Seraphine uma assistente proativa que sabe o que oferecer em cada contexto.

## Motivacao

- `activeAppReactor` ja detecta o app ativo e muda a expressao do avatar.
- Mas nao oferece acoes — e puramente visual.
- "VS Code ativo -> oferecer git status" e mais util que "VS Code ativo -> expressao focada".

## Entregas

1. **Registry de acoes por app**
   - Configuracao declarativa mapeando app -> acoes disponíveis:
   ```
   VS Code / Cursor:
     - "Rodar testes" -> run_tests tool
     - "Git status" -> git_status tool
     - "Explicar arquivo aberto" -> context from active file
     - "Commit changes" -> git_diff + commit wizard

   Safari / Chrome / Arc:
     - "Salvar pagina" -> save_reading_item (spec 091)
     - "Resumir pagina" -> web_fetch + summarize
     - "Adicionar a reading list" -> save_reading_item

   Spotify / Apple Music:
     - "O que ta tocando?" -> now_playing tool
     - "Salvar playlist" -> learn_music_taste tool

   Slack / Discord:
     - "Resumir canal" -> clipboard assist
     - "Criar task dessa conversa" -> add_task

   Terminal / iTerm / Warp:
     - "Explicar ultimo comando" -> clipboard + LLM
     - "Debug output" -> clipboard + LLM

   Zoom / Google Meet / FaceTime:
     - "Preparar reuniao" -> meeting prep routine
     - "Notas da reuniao" -> create_note with meeting context

   Finder:
     - "Buscar arquivo" -> list_dir + search
     - "Abrir no terminal" -> open_path
   ```

2. **Companion window shortcuts**
   - No AvatarCompanion, mostrar ate 3 acoes contextuais como pills flutuantes abaixo do avatar.
   - Pills aparecem com fade-in 2s apos detectar app estavel (nao durante troca rapida).
   - Clicar na pill executa a acao (envia como mensagem para o chat via WS).
   - Pills desaparecem apos 30s sem interacao.

3. **Command palette integration**
   - Cmd+K mostra acoes contextuais no topo dos resultados, marcadas com badge do app ativo.
   - Acoes contextuais tem prioridade sobre acoes genericas na busca fuzzy.

4. **Voice shortcuts**
   - No realtime mode, acoes contextuais sao atalhos de voz:
     - "Roda os testes" (VS Code ativo) -> executa sem precisar dizer "Sera, roda os testes do projeto seraphine no diretorio..."
   - Contexto do app ativo injetado automaticamente no system prompt durante realtime.

5. **Aprendizado**
   - Registrar quais acoes contextuais o usuario usa por app.
   - Reordenar pills baseado em frequencia de uso.
   - Persistir em `contextual_action_usage(app_name, action_id, used_at)`.

6. **Configuracao**
   - Settings: toggle global de contextual shortcuts.
   - Per-app: desativar ou customizar acoes.
   - Adicionar app customizado: nome do processo + lista de acoes.

## Limites

- Depende do Tauri (activeApp via proxy) — nao disponivel no PWA.
- Nao executar acoes automaticamente — sempre require clique ou comando de voz.
- Nao ler conteudo da tela para contexto (spec 035 ja cobre screen automation como tool separado).
- Maximo de 3 pills no companion para nao poluir.

## Contratos

- Configuracao em `~/.seraphine/contextual-actions.json` (user-editable).
- `GET /settings/contextual-actions` -> config atual com usage stats.
- `PATCH /settings/contextual-actions` -> update config.
- WS event `contextual_actions_update`: `{ app: str, actions: Action[] }` quando app ativo muda.

## Criterios de aceite

- VS Code ativo -> companion mostra "Rodar testes", "Git status".
- Safari ativo -> companion mostra "Salvar pagina", "Resumir".
- Cmd+K com VS Code ativo mostra acoes de dev no topo.
- Acao usada 5x sobe para primeira posicao.
- App nao mapeado -> nenhuma pill (nao quebra).
