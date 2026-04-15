# Aura — production deploy

## One-time VPS setup

SSH into the box and install Docker + Compose plugin:

```bash
# Docker official install (Ubuntu/Debian)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# log out + back in, then:
docker compose version   # must be v2+
```

Create the production env file on the VPS (**never commit this**):

```bash
cd /var/www/Projeto-Seraphine/apps/aura
cp .env.prod.example .env.prod
nano .env.prod    # fill in real values

# Generate a strong JWT secret:
openssl rand -hex 32
```

Update the git `post-receive` hook so every push triggers a rebuild:

```bash
sudo nano /srv/git/seraphine.git/hooks/post-receive
```

```bash
#!/bin/bash
set -e
DEPLOY=/var/www/Projeto-Seraphine
GIT_DIR=/srv/git/seraphine.git

git --work-tree=$DEPLOY --git-dir=$GIT_DIR checkout -f main

cd $DEPLOY/apps/aura
# Build + restart. Caddy will auto-fetch Let's Encrypt certs on first
# run (HTTP-01 challenge on :80) — ensure ports 80/443 are open in the
# firewall and no other process is holding them.
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

Follow the logs on the VPS:

```bash
docker compose logs -f caddy frontend backend
```

First boot will:
1. Build both images (~2–4 min).
2. Caddy requests certs for `app.minha-aura.com` and `minha-aura.com`.
3. Nginx starts serving the SPA; backend starts serving the API.

Once healthy, https://app.minha-aura.com should load the UI.

## Google OAuth

Add the production callback to the Google Cloud Console OAuth client:

```
https://app.minha-aura.com/google/oauth/callback
```

(Keep the localhost one too so local dev still works.)

## Data / backups

SQLite lives at `/var/lib/docker/volumes/aura_aura-data/_data/aura.sqlite`.
Back it up with:

```bash
docker compose exec backend sqlite3 /data/aura.sqlite ".backup /data/backup-$(date +%F).sqlite"
docker compose cp backend:/data/backup-$(date +%F).sqlite ./
```

## Operations

| Task | Command |
|---|---|
| Tail all logs | `docker compose logs -f` |
| Restart one service | `docker compose restart backend` |
| Rebuild without push | `docker compose up -d --build` |
| Shell into backend | `docker compose exec backend bash` |
| Migrate DB manually | auto — runs on backend startup |
| Stop everything | `docker compose down` (volumes kept) |
| Wipe everything incl. data | `docker compose down -v` ⚠️ |
