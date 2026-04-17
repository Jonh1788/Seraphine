# 032 — Contextual Modes

## Context

Dois comportamentos ativados por contexto, que mudam a forma como
Seraphine responde:

- **032-A** — Personal Trainer Mode (streak em risco)
- **032-B** — Embodied Commands (avatar reage a frases específicas)

## 032-A — Personal Trainer Mode

### Ativação

Quando:

1. Existe habit com `tag=fitness` e streak ≥ 3 dias.
2. Último `habit_log` foi > 20h atrás e < 36h atrás (janela onde o
   hábito ainda está em risco mas não quebrou).
3. Usuário menciona algo próximo (cansaço, movimento, motivação).

### Comportamento

System prompt ganha um bloco temporário (duração da conversa):

```
TRAINER MODE ATIVO:
Hábito "treinar" tá em streak de 7 dias. Última entrada há 23h.
O usuário parece cansado. Você NÃO é mãe nem terapeuta agora —
você é coach calma. Reconhece o cansaço, mas segura o padrão.
Exemplos de tom:
- "cansado é justo, mas 20min preservam o que você já construiu"
- "faz o warm up e vê como tá — se não rolar, amanhã é amanhã"
NÃO: "você precisa", "devia", motivacional batido.
```

Modo sai quando:

- Hábito é logado no dia
- Ou passam 36h (streak quebra naturalmente)
- Ou usuário explicitamente declara "hoje não"

### Não-objetivos

Não é push proativo. Só muda o **tom** das respostas dela quando o
contexto já alinha. Se streak em risco + usuário não tocar no tema
fitness, ela não pincha.

## 032-B — Embodied Commands

### Ideia

Certas frases do usuário disparam reação física no avatar — pequenos
easter eggs que solidificam a sensação de "ela tá com você".

### Padrões

```python
EMBODIED_TRIGGERS = {
    r"\brespira fundo\b": "breathe_with_user",
    r"\b(brinde|cheers|saúde)\b": "raise_hand",
    r"\b(alto[- ]?cinco|high ?five)\b": "high_five",
    r"\btchau\b": "wave_goodbye",
    r"\bbom dia\b": "stretch",
    r"\bboa noite\b": "yawn_slow",
    r"\bm[ie] d[áa] forç[ae]s?\b": "smile_encouraging",
}
```

### Implementação

Novo evento WS `avatar_action`:

```json
{ "type": "avatar_action", "action": "breathe_with_user" }
```

Backend detecta no user_message via regex rápido e envia antes de
chamar a LLM.

Frontend tem mapping de action → VRM animation (blendshape sequences
ou bone poses):

```ts
const ACTIONS: Record<string, () => void> = {
  breathe_with_user: () => {
    avatarRef.current?.playAnimation('breathe_deep', 4000);
  },
  high_five: () => avatarRef.current?.playAnimation('right_hand_up', 1000),
  ...
};
```

Sem custo de LLM. 0 latência.

## Entregáveis

- [ ] `conversation/trainer_mode.py` com ativação contextual.
- [ ] Schema em habits pra incluir `tag` (já existe? checar).
- [ ] Regex table em `ws/routes.py` pra detectar triggers.
- [ ] `avatar_action` event type em ws/types.
- [ ] VRM animation library: 6-7 actions (breathe, high_five, wave,
      stretch, yawn, smile_encouraging, raise_hand).
- [ ] Tests: trigger match, trainer mode activation.

## Riscos

- **Trainer tom errado**: se tá deprimido e ela "mantém o padrão",
  piora. Mitigação: stressed mood cancela trainer_mode.
- **Avatar ações bug**: se animação trava, volta ao idle. Timeout
  hard de 5s.
- **Embodied trigger em contexto errado** ("bom dia" dito de forma
  irônica). Regex é burra — aceitável, usuário esquece em 2s.
