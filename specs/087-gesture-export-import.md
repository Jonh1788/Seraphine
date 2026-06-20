# 087 - Avatar Lab: Export/Import de Gestos

## Objetivo

Permitir exportar e importar definicoes de gestos customizados do Avatar Lab como arquivos JSON, habilitando backup, compartilhamento e portabilidade entre instalacoes.

## Motivacao

- Gestos customizados criados no AnimationLab sao salvos apenas no backend local.
- Reinstalar o app ou usar em outro Mac perde todos os gestos.
- Nao ha como compartilhar gestos entre usuarios.

## Entregas

1. **Export individual**
   - Botao "Export" no card de cada gesto na biblioteca do AvatarLab.
   - Gera arquivo `.sera-gesture.json` com schema versionado.
   - Usa File Save dialog nativo (Tauri `dialog.save`).

2. **Export em lote**
   - Botao "Export All" na toolbar da biblioteca.
   - Gera `.sera-gestures.json` com array de todos os gestos.

3. **Import**
   - Botao "Import" na toolbar da biblioteca.
   - Aceita `.sera-gesture.json` (single) e `.sera-gestures.json` (batch).
   - Validacao: schema version, bone names validos, keyframe integrity.
   - Conflito de nome: dialog pergunta "Substituir / Renomear / Pular".
   - `POST /lab/gestures/import` com body do JSON.

4. **Schema versionado**
   - `{ version: 1, exported_at, gestures: GestureDefinition[] }`
   - `GestureDefinition` inclui name, category, duration, tracks (bone keyframes com tangents), metadata.
   - Migracoes automaticas de versoes futuras via `gestureMigrations.ts`.

5. **Backend routes**
   - `GET /lab/gestures/export` -> JSON com todos os gestos.
   - `GET /lab/gestures/{id}/export` -> JSON de um gesto.
   - `POST /lab/gestures/import` -> importa gestos com conflito handling.

## Limites

- Nao implementar repositorio online de gestos (marketplace).
- Nao validar contra o modelo VRM atual (gestos podem referenciar bones que existem em outros modelos).
- Export nao inclui animacoes Mixamo/BVH importadas — apenas gestos procedurais.

## Criterios de aceite

- Export de gesto individual gera JSON valido.
- Import de JSON cria gestos no backend e aparecem na biblioteca.
- Conflito de nome mostra dialog de resolucao.
- JSON invalido mostra erro claro.
- Round-trip: export -> import em instalacao limpa preserva todos os gestos.
