"""Tools da casa — som do EspMusic.

O que o LLM enxerga. As descrições precisam ser explícitas sobre quando
NÃO usar: a Seraphine já tem `play_music` para tocar no navegador do
Mac, e sem essa instrução ela escolhe errado.

`lan_request` (o relé HTTP do cliente) não aparece aqui de propósito —
uma tool de HTTP genérico na LAN seria um escape hatch para o modelo.
"""

from __future__ import annotations

import io
import logging
import wave
from typing import Any

from seraphine.home.espmusic import UnknownRoom
from seraphine.home.transport import (
    HomeDeviceUnreachable,
    HomeHTTPError,
    HomeRelayRejected,
    HomeUnreachable,
)
from seraphine.tools.base import Tool, ToolResult

logger = logging.getLogger("seraphine.tools.home")

# O `synthesize_stream` de todos os adaptadores devolve PCM s16le mono
# a 24 kHz (ver tts/base.py).
TTS_SAMPLE_RATE = 24_000

# A regra de quando usar as tools da casa, em duas partes: o portão do
# cômodo vale para todas; o ponteiro para `play_music` só vale para as
# que tocam música. `play_music` procura no YouTube Music e não sabe
# falar um aviso — mandar o modelo para lá num "avisa que o jantar
# chegou" faria ele buscar a frase como se fosse uma canção.
_ROOM_GATE = (
    "Use APENAS quando o usuário citar um cômodo ou a casa ('na sala', "
    "'no banheiro', 'nas caixas', 'na casa')."
)

_ONLY_WHEN_AT_HOME = (
    _ROOM_GATE + " Para tocar no próprio Mac do usuário, use `play_music`, "
    "que é o padrão."
)

MODES = ["now", "queue"]

ACTIONS = [
    "pause",
    "resume",
    "next",
    "stop",
    "mute",
    "volume_up",
    "volume_down",
    "volume_set",
    "radio_on",
    "radio_off",
]


