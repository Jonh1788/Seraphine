# 025 — Avatar Liveness

## Context

O avatar VRM hoje é bonito mas estático. Fica lá parado com expressão
default, mexe a boca quando fala, olha pro usuário. Quando você sai
pra tomar café e volta, ela tá exatamente igual. Sem "ela tá viva,
tá esperando você".

Esta spec adiciona micro-comportamentos de vida:

- **025-A** — Idle breathing + blinks irregulares
- **025-B** — Reações a eventos (retorno, notification, long pause)
- **025-C** — Ambient glance (olhar que vaga)

Tudo rigorosamente dentro do budget de CPU/GPU atual. Sem nova rig.

## 025-A — Idle Breathing + Blinks

### Respiração

Animação contínua multiplicando scale Z do chest bone (ou equivalente
no humanoidBones) em senóide de 4s, amplitude 1.5%. Roda em
`requestAnimationFrame` delta-time com variação ±10% pra não ficar
mecânica.

```ts
const breathPhase = (now / 4000) % 1;
const amp = 0.015 * (1 + Math.sin(now / 13000) * 0.1);
chest.scale.z = 1 + Math.sin(breathPhase * 2 * Math.PI) * amp;
```

### Blink

Já existe blink loop. Problema: intervalo fixo. Mudar pra
exponencial (média 4s, jitter):

```ts
const next = () => 2000 + Math.random() ** 2 * 6000;  // 2-8s
```

Ocasionalmente blink duplo (10% das vezes) — soa mais humano.

## 025-B — Reações a Eventos

### Trigger: retorno depois de ausência

Quando WS reconecta após > 10min:

1. Avatar faz "attention turn" — cabeça gira +5° na direção do
   cursor/tela, olhar foca.
2. Leve smile bump (blendshape `happy` interpola 0→0.15 em 200ms).
3. Retorna ao idle depois de 2s.

### Trigger: notification chega

Avatar vira a cabeça brevemente (rotação Y +15°) na direção onde o
toast aparece, e volta. Duração total 600ms. Não atrapalha idle.

### Trigger: long pause

Se não tem input do usuário há 5min:

- 30% chance: yawn pequeno (blendshape A 0→0.4→0, duração 1s)
- 30% chance: olhar relógio (cabeça inclina direita 10°, 500ms)
- 30% chance: coçar cabeça (se tem bone braço) OU smile sutil
- 10%: nada

Usa `setTimeout` com jitter 4-7min. Só roda enquanto a janela do
avatar tá visível (skip se minimizado).

## 025-C — Ambient Glance

Olhar (eyeRotation Y/X) vaga em pontos aleatórios a cada 3-6s por
400ms, depois volta pro target (o usuário ou cursor). Amplitude
pequena (±0.15 rad). Humaniza — olhos não ficam vidrados num ponto.

## Infraestrutura

Novo arquivo `avatar/liveness/AvatarLiveness.ts`:

```ts
export class AvatarLiveness {
  constructor(private controller: VrmAvatarController) {}

  start(): void {
    this.breathLoop();
    this.scheduleBlink();
    this.scheduleGlance();
    this.scheduleIdleReaction();
  }

  stop(): void { /* clear all timers */ }

  onReturn(): void { /* attention turn + smile bump */ }
  onNotification(dir: 'top' | 'bottom' | 'left' | 'right'): void { }
}
```

Integrado no `VrmAvatarController.ts` no mount:

```ts
this.liveness = new AvatarLiveness(this);
this.liveness.start();
```

WS handler em `App.tsx` chama `liveness.onReturn()` quando status
vira 'connected' depois de 'disconnected' > 10min. E
`onNotification()` no dispatch de push.

## Entregáveis

- [ ] `AvatarLiveness.ts` com 4 loops (breath, blink, glance, idle).
- [ ] 3 trigger methods (onReturn, onNotification, onLongPause).
- [ ] Integração no `VrmAvatarController`.
- [ ] WS events hook em App.tsx.
- [ ] Kill switch: config `SERAPHINE_AVATAR_LIVENESS=true`.
- [ ] Performance check: frame time < 16ms sustentado.

## Riscos

- **Distração**: animação constante atrás pode irritar durante deep
  focus. Mitigação: mood "focused" reduz amplitude em 50%.
- **CPU**: VRM blendshape update é barato (~0.3ms). Breath bone é
  1 matrix update. Ambient glance = 1 quaternion slerp. Total OK.
- **Uncanny valley**: demasiado humano, fica estranho. Ficar discreto
  — amplitudes pequenas, jitter, não síncrono.
