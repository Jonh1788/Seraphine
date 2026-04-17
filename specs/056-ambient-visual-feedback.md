# 056 — Ambient Visual Feedback

Avatar visualmente comunica estado interno sem precisar falar.

## Signals → visual mapping

| Condition                         | Effect on avatar |
|-----------------------------------|------------------|
| Mood = concerned (022-B)          | expression stays soft, slower blinks |
| Deep focus detected (028-A)       | sleeping / eyes closed pose (low distraction) |
| Open loop injection_count >= 2    | slight frown (ela ainda tá incomodada) |
| Discovery pendente (030-A)        | sparkle emoji orbitando cabeça |
| Remote approval pendente (045)    | exclamation icon acima, pulsing |
| Finance anomaly (030-B)           | eye-twitch / small concerned glance |

## Implementation

`AmbientVisualState` class observes WS messages and periodic state
fetches (`/memory/browser` counts for pendings). Pushes to
`VrmAvatarController` extensions:

- `setAura(type: 'sparkle' | 'alert' | 'heart' | null)` — 3D sprite
  orbitando cabeça.
- `setSleeping(bool)` — closed eyes + slow breathing.
