# 036 — Dev Sidekick Tools

## Context

Com filesystem + shell via proxy, ela já pode rodar qualquer comando
de dev. Mas ferramentas dedicadas (git_status, run_tests, edit_file)
com contrato estruturado são mais seguras e previsíveis que "roda
`git status`" via run_shell.

## Escopo

**Novos tools** (server-side, todos `proxy_to_client=True`):

- `git_status` — wraps `git status --porcelain=v2 --branch` → JSON
  estruturado (current branch, staged, modified, untracked).
- `git_diff(path?, staged=false)` — diff textual com cap.
- `git_log(limit=10)` — commits recentes com hash/msg/autor.
- `git_branch` — lista branches (local + tracking).
- `run_tests` — detecta framework (pytest/jest/cargo/go) inspecionando
  package.json/pyproject/Cargo.toml e roda o runner; parseia resultado.
- `edit_file(path, old, new)` — patch-style replace (não sobrescreve
  arquivo inteiro). Erro se `old` não bate 100% ou aparece >1x.
- `search_code(query, type?)` — ripgrep wrapper.

**Implementação** reaproveita o proxy: cada tool constrói o comando,
manda via `run_shell` ou abre um novo Rust cmd dedicado se for
hot-path. MVP: só `git_status`, `edit_file`, `run_tests`,
`search_code`.

## Segurança

- `git_status`/`diff`/`log`/`search_code`: `requires_confirmation=False`
  (readonly).
- `edit_file`: `requires_confirmation=True` + preview do diff antes do
  apply.
- `run_tests`: `requires_confirmation=False` mas timeout 5min hard.

## Riscos

- **Framework detection errado**: fallback pede explicitamente.
- **`edit_file` sem exclusividade do `old`**: erro `"ambiguous match"`,
  força LLM adicionar mais contexto.
