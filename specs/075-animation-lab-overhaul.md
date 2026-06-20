# 075 — Animation Lab Overhaul

## Contexto

O Animation Lab atual (`apps/seraphine/frontend/src/lab/AnimationLab.tsx`,
~1500 linhas) cumpre o essencial — edição de keyframes FK, timeline SVG,
gizmo 3D, F-Curves bezier, onion skin, salvar/exportar TS — mas tem
buracos que doem no uso diário e limitações que bloqueiam gestos de
qualidade:

- **Sem Undo/Redo.** Qualquer erro de edição é irreversível. Único
  risco real de perder trabalho no lab.
- **Sem snap, zoom ou frame stepping** na timeline. Gestos >2 s ficam
  ilegíveis; alinhamento é visual, nunca exato.
- **Hard-cut entre gestos.** `GesturePlayer` só executa 1 por vez, sem
  queue nem crossfade — wave → nod é descontínuo.
- **F-Curves escondidas** por default e só aparecem com exatamente 1 kf
  selecionado. Autoria de easing é friction.
- **Editar lado direito e espelhar no esquerdo = copy-paste manual.**
- **Nenhum IK.** Apontar, alcançar ponto, look-at target preciso — tudo
  Euler delta por bone, que é caro e impreciso.
- **Import de motion externo (Mixamo BVH) não existe.** Hoje FBX só roda
  como AnimationClip paralelo; não vira gesture editável.
- **JSON sem versionamento.** Qualquer mudança de schema quebra gestos
  salvos silenciosamente.
- **Zero testes** em `gestures.ts` / `AnimationLab.tsx` — regressão visual
  escapa.
- **UI meio datada.** Header achatado, inspector sem hierarquia, botões
  genéricos, feedback visual fraco. Lab é ferramenta de uso intenso e
  merece tratamento de ferramenta.

Este SDD cobre a **reforma completa** em fases entregáveis
independentemente. Cada fase = PR ou série curta de commits que deixa o
lab em estado funcional.

## Escopo — 5 Fases

### Fase 1 — UI Repaginada + Quick Wins (começa aqui)

**UI Redesign** (`lab/AnimationLab.tsx` + `styles.css`):
- Novo layout 3-colunas explícito: **esquerda** = library + bone outliner,
  **centro** = viewport 3D, **direita** = inspector contextual. Timeline
  ocupa a faixa inferior full-width com F-Curves colapsáveis abaixo.
- Header fino (32 px) com título + gesture selector + duração + status
  (●saved / ●unsaved / ●playing). Botões de ação (Salvar, TS, Play,
  Onion, Reset) agrupados à direita com ícones inline (padrão
  `Icons.tsx`, **sem emojis** — ref `feedback_no_emojis.md`).
- Tokens novos por escopo no lab (sem tocar no global): `--lab-bg-panel`,
  `--lab-border-soft`, `--lab-shadow-inset`, mapeados sobre `--bg-*` e
  `--accent-*` existentes. Preserva tema light/dark/pink.
- Inspector com **cards** (não linhas crua): nome do bone + badge com
  rotação absoluta aproximada + 3 sliders X/Y/Z com trilhos coloridos
  (red/green/blue) e thumbs finos, input numérico tabular alinhado à
  direita.
- Bone outliner com **hierarquia indentada** (baseada em
  `BONE_CONNECTIONS`), não lista plana. Bones com keyframe ganham dot
  accent à direita (já existe, repaginar tamanho/cor).
- Timeline: grid fino vertical por `tickStep`, tracks com
  `stripe-odd/even` sutil, diamantes com halo de seleção, playhead com
  haste mais fina + cap triangular no topo, rubber-band com cantos
  arredondados.
- Toast de feedback (`anim-lab__feedback`) reposicionado pro canto
  inferior-direito, pequeno, com ícone de status.
- Cheat sheet discreto: botão `?` no canto direito abre popover com
  atalhos (I, Del, Ctrl+Z/C/X/V/A/S, Shift+drag, ←/→, Space=play).

**Quick wins funcionais:**
1. **Undo/Redo.** Command pattern interno em
   `lab/undoStack.ts`: cada mutação (add/delete/move kf, edit tangent,
   change duration) empurra um `{ apply(): void; revert(): void }`. Stack
   limitado a 100 entradas. Atalhos: `Cmd/Ctrl+Z` = undo,
   `Cmd/Ctrl+Shift+Z` = redo.
2. **Snap-to-grid.** `Shift+drag` em keyframes da timeline snapa no
   tickStep (0.25 s ou 0.5 s). `Alt+drag` = sub-tick (0.05 s). Indicador
   visual: linhas verticais acinzentadas aparecem enquanto segura Shift.
3. **Zoom/pan na timeline.** `Ctrl+wheel` = zoom centrado no playhead,
   com clamp [0.25x, 8x]. `Space+drag` (ou middle-drag) = pan. Novo
   `viewStartT` / `viewEndT` em vez de `[0, duration]` direto.
