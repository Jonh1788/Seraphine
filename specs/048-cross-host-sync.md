# 048 — Cross-host file sync + secrets

## Scope

- `ssh_copy` — scp wrapper para mover arquivos entre hosts ou
  host→local.
- `secret_set(host, key, value)` — guarda em keychain nativo (arboard
  pode NOT, usar `security add-generic-password` via shell).
- `ssh_run_with_secret(host, key, command)` — injeta via env var
  `$SECRET_<KEY>`, nunca loga valor.
