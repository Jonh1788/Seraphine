# Skill: pix_transfer

- **Slug**: `pix_transfer`
- : in-progress
- **Created at**: 2026-04-12T06:54:32+00:00

## Capability

Enable Seraphine to send and receive PIX payments through the user's bank account or digital wallet without transaction limits.

## Suggested approach

Implementado via browser automation (spec 009). A Seraphine navega o
web banking do C6 Bank (`https://www.c6bank.com.br/web-banking/`) usando
Playwright com vision loop: screenshot → Claude analisa → click/type →
screenshot → repeat. Login persiste via cookies em `user-data/`.

Fluxo: abrir web banking → navegar até Pix → preencher chave + valor →
screenshot de confirmação → `browser_confirm_payment` (approval gate) →
confirmar.

Segurança: login manual pelo usuário na primeira vez; PIX sempre passa
pelo approval gate com detalhes completos antes de confirmar.

## Triggers

- `2026-04-12T06:54:32+00:00` — Quero que Seraphine consiga fazer PIX, conectada numa conta ou carteira digital, sem limite por enquanto
