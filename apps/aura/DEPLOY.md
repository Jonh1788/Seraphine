# Aura — production deploy

TLS lives on the **host nginx** (which already exists on this VPS for
other apps). This compose stack runs the backend + frontend containers
on the internal Docker network and exposes the frontend only on
`127.0.0.1:8080`. The host nginx proxies `app.minha-aura.com` → `:8080`,
and certbot issues the Let's Encrypt cert.

## One-time VPS setup

1. **Docker + Compose plugin** (skip if already installed):
   ```bash
   curl -fsSL https://get.docker.com | sh
   docker compose version   # must be v2+
   ```

2. **Production env file** (never commit this):
   ```bash
   cd /var/www/Projeto-Seraphine/apps/aura
   cp .env.prod.example .env.prod
   nano .env.prod    # fill AURA_JWT_SECRET, AURA_ANTHROPIC_API_KEY,
                     # AURA_GOOGLE_CLIENT_ID, AURA_GOOGLE_CLIENT_SECRET

   # Generate a strong JWT secret:
   openssl rand -hex 32
   ```

3. **Host nginx vhost** for the public domains:
   ```bash
   sudo cp /var/www/Projeto-Seraphine/apps/aura/nginx-host.conf \
           /etc/nginx/sites-available/aura
   sudo ln -sf /etc/nginx/sites-available/aura /etc/nginx/sites-enabled/aura
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. **TLS cert via certbot** (adds the HTTPS server block automatically):
   ```bash
   sudo certbot --nginx -d app.minha-aura.com -d minha-aura.com -d www.minha-aura.com
   ```

5. **Auto-deploy hook** — edit `/srv/git/seraphine.git/hooks/post-receive`:
   ```bash
   #!/bin/bash
   set -e
   DEPLOY=/var/www/Projeto-Seraphine
   GIT_DIR=/srv/git/seraphine.git

   git --work-tree=$DEPLOY --git-dir=$GIT_DIR checkout -f main

   cd $DEPLOY/apps/aura
   docker compose up -d --build
   ```
   ```bash
   sudo chmod +x /srv/git/seraphine.git/hooks/post-receive
   ```

## First deploy

From the Mac:

```bash
git push vps main
```

Tail on the VPS:

```bash
cd /var/www/Projeto-Seraphine/apps/aura
docker compose logs -f
```

First boot builds both images (~2–4 min).

## Google OAuth

Add the production callback URL to the Google Cloud Console OAuth client:

```
https://app.minha-aura.com/google/oauth/callback
```

(Keep `http://localhost:8001/google/oauth/callback` too for local dev.)

## Operations

| Task | Command (run from `/var/www/Projeto-Seraphine/apps/aura`) |
|---|---|
| Tail all logs | `docker compose logs -f` |
| Restart one service | `docker compose restart backend` |
| Rebuild without push | `docker compose up -d --build` |
| Shell into backend | `docker compose exec backend bash` |
| DB backup | `docker compose exec backend sqlite3 /data/aura.sqlite ".backup /data/backup-$(date +%F).sqlite" && docker compose cp backend:/data/backup-$(date +%F).sqlite ./` |
| Stop everything | `docker compose down` (volumes kept) |
| Wipe everything incl. data | `docker compose down -v` ⚠️ |

## Troubleshooting

**`502 Bad Gateway` from the browser** — the backend container is down.
`docker compose logs backend` to see why. A common cause is a missing
env var in `.env.prod` (the container will restart-loop).

**Certbot: "challenge failed"** — check that `app.minha-aura.com`
resolves to the VPS IP (`dig +short app.minha-aura.com`) and that
Cloudflare proxy is OFF (grey cloud) so HTTP-01 reaches the host.