def _pcm_to_wav(pcm: bytes, *, rate: int = TTS_SAMPLE_RATE) -> bytes:
    """Embrulha PCM s16le mono num WAV, que o ffmpeg do EspMusic decodifica."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _failure(exc: Exception, *, not_found: str | None = None) -> ToolResult:
    """Traduz a falha em algo que a Seraphine consegue falar em voz alta.

    `not_found` é a frase para um 404, e só quem sabe o que procurou pode
    escrevê-la: um 404 no `/api/play` é "essa música não existe", mas no
    `/api/announce` é "esse servidor não tem a rota" (o PC pode estar
    numa versão anterior à do endpoint de aviso). Sem o parâmetro, um
    404 cai na frase genérica de erro do aparelho.
    """
    # As três falhas de alcance pedem ações diferentes de quem ouve —
    # abrir o app, ligar o PC, ou consertar a allowlist. Ordem importa:
    # as subclasses vêm antes da base.
    if isinstance(exc, HomeDeviceUnreachable):
        return ToolResult(
            ok=False,
            error=(
                "o servidor da casa não respondeu — o PC do EspMusic pode "
                "estar desligado"
            ),
        )
    if isinstance(exc, HomeRelayRejected):
        return ToolResult(
            ok=False,
            error=(
                "o endereço da casa não bate com a allowlist do relé "
                f"({exc}) — precisa alinhar o backend com o app"
            ),
        )
    if isinstance(exc, HomeUnreachable):
        return ToolResult(
            ok=False,
            error=(
                "não alcanço a casa — o app da Seraphine precisa estar "
                "aberto no Mac e na mesma rede do EspMusic"
            ),
        )
    if isinstance(exc, UnknownRoom):
        return ToolResult(ok=False, error=str(exc))
    if isinstance(exc, HomeHTTPError):
        if exc.status == 404 and not_found is not None:
            return ToolResult(ok=False, error=not_found)
        return ToolResult(
            ok=False,
            error=f"o servidor da casa respondeu com erro (HTTP {exc.status})",
        )
    if isinstance(exc, ValueError):
        return ToolResult(ok=False, error=str(exc))
    logger.exception("home tool falhou")
    return ToolResult(ok=False, error=f"falha ao falar com a casa: {exc}")


class _HomeTool(Tool):
    """Base das tools da casa: injeta o serviço e centraliza os erros."""

    requires_confirmation = False
    category = "network"

    def __init__(self, service: Any) -> None:
        self._svc = service


class HomePlayTool(_HomeTool):
    name = "home_play"
    description = (
        "Toca música nas caixas de som da casa (sistema EspMusic). Aceita "
        "nome de música/artista, link do YouTube ou caminho de pasta. "
        "'room' escolhe o cômodo; sem ele, toca na caixa que já está "
        "selecionada. mode='queue' põe na fila em vez de tocar agora. "
        + _ONLY_WHEN_AT_HOME
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Música, artista, link do YouTube ou caminho.",
            },
            "room": {
                "type": "string",
                "description": "Cômodo, como o usuário fala: 'sala', 'banheiro'.",
            },
            "mode": {
                "type": "string",
                "enum": ["now", "queue"],
                "description": "'now' toca agora (padrão), 'queue' põe na fila.",
            },
        },
        "required": ["query"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query") or "").strip()
        if not query:
            return ToolResult(ok=False, error="'query' é obrigatório")
        # Um `mode` fora do enum não pode virar "now" por omissão: "now"
        # corta o que está tocando, que é a opção destrutiva. Recusa
        # explícita, do mesmo jeito que `action` em home_control.
        mode = str(args.get("mode") or "now")
        if mode not in MODES:
            return ToolResult(
                ok=False,
                error=f"modo desconhecido: '{mode}'. Use uma de: {', '.join(MODES)}",
            )
        try:
            out = await self._svc.music.play(
                query,
                room=args.get("room") or None,
                mode=mode,
            )
        except Exception as e:
            return _failure(e, not_found="não achei essa música")
        return ToolResult(ok=True, output=out)


class HomeControlTool(_HomeTool):
    name = "home_control"
    description = (
        "Controla o som da casa: pausar, voltar, pular, parar, mudo, "
        "volume e rádio (que reabastece a fila com músicas parecidas). "
        "volume_up/volume_down andam em passos de 2 dB; volume_set usa "
        "'value' em porcentagem (0 a 100). ATENÇÃO: passar 'room' também "
        "MOVE a música para aquele cômodo — o EspMusic toca em uma caixa "
        "por vez. Só use 'room' quando o usuário citar o cômodo; sem ele, "
        "age na caixa que já está tocando. " + _ONLY_WHEN_AT_HOME
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ACTIONS},
            "value": {
                "type": "number",
                "description": "Só para volume_set: volume alvo de 0 a 100.",
            },
            "room": {
                "type": "string",
                "description": (
                    "Cômodo; sem ele, age na caixa selecionada. Passá-lo "
                    "move a música tocando para esse cômodo."
                ),
            },
        },
        "required": ["action"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        action = str(args.get("action") or "")
        if action not in ACTIONS:
            return ToolResult(
                ok=False,
                error=f"ação desconhecida: '{action}'. Use uma de: {', '.join(ACTIONS)}",
            )
        value = args.get("value")
        try:
            out = await self._svc.music.control(
                action,
                value=float(value) if value is not None else None,
                room=args.get("room") or None,
            )
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out)


class HomeAnnounceTool(_HomeTool):
    name = "home_announce"
    description = (
        "Fala um aviso nas caixas de som da casa, com a voz da Seraphine. "
        "O aviso corta a música e ela volta do ponto exato depois. Sai na "
        "caixa que está selecionada. " + _ROOM_GATE
    )
    json_schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "O que falar, em português, em uma ou duas frases.",
            },
        },
        "required": ["text"],
    }

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        text = str(args.get("text") or "").strip()
        if not text:
            return ToolResult(ok=False, error="'text' é obrigatório")

        tts = getattr(self._svc, "tts", None)
        if tts is None:
            return ToolResult(
                ok=False, error="não tenho voz configurada para falar na casa"
            )

        # ogg é pequeno e todo adaptador que o suporta já entrega pronto;
        # os outros só têm o stream PCM, que embrulhamos num WAV.
        try:
            audio = await tts.synthesize_ogg(text)
            filename = "aviso.ogg"
        except NotImplementedError:
            try:
                pcm = b"".join([chunk async for chunk in tts.synthesize_stream(text)])
            except Exception as e:
                logger.exception("TTS stream falhou")
                return ToolResult(ok=False, error=f"não consegui gerar a voz: {e}")
            if not pcm:
                return ToolResult(ok=False, error="o TTS devolveu áudio vazio")
            audio = _pcm_to_wav(pcm)
            filename = "aviso.wav"
        except Exception as e:
            logger.exception("TTS ogg falhou")
            return ToolResult(ok=False, error=f"não consegui gerar a voz: {e}")

        if not audio:
            return ToolResult(ok=False, error="o TTS devolveu áudio vazio")

        try:
            out = await self._svc.music.announce(audio, filename=filename)
        except Exception as e:
            # 404 aqui não é música que não existe: é o `/api/announce`
            # que não existe naquele servidor — o PC pode estar rodando
            # uma versão anterior ao endpoint de aviso.
            return _failure(
                e,
                not_found=(
                    "o servidor da casa não tem a rota de aviso — o "
                    "EspMusic do PC precisa ser atualizado"
                ),
            )
        return ToolResult(ok=True, output=out, metadata={"text": text})


class HomeStatusTool(_HomeTool):
    name = "home_status"
    description = (
        "Diz o que está tocando nas caixas da casa: cômodo selecionado, "
        "faixa, volume, tamanho da fila, rádio e quais caixas existem. "
        "Use antes de mudar de cômodo. " + _ROOM_GATE + " Um 'o que está "
        "tocando?' sem cômodo é sobre o Mac: use `now_playing`."
    )
    json_schema: dict[str, Any] = {"type": "object", "properties": {}}

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        try:
            out = await self._svc.music.status()
        except Exception as e:
            return _failure(e)
        return ToolResult(ok=True, output=out)
