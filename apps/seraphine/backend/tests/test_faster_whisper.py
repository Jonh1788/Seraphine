import wave
from types import SimpleNamespace

import pytest

from seraphine.stt.faster_whisper import FasterWhisperSTT
from seraphine.stt.whisper import STTUnavailableError


@pytest.mark.asyncio
async def test_empty_audio_does_not_load_model():
    stt = FasterWhisperSTT()
    result = await stt.transcribe(b'')
    assert result.text == ''
    assert stt._model is None


@pytest.mark.asyncio
async def test_preserves_sample_rate_for_decoder_and_consumes_lazy_segments():
    stt = FasterWhisperSTT()

    def transcribe(audio, **kwargs):
        with wave.open(audio) as wav:
            assert wav.getframerate() == 48000
            assert wav.getnframes() == 48000
            assert wav.getnchannels() == 1
        assert kwargs['language'] == 'pt'
        return iter([SimpleNamespace(text=' Olá '), SimpleNamespace(text=' mundo. ')]), SimpleNamespace(language='pt')

    stt._model = SimpleNamespace(transcribe=transcribe)
    result = await stt.transcribe(bytes(96000), 48000)
    assert result.text == 'Olá mundo.'
    assert result.duration_seconds == 1.0


@pytest.mark.asyncio
@pytest.mark.parametrize('pcm,rate', [(b'\x00', 16000), (bytes(2), 0)])
async def test_invalid_pcm_is_rejected(pcm, rate):
    with pytest.raises(STTUnavailableError):
        await FasterWhisperSTT().transcribe(pcm, rate)
