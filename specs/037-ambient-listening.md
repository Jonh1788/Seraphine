# 037 — Ambient Listening (Opt-in) — DEFERRED

## Context

Mic sempre ligado + detecção de keyword ("sera", "seraphine") antes de
ativar o pipeline completo. Zero round-trip de rede até a palavra-chave
bater.

## Escopo

- Porcupine-rs ou snowboy embedado no Tauri pra wake-word detection.
- Estado "always listening" com LED visual no tray.
- Ao detectar wake-word, muda state pra "active listening" e envia
  áudio pro pipeline normal (Whisper local → user_message).
- Toggle em Settings. Off por default.

## Por que deferred

- Wake-word engine (Porcupine) é pago pra comercial; Snowboy deprecated;
  build custom com audio CNN é trabalho sério.
- Energia: keep-alive no mic tem impacto de bateria em laptop.
- Privacidade: audio buffer contínuo precisa ser sanitizado antes de
  chegar no disco (zero persistência).
- Escopo ~1 semana de trabalho focado.

## Next

Pausado até validação de engine + plano de bateria + consentimento
explícito do usuário em onboarding dedicado.