4. **Frame stepping.** ←/→ move scrub em 1/60 s; `Shift`+← / →
   salta de keyframe a keyframe (nearest neighbor).
5. **Space = play/pause** (toggle). Hoje botão só.
6. **Skeleton overlay toggle.** Já existe `SkeletonHelper` instanciado,
   só expor checkbox no header (default on = como hoje).
7. **Hover tooltip nos bones 3D.** Raycaster passivo on `pointermove`
   (throttle 50 ms) → caixa flutuante "bone: nome — delta: (x°, y°, z°)".
8. **Blink jitter** (`VrmAvatarController.ts` scheduleBlink): duração
   hoje fixa → `90 + Math.random()*80` ms.

### Fase 2 — Animation Quality

1. **Gesture crossfade + queue** (`gestures.ts` GesturePlayer):
   - Nova API: `play(gesture, { fadeInMs, fadeOutMs, queue })`.
   - Internamente manter até 2 gestos ativos (outgoing + incoming) por
     até `max(fadeOutMs, fadeInMs)` ms, slerpando offsets por bone
     ponderados pelo blend factor.
   - `queue: true` enfileira em vez de cancelar.
   - `getOffset(bone)` retorna o offset composto.
2. **F-Curves sempre visíveis.** Painel inferior permanente (colapsável,
   não hidden). Quando múltiplos kfs selecionados, mostra curve do bone
   do `primaryIdx`. Quando nada selecionado, mostra kfs do último bone
   tocado.
3. **Mirror L↔R.** Botão "Mirror selection" no inspector: duplica kfs
   selecionados, substitui prefixo `left↔right` no bone, inverte sinal de
   Y e Z (X mantém — axis de flexão). Idempotente.
4. **Layers por parte do corpo.** Novo campo `layer?: 'upper' | 'lower'
   | 'full'` em `GestureDefinition`. Player escolhe offsets por bone
   baseado no layer do gesto ativo (gesto upper não sobrescreve pernas).
   Default `full` mantém comportamento atual.

### Fase 3 — IK Foundation (head look-at)

- **Solver:** `three/examples/jsm/animation/CCDIKSolver.js` (já
  disponível com `three@0.169`, zero novas deps).
- **Arquitetura em `lab/ikSolver.ts`:** wrapper que recebe VRM + nome de
  chain + target world-position → computa quaternions finais e os aplica
  via `setBoneDelta` com `blend ∈ [0,1]`.
- **Schema v2** do `GestureDefinition`:
  ```ts
  export interface IKTarget {
    id: string;              // uid para drag/delete
    chain: 'head' | 'leftArm' | 'rightArm' | string;
    time: number;
    duration: number;        // fade-in da influência
    blend: number;           // peso FK↔IK, 0..1
    target: { x: number; y: number; z: number }; // world ou rig-local
    space: 'world' | 'rig';
  }
  export interface GestureDefinition {
    version?: 2;
    name: string;
    duration: number;
    keyframes: GestureKeyframe[];
    ikTargets?: IKTarget[];  // Phase 3+
    layer?: 'upper' | 'lower' | 'full';  // Phase 2
  }
  ```
  Migration no load: defs sem `version` → trata como v1, wrapa sem
  ikTargets, marca `version: 2` ao salvar.
- **Chain `head`** = 1-bone (head apontando pra target world-pos). É
  trivial (sem CCD, só `lookAt()` + quaternion diff). Usar como sanity
  check antes de tentar chains maiores.
- **UI:** botão `+ IK target` no inspector (quando bone head/hand
  selecionado) → gizmo TranslateControls aparece num proxy-mesh no
  viewport. Drag = edita `target`. Painel do IK target (igual ao
  inspector de kf) mostra time, blend, delete.
- **Integração com FK:** `applyPostUpdate` passa a rodar:
  1. FK deltas (como hoje)
  2. Se ikTarget ativo no tempo corrente: CCD roda, produz `qIk`;
     `final = slerp(qFk, qIk, blend * activeFactor)` onde `activeFactor`
     respeita fade in/out.
  3. Se CCD divergir (residual > threshold), fallback pro FK puro sem
     warning visual.

### Fase 4 — IK Arm Reach

- **Chain `{left,right}Arm`** = upper+lower+hand (3 bones). CCD com 3–5
  iterações por frame, target hint = cotovelo apontado pra fora.
- **UI set-target por clique 3D:** botão "Set hand target" ativa
  picking mode; próximo click em qualquer ponto no viewport cria
  `ikTarget` na posição world + plano camera-facing.
- **Foot planting (opcional, só se sobrar tempo na fase):** chain de 3
  bones (upper+lower+foot) com target Y=0 fixo, blend=1 só quando
  `gesture.layer === 'upper'` (pra não conflitar com pernas animadas).
- **Cotovelo hint:** vetor de preferência no `IKTarget` para evitar que
  cotovelo atravesse o peito. Default = apontando pra fora do torso.

