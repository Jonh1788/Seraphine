# Skill: web_scraper

- **Slug**: `web_scraper`
- **Status**: implemented
- **Created at**: 2026-04-10T01:31:52+00:00
- **Implemented at**: 2026-04-10T02:05:00+00:00
- **Tool**: `web_fetch` (`backend/seraphine/tools/web.py`, `WebFetchTool`)

## Capability

Acessar e raspar conteúdo de sites web específicos, como manchetes de portais de notícias.

## Implementation notes

- Tool name in registry: `web_fetch`
- Uses `httpx.AsyncClient` with streaming, 5 redirects max, 20s timeout
- HTML parsed via `beautifulsoup4`; strips `script/style/noscript/template/svg/nav/footer/aside`
- Returns title + main text joined by newlines, truncated to `max_chars` (default 8192)
- `requires_confirmation=False` (read-only from user's machine)
- **SSRF protection**: non-http schemes rejected; hostnames resolved
  via `socket.getaddrinfo` and all returned IPs checked against
  `ipaddress.is_private|loopback|link_local|multicast|reserved|unspecified`.
  Private IP literals in URLs also rejected upfront. Covers AWS IMDS
  (`169.254.169.254`), localhost, RFC1918, IPv6 loopback, etc.
- `max_bytes` hard cap (default 2 MB) stops runaway downloads
- 12 unit tests in `backend/tests/test_tool_web.py`

## Triggers

- `2026-04-10T01:31:52+00:00` — Preciso que você acesse a internet e me traga as manchetes do portal G1 agora.
