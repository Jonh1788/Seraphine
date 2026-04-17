# 068 — Image Generation

## Provider padrão

**Fal.ai FLUX.1 [schnell]** — $0.003/imagem, ~1.5s. Fallback configurável
via `SERAPHINE_IMAGE_PROVIDER=fal|openai|replicate`.

## Env

- `SERAPHINE_FAL_API_KEY=...`
- `SERAPHINE_IMAGE_DAILY_BUDGET=5.00` (R$ ou USD)
- `SERAPHINE_IMAGE_MODEL=fal-ai/flux/schnell` (ou `/dev`, `/pro` quando
  quality=high)

## Schema

```sql
CREATE TABLE generated_images (
  id         TEXT PRIMARY KEY,
  prompt     TEXT NOT NULL,
  model      TEXT NOT NULL,
  provider   TEXT NOT NULL,
  url        TEXT,
  local_path TEXT,
  cost_usd   REAL,
  created_at TEXT NOT NULL
);
```

Custo acumula por dia via query agregada; tool retorna erro se
excedeu budget.

## Tool

`generate_image(prompt, style?, quality?)`
- style: `photo | illustration | icon | abstract` — prefixa prompt
- quality: `fast | high` (high usa FLUX pro)

Tool baixa a imagem, salva em `~/.seraphine/images/:id.png`, devolve
URL servida via `GET /images/:id`.

## Routes

- `GET /images/:id` → binary PNG (served from local_path)
- `GET /images?limit=20` → histórico
- `DELETE /images/:id`

## Riscos

- **Budget overrun**: hard cap verificado antes de cada call.
- **NSFW/unsafe**: FLUX já tem filtros; não pass-through de
  policy violations.
