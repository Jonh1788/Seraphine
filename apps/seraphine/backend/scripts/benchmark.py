"""Seraphine pipeline benchmark — measures latency of each component."""

import asyncio
import time

import httpx

from seraphine.config import settings
from llm_adapters.anthropic import AnthropicClient
from llm_adapters.types import ChatMessage
from seraphine.tts.elevenlabs import ElevenLabsAdapter


async def main():
    client = AnthropicClient(
        api_key="seraphine-local",
        model=settings.anthropic_model,
        base_url=settings.anthropic_base_url,
    )

    print(f"Model:    {settings.anthropic_model}")
    print(f"Base URL: {settings.anthropic_base_url}")
    print(f"TTS:      {settings.elevenlabs_model_id}")
    print(f"STT:      {settings.stt_remote_base_url}")
    print()
    print(f"{'Test':<35} {'TTFT':>8} {'Total':>8} {'Detail':>12}")
    print("-" * 70)

    # --- LLM tests ---
    tests = [
        (
            "LLM simples (sem tools)",
            [
                ChatMessage(role="system", content="Reply in 1 short sentence in PT-BR."),
                ChatMessage(role="user", content="oi, tudo bem?"),
            ],
            None,
        ),
        (
            "LLM com tools (schema grande)",
            [
                ChatMessage(role="system", content="Reply in 1 short sentence."),
                ChatMessage(role="user", content="que dia e hoje?"),
            ],
            [
                {"type": "function", "function": {"name": f"tool_{i}", "description": f"tool {i}", "parameters": {"type": "object", "properties": {}}}}
                for i in range(20)
            ],
        ),
        (
            "LLM com historico (6 msgs)",
            [
                ChatMessage(role="system", content="Reply in 1 sentence."),
                ChatMessage(role="user", content="oi"),
                ChatMessage(role="assistant", content="Oi! Tudo bem?"),
                ChatMessage(role="user", content="me conta uma piada"),
                ChatMessage(role="assistant", content="Por que o programador foi ao medico? Porque tinha muitos bugs!"),
                ChatMessage(role="user", content="boa! qual a capital da Franca?"),
            ],
            None,
        ),
    ]

    for name, msgs, tools in tests:
        t0 = time.perf_counter()
        ttft = 0
        token_count = 0
        kwargs = {"temperature": 0.7}
        if tools:
            kwargs["tools"] = tools
        async for tok in client.chat(msgs, **kwargs):
            if tok.text and ttft == 0:
                ttft = time.perf_counter() - t0
            if tok.text:
                token_count += 1
            if tok.done:
                break
        total = time.perf_counter() - t0
        tps = token_count / total if total > 0 else 0
        print(f"{name:<35} {ttft*1000:>7.0f}ms {total*1000:>7.0f}ms {tps:>7.1f} tok/s")

    # --- STT test ---
    t0 = time.perf_counter()
    async with httpx.AsyncClient() as http:
        r = await http.post(
            f"{settings.stt_remote_base_url}/transcribe",
            headers={"Content-Type": "audio/pcm", "X-Sample-Rate": "16000", "X-Language": "pt"},
            content=b"\x00\x00" * 24000,
            timeout=10,
        )
        stt_data = r.json()
    stt_ms = (time.perf_counter() - t0) * 1000
    print(f"{'STT (1.5s silence, RTX)':<35} {stt_ms:>7.0f}ms {'':>8} {stt_data.get('inference_ms', '?')}ms infer")

    # --- TTS test ---
    tts = ElevenLabsAdapter(
        api_key=settings.elevenlabs_api_key,
        voice_id=settings.elevenlabs_voice_id,
        model_id=settings.elevenlabs_model_id,
        speed=settings.elevenlabs_speed,
        stability=settings.elevenlabs_stability,
    )
    t0 = time.perf_counter()
    ttfb_tts = 0
    total_bytes = 0
    async for chunk in tts.synthesize_stream("Ola Jonathan, tudo bem com voce?"):
        if ttfb_tts == 0:
            ttfb_tts = time.perf_counter() - t0
        total_bytes += len(chunk)
    tts_total = time.perf_counter() - t0
    audio_secs = total_bytes / 2 / 24000
    print(f"{'TTS TTFB (' + settings.elevenlabs_model_id + ')':<35} {ttfb_tts*1000:>7.0f}ms {tts_total*1000:>7.0f}ms {audio_secs:>7.1f}s audio")
    await tts.aclose()

    # --- Browser screenshot ---
    try:
        t0 = time.perf_counter()
        async with httpx.AsyncClient() as http:
            r = await http.post("http://127.0.0.1:3002/screenshot", json={"full_page": False}, timeout=10)
            d = r.json()
        scr_ms = (time.perf_counter() - t0) * 1000
        img_kb = len(d.get("image", "")) // 1024
        print(f"{'Browser screenshot':<35} {scr_ms:>7.0f}ms {'':>8} {img_kb:>7}KB")
    except Exception as e:
        print(f"{'Browser screenshot':<35} {'SKIP':>8} {str(e)[:30]}")

    # --- End-to-end estimate ---
    print()
    print("=== Estimativa ponta-a-ponta (voz) ===")
    print(f"  STT:       ~{stt_ms:.0f}ms")
    print(f"  LLM TTFT:  ~{tests[0][0] and ttft*1000:.0f}ms")
    print(f"  TTS TTFB:  ~{ttfb_tts*1000:.0f}ms")
    print(f"  Buffer:    ~350ms (first segment)")
    total_est = stt_ms + ttft * 1000 + ttfb_tts * 1000 + 350
    print(f"  TOTAL:     ~{total_est:.0f}ms (fala ate primeiro som)")

    await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
