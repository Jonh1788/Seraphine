# 041 — Voice Fingerprint — DEFERRED

## Context

Cada turno de voz tem prosody meta (wpm, rms, pitch variance). Hoje
usado pontualmente via 023-B. Mas agregando ao longo do tempo, temos
uma "assinatura" do usuário — baseline pessoal que permite detectar
mudanças ("hoje ele tá diferente").

## Escopo

- Nova tabela `voice_samples(turn_id, duration, wpm, rms_avg,
  pitch_var, mfcc_digest, created_at)`.
- Pipeline: após cada transcrição, computar mfcc_digest (pequeno
  vetor 13d do Whisper features).
- Baseline sliding window (30d): média + stddev por métrica.
- Anomaly: valor > 2σ → sinal "tom atípico".
- Injeta como ambient hint quando bate.

## Por que deferred

- MFCC exige extrair features do áudio cru (não do texto). Whisper-rs
  tem, mas expor via Rust cmd + Python sidecar leva tempo.
- Valor incremental baixo — `concerned` mood via keyword já cobre
  80% dos casos.
- Ganho real só com 3+ meses de baseline acumulado.

## Next

Revisitar quando houver dataset interno suficiente pra validar se
MFCC baseline é mesmo preditivo além do que keywords já pegam.
