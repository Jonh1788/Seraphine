# Fix do retargeting Mixamo→VRM (Fase A)

**Data:** 2026-06-25
**Status:** Aprovado para implementação
**Escopo:** Corrigir o motor de retargeting de animações para que clipes FBX de corpo
inteiro do Mixamo caiam corretos na `seraphine.vrm`, travados in-place.

---

## Problema

`VrmAvatarController.retargetClip()` copia a quaternion crua de cada osso do Mixamo
direto para o osso do VRM, sem rebasear pela diferença de pose de descanso. Mixamo
exporta em T-pose; o VRoid descansa em A-pose. Cada osso tem um eixo de descanso
diferente nos dois rigs, então copiar a rotação crua produz membros torcidos e ombros
quebrados — a "boneca quebrada". Os gestos da `GESTURE_LIBRARY` ficam bons porque
foram autorados à mão no espaço do VRM e não passam por esse retarget.

Há um **segundo defeito**: os tracks miram nos ossos *raw* (`getRawBoneNode`), mas o
loop de render roda `mixer.update()` e **depois** `vrm.update()`, que executa a
sincronização normalizado→raw e **sobrescreve** o que o mixer escreveu. Mirar no rig
normalizado conserta a matemática E esse atropelo de ordem.

## Fatos confirmados

- Modelo: `public/avatars/seraphine.vrm` é **VRM 0.x** (extensão `VRM`, não `VRMC_vrm`).
- Lib: `@pixiv/three-vrm@^3.1.0`.
- Loop (`VrmAvatarController.ts` ~479–519): faz `mixer?.update(delta)` então
  `vrm?.update(delta)` por frame.
- Coexistência: `if (!this.externalAnimPlaying)` (~582) já pula a re-aplicação da pose
  idle/gesto enquanto um clipe externo toca. `playGesture`, fala (`_isSpeaking`) e idle
  loop já se suprimem mutuamente. Nada novo necessário aqui.
- `playAnimation(url, {loop, fadeIn})` já existe e funciona (mixer lazy em `vrm.scene`,
  cache de clipes, fade, volta pro idle ao terminar). Só o `retargetClip` está errado.

## Decisões de produto

- **Root motion: in-place.** Zerar deslocamento horizontal do quadril (X, Z), manter
  só o vertical (Y, sobe-desce). Seraphine nunca sai do enquadramento.

## A correção

Portar o algoritmo oficial do `@pixiv/three-vrm` (`examples/.../loadMixamoAnimation.js`)
para `retargetClip`. Todas as mudanças ficam em `avatar/VrmAvatarController.ts`.

### 1. `loadAndRetargetClip` passa o grafo do FBX adiante

Hoje carrega o FBX como `group` (Object3D), extrai `group.animations[0]` e **descarta o
group**. O algoritmo precisa ler a pose de descanso em world-space de cada osso do
Mixamo no grafo carregado. Mudar a assinatura para
`retargetClip(clip, fbxRoot, vrm)` e repassar o `group`.

### 2. `retargetClip(clip, fbxRoot, vrm)` reescrito

Pré-cálculo (uma vez por clipe):

- `mixamoHips = fbxRoot.getObjectByName('mixamorigHips')` (ou o nome real do quadril
  observado no FBX; o mapa `MIXAMO_TO_VRM` já cobre os dois estilos de nome).
- `hipsPositionScale = vrmHipsHeight / mixamoHipsHeight`, onde:
  - `mixamoHipsHeight = mixamoHips.position.y`
  - `vrmHipsHeight = |worldY(normalizedHipsNode) − worldY(vrm.scene)|`
- Detectar VRM0: `vrm.meta?.metaVersion === '0'` (three-vrm normaliza isso).

Por track:

- Resolver `vrmBoneName = MIXAMO_TO_VRM[boneName]`; pular se não mapeado (dedos etc.).
- `targetNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName)`; pular se ausente.
  Nome do track de saída: `${targetNode.name}.${property}`.
- Ler do grafo FBX o nó `mixamoRigNode = fbxRoot.getObjectByName(boneName)`:
  - `mixamoRestWorldRotationInverse = mixamoRigNode.getWorldQuaternion().invert()`
  - `parentRestWorldRotation = mixamoRigNode.parent.getWorldQuaternion()`

**Tracks de rotação** (`QuaternionKeyframeTrack`): para cada quaternion `q` do track,
`q' = parentRestWorldRotation · q · mixamoRestWorldRotationInverse`. Se VRM0, negar as
componentes x e z de cada quaternion (índices `i % 2 === 0` no array achatado de 4).

**Track de posição do quadril** (`VectorKeyframeTrack`, só o do hips):
- Multiplicar todas as componentes por `hipsPositionScale`.
- Se VRM0, negar x e z (índices `i % 3 !== 1`).
- **In-place:** zerar X e Z resultantes; manter só Y.

Demais tracks de posição/escala: descartados (mantém o comportamento atual correto).

### 3. `MIXAMO_TO_VRM`

Mantido como está (cobre `mixamorigXxx` e `Xxx`). Só o lookup do nó-alvo muda de
`getRawBoneNode` para `getNormalizedBoneNode`.

## O que NÃO muda

- `playAnimation`, mixer, cache de clipes, fade, retorno ao idle.
- Loop de render, supressão idle/fala/gesto.
- Sistema de gestos, expressões, lip-sync.

## Validação

1. Baixar 2–3 FBX do Mixamo ("In Place" quando o site oferecer): um idle, um
   comemorando/dançando, e usar o `Waving.fbx` existente como regressão. Pôr em
   `public/animations/` e registrar em `ANIMATION_LIBRARY`.
2. Carregar pela aba Lab e conferir a olho na própria Seraphine:
   - Braços e ombros na posição anatômica (sem torção).
   - Sem "clobber" (a animação não pisca/volta pro idle no meio).
   - Ela permanece centrada (in-place), só com o sobe-desce vertical.
3. Regressão: `Waving.fbx` continua reconhecível como aceno.
4. Rodar a suíte de testes do frontend existente; o retarget puro é difícil de
   unit-testar sem um VRM, então o gate primário é visual. Onde der, um teste de forma
   (contagem/nomes de tracks de saída) sobre um clipe sintético.

## Fora de escopo (Fase B)

- Popular `ANIMATION_LIBRARY` com um catálogo de clipes.
- Ligar `playAnimation` no `TAG_TO_AVATAR` para clipes de corpo inteiro dispararem
  pela conversa (hoje o chat só dispara `playGesture`).
- Formato `.vrma` (`@pixiv/three-vrm-animation`).

## Riscos

- **Flip VRM0** é a única parte sensível; validada visualmente.
- Nome real do osso-raiz do Mixamo no FBX pode variar (`mixamorigHips` vs `Hips`); o
  pré-cálculo do hips deve resolver via o mesmo mapa, não por string fixa.
- Se algum FBX vier sem o nó no grafo (só com clip), o `getObjectByName` falha; tratar
  defensivamente (sem rest-pose → cair no comportamento atual para aquele osso e logar).
