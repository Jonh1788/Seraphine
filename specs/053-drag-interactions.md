# 053 — Drag Interactions

## Scope

- **Double-click avatar** → toggle main window visibility.
- **Drag avatar window** → smooth reposition + snap on release.
- **Right-click** → native-looking context menu: mute, change
  personality, hide for 1h, quit.
- **Drag file onto avatar** → reads file type and offers action:
  - `.pdf` → "quer que eu resuma?" → document_read
  - `.png/.jpg` → adds to pending images in main chat
  - folder → `list_dir` suggestion
- **Drag text** → classify via LLM, offer actions (save as note,
  create task, explain).

## Implementation

- `avatar-companion` window `onDrop` handler via Tauri file drop event
  (or HTML5 for browser).
- Context menu via `tauri-plugin-menu` or custom HTML overlay.
