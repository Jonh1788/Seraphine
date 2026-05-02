# WhatsApp Integration (Evolution API) — Operator SOP

The WhatsApp surface is wired but inert until the Aura number's
WhatsApp session is linked to Evolution. Do this **once** after
deploying T1–T16. Re-run only if Evolution loses the session
(months-long stability is typical).

## 1. Generate secrets

On your local machine:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Run four times and assign the values to:

- `AURA_EVOLUTION_API_KEY` — gates the Evolution REST API.
- `AURA_EVOLUTION_WEBHOOK_TOKEN` — Evolution sends this header on
  every inbound; Aura's webhook 401s if it doesn't match.
- `AURA_WHATSAPP_ADMIN_TOKEN` — gates `/whatsapp/admin/qr` and
  `/whatsapp/admin/status` (you'll use these via curl below).
- `AURA_EVOLUTION_DB_PASSWORD` — Postgres password for the
  `evolution-postgres` sidecar (Evolution v2 dropped the SQLite
  provider; only the two Evolution containers see this).

## 2. Wire env vars on the VPS

SSH the VPS and edit `/var/www/Projeto-Seraphine/apps/aura/.env.prod`.
Set the six new keys (mirror `.env.prod.example`):

```
AURA_EVOLUTION_BASE_URL=http://evolution:8080
AURA_EVOLUTION_API_KEY=<32-byte hex from step 1>
AURA_EVOLUTION_INSTANCE=aura-main
AURA_EVOLUTION_WEBHOOK_TOKEN=<32-byte hex from step 1>
AURA_WHATSAPP_ADMIN_TOKEN=<32-byte hex from step 1>
AURA_EVOLUTION_DB_PASSWORD=<32-byte hex from step 1>
```

### compose-time interpolation gotcha

`apps/aura/docker-compose.yml` references `${AURA_EVOLUTION_API_KEY}`
and `${AURA_EVOLUTION_WEBHOOK_TOKEN}` in the `evolution` service's
`environment:` block. Compose interpolates those at **render time**,
which reads from a top-level `.env` (next to the compose file) **or**
from the shell — NOT from `env_file:` (which only injects vars into
the container at runtime).

Fix: also create `/var/www/Projeto-Seraphine/apps/aura/.env` (or
symlink it to `.env.prod`) carrying at least these two keys, OR
update the post-receive hook to pass `--env-file .env.prod` on the
compose command. The symlink is the lowest-effort path:

```bash
cd /var/www/Projeto-Seraphine/apps/aura
ln -sf .env.prod .env
```

## 3. Deploy

From your local machine:

```bash
git push vps main
```

The post-receive hook rebuilds the stack. Confirm Evolution is up:

```bash
ssh CassinoAPI "cd /var/www/Projeto-Seraphine/apps/aura && \
    docker compose ps evolution evolution-redis"
```

Both containers should report `Up`.

## 4. Create the Aura instance

Evolution requires an explicit instance create call (one-shot):

```bash
ssh CassinoAPI "docker exec aura-backend-1 curl -s -X POST \
    -H 'apikey: \$AURA_EVOLUTION_API_KEY' \
    -H 'Content-Type: application/json' \
    'http://evolution:8080/instance/create' \
    -d '{\"instanceName\":\"aura-main\",\"integration\":\"WHATSAPP-BAILEYS\"}'"
```

Expected: a JSON blob with `"instance":{"instanceName":"aura-main",...}`.

## 5. Pull the QR code and scan it

From your local machine:

```bash
curl -s "https://app.minha-aura.com/whatsapp/admin/qr" \
    -H "X-Aura-Admin-Token: <your AURA_WHATSAPP_ADMIN_TOKEN>" \
    | jq -r .qr | base64 -d > /tmp/aura-wa-qr.png
open /tmp/aura-wa-qr.png  # macOS; use xdg-open on Linux
```

Open WhatsApp on Aura's phone → Settings → Linked Devices → Link a
Device → scan the PNG.

Confirm the link:

```bash
curl -s "https://app.minha-aura.com/whatsapp/admin/status" \
    -H "X-Aura-Admin-Token: <your AURA_WHATSAPP_ADMIN_TOKEN>"
# expect: {"connected": true, "phone": "+55...", "state": "open"}
```

## 6. Manual E2E checklist (post-link)

Run through these in the Aura web app at https://app.minha-aura.com:

- [ ] Open `/perfil`. The WhatsApp row reads "Receba lembretes e
      converse via WhatsApp" with a green **Conectar** button.
- [ ] Click **Conectar**. The two-step modal opens. Enter your own
      phone in international format (e.g. `+55 11 98765-4321`) and
      submit. Within ~5s your phone receives a 6-digit code from
      Aura's number.
- [ ] Paste the code; the modal flashes a green check and closes; the
      Perfil row flips to `● +55 11 9••••-••XX` with a **Sair** button.
- [ ] On WhatsApp, send Aura a plain message: `oi`. Within ~10s you
      get a reply (chat history persists in the web `/chat` view too,
      under the "WhatsApp" conversation thread).
- [ ] Open `/lembretes` (or the chat) and create a reminder for "now
      + 1 minute". Wait. **Both** the web push notification AND a
      WhatsApp message should arrive at roughly the same time.
- [ ] Click **Sair** on the Perfil WhatsApp row. The styled
      confirmation dialog opens. Confirm. The row flips back to
      "Receba lembretes e converse via WhatsApp".
- [ ] Send Aura another `oi` from WhatsApp. **No reply** should
      arrive (verification is gone; the webhook drops your phone as
      unknown).
- [ ] Reconnect via the modal — same code dance — to restore the
      binding. Optional: trigger another reminder to confirm both
      channels resume.

## 7. Routine ops

- **Status check:** `GET /whatsapp/admin/status` (admin token).
- **QR refresh** (if WA session expires): same `GET /whatsapp/admin/qr`
  flow as step 5; existing user verifications survive (the binding
  table is independent of the Evolution session).
- **Logs:** `docker compose logs -f --tail 100 evolution backend` on
  the VPS. The backend logs every webhook decision (`route_inbound
  drop reason=...`) and every reminder fan-out (`reminder channel
  push|whatsapp failed user=... task=...`).

## 8. Rollback

Set `AURA_EVOLUTION_BASE_URL=` (empty) in `.env.prod` and redeploy.
The router stays mounted; `/whatsapp/*` returns 503 ("not
configured") and the reminder dispatcher silently skips the WA arm.
Existing verifications stay in the DB — nothing to clean up. Revert
the env var to bring it back online.