### Fase 5 — Interop + Reliability

1. **BVH import.** Aba "Import" no header:
   - File input aceita `.bvh`.
   - `BVHLoader` de `three/examples/jsm/loaders/BVHLoader.js` parseia;
     mapeia bones BVH→VRM via tabela estática (Mixamo rest → VRM
     humanoid).
   - Sample cada 0.1 s (10 fps) → array de keyframes. Usuário vê preview
     + slider de "densidade de amostragem" antes de confirmar.
2. **JSON schema versioning** (já coberto na Fase 3 no schema, mas a
   migration formal vive aqui): `lab/gestureMigrations.ts` com função
   `migrateGesture(raw) → GestureDefinition` tratando v1→v2 explicitamente.
   Endpoint `/lab/gestures` no backend (`apps/seraphine/backend/lab/`)
   passa a validar `version` via Pydantic.
3. **Unit tests** (`apps/seraphine/frontend/src/avatar/__tests__/`):
   - `gestures.test.ts`: snapshot de poses geradas pelo GesturePlayer em
     `t = 0 / 0.25 / 0.5 / 0.75 / 1.0` de cada gesto da library. Quebra
     se a interpolação mudar.
   - `ikSolver.test.ts`: head look-at converge em <5 iterações.
   - `undoStack.test.ts`: sequência add/remove/undo/redo preserva
     identidade dos objetos kf.
4. **Backend validator** (Python): rejeita POST se `version > 2` ou kf
   time fora de `[0, duration]`.

## Sem-escopo

- **Graph editor Blender-style completo.** F-Curves atuais cobrem 90%
  dos casos. Full graph view (zoom independente por axis, keyframe
  tipos: bezier/linear/constant/auto) fica pra quando houver demanda
  concreta.
- **FABRIK solver.** CCD cobre nosso caso (chains curtas, <6 bones).
- **Multi-character / multi-avatar lab.** Um VRM por vez.
- **Export BVH / glTF animation.** Import chega na Fase 5; export vira
  SDD separado se pedido.
- **Retargeting automático** (motion capture → VRM generalizável). Fase 5
  cobre Mixamo→VRM via tabela estática, não solver genérico.
- **Mobile touch** (Tauri iOS). Lab é desktop-only — editor de precisão
  não cabe em mobile. Se precisar, SDD novo.

## Dependências

- Three.js 0.169 (já instalado) — `CCDIKSolver`, `BVHLoader`,
  `TransformControls` vêm nos examples.
- `@pixiv/three-vrm` 3.x (já instalado) — humanoid API.
- Nenhum pacote novo.
- Specs relacionadas: 005 (avatar-lipsync), 011 (persona), 050 (reactive
  anims), 074 (internal reactions) — consumidores downstream. Nada
  muda nas APIs que elas usam (`playGesture`, `setExpression`).

## Entrega sugerida

| Fase | PR | Estimativa | Risco |
|------|----|----|----|
| 1 — UI + Quick wins | 1 PR, múltiplos commits | 1 dia | Baixo |
| 2 — Quality | 1 PR | meio dia | Baixo |
| 3 — IK head | 1 PR | meio dia | Médio (CCD convergência) |
| 4 — IK arm | 1 PR | 1 dia | Médio–alto |
| 5 — BVH + tests | 1 PR | meio dia | Baixo |

Total ≈ 3–4 dias de trabalho focado. Fases são independentes; se Fase 3
encalhar, Fase 5 pode pular na frente sem bloqueio.

## Riscos & mitigações

- **IK CCD divergência.** Chains com target inalcançável oscilam. Mitigar
  com `maxIterations` baixo (5) + clamp do quaternion residual + fallback
  pro FK. Nunca trava o loop.
- **Undo stack consumindo memória.** Limite de 100 entradas + estratégia
  "compress redundant" (múltiplos slider drags consecutivos colapsam em 1
  undo).
- **BVH rest pose ≠ VRM T-pose.** Mixamo exports vêm em T-pose; outros
  podem vir em A-pose. Detect via bounding box do primeiro frame e warn
  se pose não-standard.
- **Schema migration em produção.** Backup do JSON pré-migration no
  endpoint (`.v1.json` sufixo) antes de sobrescrever. Backend faz isso.

## Testes

Cobertura mínima por fase:

- **Fase 1:** e2e Playwright (`lab.spec.ts`): abre lab, insere kf via I,
  undo, verifica keyframe sumiu; zoom com Ctrl+wheel e verifica viewBox.
- **Fase 2:** unit test `gestures.test.ts` — crossfade produz offsets
  contínuos entre dois gestos (diff quaternion < ε em cada frame do
  fade).
- **Fase 3–4:** `ikSolver.test.ts` — convergência em N iterações, erro
  residual <1 cm, head look-at dentro de ±1° do target projetado.
- **Fase 5:** fixture BVH pequeno (10 frames) → gesture valida;
  migration v1→v2 round-trip idempotente.
