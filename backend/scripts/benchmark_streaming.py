"""Deep streaming benchmark — measures token-by-token timing, sentence
detection, TTS dispatch, and end-to-end voice pipeline latency."""

import asyncio
import time
from collections import defaultdict

import httpx

from seraphine.config import settings
from seraphine.llm.anthropic import AnthropicClient
from seraphine.llm.types import ChatMessage
from seraphine.conversation.sentences import split_sentences, flush_remainder, strip_markdown_for_tts
from seraphine.tts.elevenlabs import ElevenLabsAdapter


async def main():
    client = AnthropicClient(
        api_key="seraphine-local",
        model=settings.anthropic_model,
        base_url=settings.anthropic_base_url,
    )

    print(f"Model:    {settings.anthropic_model}")
    print(f"Proxy:    {settings.anthropic_base_url}")
    print(f"TTS:      {settings.elevenlabs_model_id}")
    print()

    # =========================================================================
    # Test 1: Token streaming granularity
    # =========================================================================
    print("=" * 70)
    print("TEST 1: Token streaming analysis")
    print("=" * 70)

    msgs = [
        ChatMessage(role="system", content="You are Seraphine. Reply in 3-4 sentences in PT-BR. Be warm."),
        ChatMessage(role="user", content="me conta como esta o tempo hoje e me sugere algo pra fazer"),
    ]

    t0 = time.perf_counter()
    tokens = []
    token_times = []
    async for tok in client.chat(msgs, temperature=0.7):
        now = time.perf_counter() - t0
        if tok.text:
            tokens.append(tok.text)
            token_times.append(now)
        if tok.done:
            break

    full_text = "".join(tokens)
    total_time = token_times[-1] if token_times else 0
    ttft = token_times[0] if token_times else 0

    print(f"  TTFT:           {ttft*1000:.0f}ms")
    print(f"  Total time:     {total_time*1000:.0f}ms")
    print(f"  Tokens:         {len(tokens)}")
    print(f"  Avg tok/s:      {len(tokens)/total_time:.1f}")
    print(f"  Text length:    {len(full_text)} chars")
    print()

    # Token inter-arrival times
    if len(token_times) > 1:
        deltas = [(token_times[i] - token_times[i-1]) * 1000 for i in range(1, len(token_times))]
        avg_delta = sum(deltas) / len(deltas)
        min_delta = min(deltas)
        max_delta = max(deltas)
        p50 = sorted(deltas)[len(deltas)//2]
        p95 = sorted(deltas)[int(len(deltas)*0.95)]
        print(f"  Token inter-arrival (ms):")
        print(f"    avg={avg_delta:.0f}  min={min_delta:.0f}  max={max_delta:.0f}  p50={p50:.0f}  p95={p95:.0f}")

    # Token size distribution
    sizes = [len(t) for t in tokens]
    avg_size = sum(sizes) / len(sizes) if sizes else 0
    print(f"  Token size (chars): avg={avg_size:.1f}  min={min(sizes)}  max={max(sizes)}")
    print()

    # =========================================================================
    # Test 2: Sentence detection timing
    # =========================================================================
    print("=" * 70)
    print("TEST 2: Sentence streaming simulation")
    print("=" * 70)

    buf = ""
    sentence_events = []  # (time, sentence_text)
    for i, tok_text in enumerate(tokens):
        buf += tok_text
        sentences, buf = split_sentences(buf)
        for sent in sentences:
            cleaned = strip_markdown_for_tts(sent)
            if cleaned:
                sentence_events.append((token_times[i], cleaned))

    # Flush remainder
    if buf.strip():
        tail = flush_remainder(buf)
        if tail:
            cleaned = strip_markdown_for_tts(tail)
            if cleaned:
                sentence_events.append((total_time, cleaned))

    print(f"  Sentences detected: {len(sentence_events)}")
    for i, (t, text) in enumerate(sentence_events):
        print(f"    [{t*1000:.0f}ms] ({len(text)} chars) \"{text[:60]}{'...' if len(text)>60 else ''}\"")
    print()

    if sentence_events:
        first_sentence_time = sentence_events[0][0]
        print(f"  First sentence ready at: {first_sentence_time*1000:.0f}ms after LLM start")
        print(f"  (= TTFT {ttft*1000:.0f}ms + accumulation {(first_sentence_time-ttft)*1000:.0f}ms)")
    print()

    # =========================================================================
    # Test 3: TTS latency per sentence
    # =========================================================================
    print("=" * 70)
    print("TEST 3: TTS latency per sentence")
    print("=" * 70)

    tts = ElevenLabsAdapter(
        api_key=settings.elevenlabs_api_key,
        voice_id=settings.elevenlabs_voice_id,
        model_id=settings.elevenlabs_model_id,
        speed=settings.elevenlabs_speed,
        stability=settings.elevenlabs_stability,
    )

    for i, (_, text) in enumerate(sentence_events[:4]):  # test first 4 sentences
        t0 = time.perf_counter()
        ttfb = 0
        total_bytes = 0
        chunk_count = 0
        chunk_sizes = []
        async for chunk in tts.synthesize_stream(text):
            if ttfb == 0:
                ttfb = time.perf_counter() - t0
            total_bytes += len(chunk)
            chunk_count += 1
            chunk_sizes.append(len(chunk))
        total = time.perf_counter() - t0
        audio_s = total_bytes / 2 / 24000
        avg_chunk = sum(chunk_sizes) / len(chunk_sizes) if chunk_sizes else 0
        print(f"  Sentence {i+1} ({len(text)} chars):")
        print(f"    TTFB={ttfb*1000:.0f}ms  total={total*1000:.0f}ms  audio={audio_s:.1f}s  chunks={chunk_count}  avg_chunk={avg_chunk:.0f}B")

    await tts.aclose()
    print()

    # =========================================================================
    # Test 4: End-to-end voice pipeline simulation
    # =========================================================================
    print("=" * 70)
    print("TEST 4: End-to-end voice pipeline simulation")
    print("=" * 70)

    # Simulate: STT → LLM streaming → sentence split → first TTS TTFB → buffer
    stt_ms = 127  # from previous benchmark
    first_sent_ms = sentence_events[0][0] * 1000 if sentence_events else 0
    tts_ttfb_ms = 0

    # Measure TTS TTFB for first sentence
    if sentence_events:
        text = sentence_events[0][1]
        tts2 = ElevenLabsAdapter(
            api_key=settings.elevenlabs_api_key,
            voice_id=settings.elevenlabs_voice_id,
            model_id=settings.elevenlabs_model_id,
            speed=settings.elevenlabs_speed,
            stability=settings.elevenlabs_stability,
        )
        t0 = time.perf_counter()
        async for chunk in tts2.synthesize_stream(text):
            tts_ttfb_ms = (time.perf_counter() - t0) * 1000
            break  # only need TTFB
        await tts2.aclose()

    buffer_ms = 350  # first segment threshold

    print(f"  STT (Whisper RTX):          {stt_ms:>6.0f}ms")
    print(f"  LLM → first sentence:       {first_sent_ms:>6.0f}ms")
    print(f"    (TTFT={ttft*1000:.0f}ms + sentence accumulation={first_sent_ms - ttft*1000:.0f}ms)")
    print(f"  TTS TTFB (first sentence):  {tts_ttfb_ms:>6.0f}ms")
    print(f"  Frontend buffer:            {buffer_ms:>6.0f}ms")
    total_e2e = stt_ms + first_sent_ms + tts_ttfb_ms + buffer_ms
    print(f"  {'─' * 40}")
    print(f"  TOTAL (fala → primeiro som): {total_e2e:>5.0f}ms")
    print()

    # =========================================================================
    # Optimization suggestions
    # =========================================================================
    print("=" * 70)
    print("ANALYSIS: Pontos de melhora")
    print("=" * 70)

    issues = []
    if ttft * 1000 > 1000:
        issues.append(f"  [!] LLM TTFT alto ({ttft*1000:.0f}ms). Proxy overhead? API direta seria ~500ms. Considerar cache de system prompt.")
    if len(tokens) > 0 and len(tokens) / total_time < 5:
        issues.append(f"  [!] LLM throughput baixo ({len(tokens)/total_time:.1f} tok/s). Proxy pode estar limitando streaming. Testar API direta pra comparar.")
    if tts_ttfb_ms > 800:
        issues.append(f"  [!] TTS TTFB alto ({tts_ttfb_ms:.0f}ms). ElevenLabs v3 e lento. Trocar pra turbo_v2_5 corta pra ~300ms (-{tts_ttfb_ms-300:.0f}ms).")
    if first_sent_ms > ttft * 1000 + 500:
        issues.append(f"  [!] Sentence accumulation lenta ({first_sent_ms - ttft*1000:.0f}ms apos TTFT). Primeira frase muito longa ou splitter conservador.")
    if buffer_ms > 200:
        issues.append(f"  [i] Frontend buffer 350ms. Reduzir FIRST_SEGMENT_SECONDS pra 0.2s ganha 150ms.")

    if not issues:
        print("  Nenhum gargalo critico detectado!")
    else:
        for issue in issues:
            print(issue)

    # Compare turbo vs v3
    print()
    print("  Comparacao TTS:")
    print(f"    v3 (atual):     TTFB ~{tts_ttfb_ms:.0f}ms  → e2e ~{total_e2e:.0f}ms")
    turbo_est = stt_ms + first_sent_ms + 300 + buffer_ms
    print(f"    turbo_v2_5:     TTFB ~300ms    → e2e ~{turbo_est:.0f}ms  (saves ~{tts_ttfb_ms-300:.0f}ms)")

    # Compare proxy vs direct API
    print()
    direct_ttft_est = 500
    direct_e2e = stt_ms + direct_ttft_est + (first_sent_ms - ttft*1000) + tts_ttfb_ms + buffer_ms
    print(f"  Comparacao LLM:")
    print(f"    Proxy (atual):  TTFT ~{ttft*1000:.0f}ms  → e2e ~{total_e2e:.0f}ms")
    print(f"    API direta:     TTFT ~500ms    → e2e ~{direct_e2e:.0f}ms  (saves ~{ttft*1000-500:.0f}ms)")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
