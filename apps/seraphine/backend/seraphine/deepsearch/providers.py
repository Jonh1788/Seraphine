from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

import httpx

logger = logging.getLogger(__name__)

OPENROUTER_BASE = "https://openrouter.ai/api/v1"


def _or_headers(api_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://app.minha-aura.com",
        "X-Title": "Seraphine Deepsearch",
    }


def _parse_json_object(raw: str) -> dict:
    """Best-effort parse of a JSON object out of an LLM completion.

    Tries a strict parse of the whole string first, then a balanced-brace scan
    from the first ``{``. Never raises — returns ``{}`` on any failure.
    """
    if not raw:
        return {}
    text = raw.strip()
    try:
        obj = json.loads(text)
        return obj if isinstance(obj, dict) else {}
    except (json.JSONDecodeError, ValueError):
        pass
    start = text.find("{")
    if start == -1:
        return {}
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    obj = json.loads(text[start : i + 1])
                except (json.JSONDecodeError, ValueError):
                    return {}
                return obj if isinstance(obj, dict) else {}
    return {}


class OpenRouterClient:
    def __init__(self, api_key: str, *, timeout: float = 120.0) -> None:
        self.api_key = api_key
        self.timeout = timeout

    async def complete(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        response_format: dict | None = None,
    ) -> str:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format is not None:
            body["response_format"] = response_format
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json=body,
            )
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"] or ""

    async def stream(
        self,
        messages: list[dict[str, str]],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> AsyncIterator[str]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json={
                    "model": model,
                    "messages": messages,
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                    "stream": True,
                },
            ) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        # Partial / non-JSON frame — skip, keep the stream alive.
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        # Usage-only / empty-choices chunk — nothing to yield.
                        continue
                    try:
                        delta = choices[0].get("delta") or {}
                    except (IndexError, KeyError, AttributeError):
                        continue
                    content = delta.get("content")
                    if content:
                        yield content

    async def list_models(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{OPENROUTER_BASE}/models", headers=_or_headers(self.api_key))
            r.raise_for_status()
            return [
                {
                    "id": m["id"],
                    "name": m.get("name", m["id"]),
                    "reasoning": _anuncia_reasoning(m),
                }
                for m in r.json().get("data", [])
            ]


def _anuncia_reasoning(modelo: dict[str, Any]) -> bool:
    """O modelo aceita o bloco ``reasoning`` (esforço de raciocínio)?

    A resposta do `/models` traz `supported_parameters` por modelo, e é ele
    quem manda — não uma lista nossa de famílias, que envelheceria a cada
    lançamento. Medido em 2026-08-02: 212 dos 337 modelos anunciam
    ``reasoning``; `openai/gpt-4o-mini` não anuncia e `anthropic/claude-*`,
    `openai/gpt-5` e `google/gemini-2.5-*` anunciam.

    Checamos ``reasoning`` e não ``reasoning_effort``: o segundo é o parâmetro
    nativo da OpenAI (89 modelos) e o primeiro é o bloco normalizado da
    OpenRouter, que traduz `effort` para o orçamento de tokens dos modelos
    Anthropic/Gemini. É o bloco normalizado que enviamos.
    """
    params = modelo.get("supported_parameters")
    return isinstance(params, list) and "reasoning" in params


def _as_int(value: Any) -> int:
    """Inteiro tolerante para contadores vindos do provedor.

    `None`, string e dict aparecem de verdade nesses campos dependendo do
    provedor por trás do OpenRouter; um `int()` cru levantaria dentro do
    caminho de telemetria.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return int(value)


def _stringify_content(content: Any) -> str:
    """Coerce a ``ChatMessage.content`` into a plain string for OpenRouter.

    OpenRouter's chat endpoint accepts string content (or a typed block list,
    but we keep it simple). When the engine hands us a vision-style block list
    (``[{"type":"text","text":..}, {"type":"image_url",..}]``), concatenate the
    text blocks and drop the rest — images are not forwarded on the OpenRouter
    chat path for v1.
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
            elif isinstance(block, str):
                parts.append(block)
        return "".join(parts)
    return str(content or "")


#: Prefixos de model id cujo provedor exige um breakpoint EXPLÍCITO de cache.
#: O catálogo do OpenRouter tem 300+ modelos e o comportamento se divide em
#: três: (1) cache automático, sem marcador nenhum — OpenAI, DeepSeek, Grok,
#: Moonshot, Groq; (2) breakpoint explícito — Anthropic; (3) explícito com
#: outra economia — Gemini cobra ARMAZENAMENTO por hora no cache explícito, o
#: que pode custar mais que o que economiza num chat esporádico, então fica de
#: fora até ser medido. Marcar quem não precisa não traz ganho e mexe no corpo
#: enviado a caminhos que hoje funcionam; por isso a lista é fechada.
_CACHE_BREAKPOINT_PREFIXES = ("anthropic/",)


def _supports_cache_breakpoints(model: str | None) -> bool:
    """O modelo precisa de um marcador `cache_control` explícito no corpo?

    Falso para o resto do catálogo — nesses casos o corpo enviado continua
    byte a byte igual ao de antes desta mudança.
    """
    m = (model or "").strip().lower()
    return m.startswith(_CACHE_BREAKPOINT_PREFIXES)


def _cached_text_block(text: str) -> dict[str, Any]:
    """Bloco de conteúdo OpenAI-shaped com o breakpoint de cache.

    A API da Anthropic recebe `cache_control` num campo do próprio bloco; o
    OpenRouter é OpenAI-shaped, então o marcador vai DENTRO do bloco de
    conteúdo da mensagem — não num campo separado no corpo. Ele traduz o
    marcador para o formato de cada provedor na saída.
    """
    return {"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}


def _to_openai_messages(
    messages: list[Any], *, cache_system: bool = False
) -> list[dict[str, Any]]:
    """Converte o histórico do engine para o formato OpenAI do OpenRouter.

    O ponto todo é o round-trip de ferramenta. `ChatMessage` só tem `role` e
    `content` — não há onde guardar o `tool_calls` do assistente, então o
    engine grava só a mensagem `role="tool"` com um JSON
    ``{"tool", "args", "ok", "output"|"error"}``. Achatar isso para
    ``{"role": "tool", "content": "..."}`` produz um histórico inválido: numa
    API compatível com OpenAI, toda mensagem `tool` exige `tool_call_id` E uma
    mensagem `assistant` com `tool_calls` antes dela. Sem isso o upstream
    devolve 500 — foi o que quebrou o chat via Sonnet depois da primeira
    ferramenta.

    Reconstruímos os dois lados a partir do payload gravado, espelhando o que
    ``llm_adapters.anthropic._convert_messages`` já faz para o Claude direto.

    Os `arguments` levam os args REAIS. Com argumentos vazios o modelo lê o
    histórico como "chamei sem argumentos, preciso repetir direito" e refaz a
    mesma tool em loop — a mesma armadilha documentada no lado Anthropic.

    Com ``cache_system=True`` a PRIMEIRA mensagem `system` sai como lista de
    blocos, com o breakpoint de cache no único bloco. Só a primeira: o engine
    empilha várias `system` depois dela (data e hora, humor, música, recall)
    que mudam a cada turno, e o cache é casamento de PREFIXO — um breakpoint
    dentro do trecho volátil dá 100% de miss pagando 1,25x na escrita. Como a
    Anthropic renderiza `tools` → `system` → `messages`, o breakpoint no
    primeiro system cobre também o bloco de ferramentas, que é a maior parte
    fixa do prompt. Desligado, a saída é byte a byte a de antes.
    """
    out: list[dict[str, Any]] = []
    counter = 0
    # Vira False assim que o breakpoint é gasto — garante um só marcador.
    pending_cache = cache_system
    for m in messages:
        role = getattr(m, "role", "user")
        content = getattr(m, "content", "")

        if role != "tool":
            text = _stringify_content(content)
            # `text` vazio (ou só espaço) não vira bloco: nunca alcançaria o
            # mínimo cacheável e a Anthropic rejeita bloco de texto vazio —
            # trocaria economia por 400.
            if pending_cache and role == "system" and text.strip():
                pending_cache = False
                out.append({"role": role, "content": [_cached_text_block(text)]})
            else:
                out.append({"role": role, "content": text})
            continue

        tool_name = "unknown_tool"
        tool_args: dict[str, Any] = {}
        tool_output = ""
        try:
            body = json.loads(content) if isinstance(content, str) else content
            if isinstance(body, dict):
                tool_name = str(body.get("tool") or "unknown_tool")
                maybe_args = body.get("args")
                if isinstance(maybe_args, dict):
                    tool_args = maybe_args
                payload = body.get("output")
                if payload is None:
                    payload = body.get("error")
                tool_output = (
                    payload if isinstance(payload, str) else json.dumps(payload or body)
                )
            else:
                tool_output = json.dumps(body)
        except (json.JSONDecodeError, TypeError):
            tool_output = content if isinstance(content, str) else str(content)

        call_id = f"call_synth_{counter:04d}"
        counter += 1

        out.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            # `arguments` é STRING no formato OpenAI, não objeto.
                            "arguments": json.dumps(tool_args),
                        },
                    }
                ],
            }
        )
        out.append({"role": "tool", "tool_call_id": call_id, "content": tool_output})

    return out


"""Esforços de raciocínio aceitos pela OpenRouter, do mais barato ao mais caro.

A lista é a da documentação inteira, não a do que a UI mostra hoje: validar
aqui pelo conjunto completo significa que expor `minimal` ou `xhigh` na tela
depois não pede mudança nenhuma no backend.

`none` está fora de propósito. Ele DESLIGA o raciocínio de um modelo que pensa
por padrão — semântica diferente de "não mandar o parâmetro", que é o nosso
desligado e deixa o modelo no comportamento dele. Misturar os dois num controle
só faria "Desligado" significar duas coisas.
"""
_EFFORTS = ("minimal", "low", "medium", "high", "xhigh", "max")


class _ReasoningRecusado(Exception):
    """A OpenRouter recusou a requisição por causa do bloco ``reasoning``.

    Interna e nunca escapa do adaptador: `chat` a captura para repetir sem o
    bloco. Uma exceção em vez de um valor de retorno porque quem detecta está
    dentro de um gerador que já podia estar emitindo tokens — só que não está,
    e é justamente isso que ela afirma.
    """


def _erro_de_reasoning(corpo: str) -> bool:
    """O erro da OpenRouter fala do parâmetro de raciocínio?

    Casamento por texto porque não há código de erro estruturado para isso: a
    mensagem vem do provedor por trás e o formato varia. O risco de um falso
    positivo é baixo e o custo é uma repetição sem o bloco — nunca uma resposta
    errada. Um falso NEGATIVO é que seria caro (o turno morre), então a busca é
    deliberadamente larga.
    """
    return "reasoning" in (corpo or "").lower()


def normalize_effort(value: Any) -> str | None:
    """Esforço válido, ou ``None`` para "não enviar".

    Tolerante de propósito: o valor vem de um kv que clientes de qualquer
    versão escrevem. Lixo vira ``None`` (o comportamento de antes da feature)
    em vez de derrubar a montagem da requisição — errar para o lado de não
    mandar o parâmetro é sempre recuperável; errar para o lado de mandar algo
    inválido custa um 400 no meio da conversa.
    """
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    return v if v in _EFFORTS else None


class OpenRouterChatClient:
    """OpenRouter chat client matching the engine's ``llm.chat`` contract.

    Streams an OpenAI-compatible chat completion and yields ``Token`` objects
    exactly like the cliproxy ``AnthropicClient.chat`` the engine normally uses:
    text deltas stream as ``Token(text=...)`` and any tool calls are emitted as a
    single terminal ``Token(done=True, tool_calls=[...])`` in OpenAI function
    shape (directly consumable by the engine's ``_parse_tool_call``).
    """

    def __init__(
        self,
        api_key: str,
        *,
        timeout: float = 180.0,
        telemetry: Callable[[dict[str, Any]], None] | None = None,
        effort: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.timeout = timeout
        # Optional per-call usage sink (default None → no-op). Same opt-in
        # contract as AnthropicClient.
        self._telemetry = telemetry
        # Esforço de raciocínio escolhido pelo usuário. `None`/vazio = não
        # manda `reasoning` nenhum, e aí o corpo da requisição fica
        # byte-a-byte igual ao de antes desta feature — que é o default.
        self.effort = normalize_effort(effort)

    def _emit_usage(self, model: str, usage: dict[str, Any]) -> None:
        """Forward OpenRouter usage to the optional sink. Never raises."""
        if self._telemetry is None:
            return
        try:
            rec: dict[str, Any] = {
                "backend": "openrouter",
                "model": model,
                "input_tokens": int(usage.get("prompt_tokens") or 0),
                "output_tokens": int(usage.get("completion_tokens") or 0),
            }
            # O OpenRouter devolve o custo REAL cobrado (pedimos `usage.include`
            # acima). Vale mais que a tabela estimada de pricing.py: cobre
            # qualquer modelo sem manutenção e já reflete desconto de cache.
            # `cost` ausente ou não-numérico → deixa o consumidor estimar.
            cost = usage.get("cost")
            if isinstance(cost, (int, float)):
                rec["cost_usd"] = float(cost)
            # Cache: `cached_tokens` é o que foi LIDO do cache (0,1x do preço)
            # e `cache_write_tokens` o que foi ESCRITO nele (1,25x). São a
            # única evidência direta de que o breakpoint pegou — o custo
            # sozinho não distingue "cache acertou" de "turno curto".
            #
            # Nada disso é subtraído de `input_tokens`: na semântica OpenAI que
            # o OpenRouter normaliza, `prompt_tokens` já é o TOTAL e
            # `cached_tokens` é um subconjunto dele. Descontar contaria duas
            # vezes ao contrário e faria a entrada parecer despencar.
            details = usage.get("prompt_tokens_details")
            details = details if isinstance(details, dict) else {}
            rec["cache_read_tokens"] = _as_int(details.get("cached_tokens"))
            rec["cache_write_tokens"] = _as_int(details.get("cache_write_tokens"))
            self._telemetry(rec)
        except Exception:
            pass

    async def chat(
        self,
        messages: list[Any],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        audio: Any = None,
        tools: list[dict] | None = None,
        think: bool = False,
    ) -> AsyncIterator[Any]:
        # Imported lazily so this module stays importable without the package.
        from llm_adapters.types import Token

        # ``audio`` and ``think`` are intentionally ignored for v1 — we don't
        # forward reasoning/audio params; keep the request minimal and portable.
        model_id = model or "openai/gpt-4o-mini"
        # Cache de prompt: o prompt de sistema + o bloco de ferramentas são
        # grandes e estáveis entre turnos, e eram reenviados a preço cheio a
        # cada chamada (medido: ~59k tokens de entrada por chamada, 816:1
        # contra a saída). Só marcamos onde o provedor exige o breakpoint
        # explícito; para o resto do catálogo o corpo não muda.
        oai_messages = _to_openai_messages(
            messages, cache_system=_supports_cache_breakpoints(model_id)
        )
        body: dict[str, Any] = {
            "model": model_id,
            "messages": oai_messages,
            "temperature": temperature,
            "stream": True,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        # Ask OpenRouter to append a final usage frame to the stream so we can
        # record token counts. Only requested when a telemetry sink is present
        # — otherwise the request stays byte-for-byte identical to before.
        if self._telemetry is not None:
            body["usage"] = {"include": True}
        # Esforço de raciocínio, quando o usuário escolheu um. Mandamos o bloco
        # normalizado da OpenRouter (`reasoning.effort`) e não o
        # `reasoning_effort` nativo da OpenAI: é ele que a OpenRouter traduz
        # para o orçamento de tokens dos modelos Anthropic e Gemini.
        if self.effort is not None:
            body["reasoning"] = {"effort": self.effort}

        try:
            async for tok in self._stream(body, model_id):
                yield tok
            return
        except _ReasoningRecusado:
            # Rede de segurança: a UI só oferece esforço para modelo que anuncia
            # `reasoning` no catálogo, mas o ajuste fica GRAVADO e o modelo pode
            # mudar depois (ou o provedor por trás pode recusar). Repetir uma vez
            # sem o bloco é melhor que derrubar o turno — o usuário perde o
            # raciocínio, não a resposta. `_stream` só levanta isso antes de
            # qualquer token ter saído, então repetir não duplica nada na tela.
            logger.warning(
                "OpenRouter recusou reasoning em %s; repetindo sem esforço", model_id
            )
        # CÓPIA, não `body.pop`. O dicionário original já foi entregue ao cliente
        # HTTP da primeira tentativa; mutá-lo depende de o httpx ter serializado
        # na hora — verdade hoje, e uma corrupção silenciosa da requisição no dia
        # em que deixar de ser. A cópia também é o que torna a diferença entre as
        # duas tentativas observável (e testável): exatamente o bloco removido.
        sem_reasoning = {k: v for k, v in body.items() if k != "reasoning"}
        async for tok in self._stream(sem_reasoning, model_id):
            yield tok

    async def _stream(self, body: dict[str, Any], model_id: str) -> AsyncIterator[Any]:
        """Uma tentativa: abre o stream, emite os Tokens, registra o usage.

        Levanta ``_ReasoningRecusado`` quando o corpo levava ``reasoning`` e a
        OpenRouter recusou por causa dele — sempre ANTES do primeiro yield, que
        é o que torna a repetição do chamador segura.
        """
        from llm_adapters.types import Token

        # index -> accumulated tool call ({"id","name","arguments"}).
        acc: dict[int, dict[str, str]] = {}
        usage: dict[str, Any] = {}

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            async with client.stream(
                "POST",
                f"{OPENROUTER_BASE}/chat/completions",
                headers=_or_headers(self.api_key),
                json=body,
            ) as r:
                if r.status_code != 200:
                    raw = (await r.aread()).decode("utf-8", "replace")
                    if "reasoning" in body and _erro_de_reasoning(raw):
                        raise _ReasoningRecusado()
                    raise RuntimeError(
                        f"OpenRouter chat failed: {r.status_code} {raw[:500]}"
                    )
                async for line in r.aiter_lines():
                    if not line or not line.startswith("data:"):
                        # SSE comments (": ...") / blank keepalive lines.
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        obj = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    # Usage may ride on its own (usually empty-choices) frame.
                    if obj.get("usage"):
                        usage = obj["usage"]
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    try:
                        delta = choices[0].get("delta") or {}
                    except (IndexError, KeyError, AttributeError):
                        continue
                    content = delta.get("content")
                    if content:
                        yield Token(text=content)
                    for tc in delta.get("tool_calls") or []:
                        idx = tc.get("index", 0)
                        slot = acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                        if tc.get("id"):
                            slot["id"] = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] = fn["name"]
                        if fn.get("arguments"):
                            slot["arguments"] += fn["arguments"]

        self._emit_usage(model_id, usage)

        if acc:
            tool_calls = [
                {
                    "id": slot["id"] or f"call_{idx}",
                    "type": "function",
                    "function": {
                        "name": slot["name"],
                        "arguments": slot["arguments"] or "{}",
                    },
                }
                for idx, slot in sorted(acc.items())
            ]
            yield Token(text="", done=True, tool_calls=tool_calls)
        else:
            yield Token(text="", done=True)


CLIPROXY_DEFAULT = "cliproxy:claude-haiku-4-5-20251001"


@dataclass
class RoleLLM:
    provider: str  # "cliproxy" | "openrouter"
    model: str
    _app_llm: Any = None  # AnthropicClient when cliproxy
    _or: Any = None  # OpenRouterClient when openrouter

    async def complete(
        self, messages: list[dict[str, str]], *, max_tokens: int = 4096
    ) -> str:
        if self.provider == "openrouter":
            return await self._or.complete(messages, model=self.model, max_tokens=max_tokens)
        # cliproxy: collapse to a single chat() pass, accumulate tokens
        from llm_adapters.types import ChatMessage

        chat_msgs = [ChatMessage(role=m["role"], content=m["content"]) for m in messages]
        out = []
        async for tok in self._app_llm.chat(chat_msgs, model=self.model):
            if tok.text:
                out.append(tok.text)
        return "".join(out)

    async def complete_json(
        self, *, system: str, user: str, tool: dict, max_tokens: int = 1024
    ) -> dict:
        if self.provider == "openrouter":
            # Ask for raw JSON in the prompt (+ request the json_object response
            # format), then parse defensively — never raise on a malformed reply.
            try:
                raw = await self._or.complete(
                    [
                        {
                            "role": "system",
                            "content": system + "\nResponda SOMENTE com JSON válido.",
                        },
                        {"role": "user", "content": user},
                    ],
                    model=self.model,
                    max_tokens=max_tokens,
                    response_format={"type": "json_object"},
                )
            except Exception:
                return {}
            return _parse_json_object(raw)
        return await self._app_llm.tool_call_json(
            system=system, user=user, tool=tool, max_tokens=max_tokens, model=self.model
        )

    async def stream(
        self, messages: list[dict[str, str]], *, max_tokens: int = 8192
    ) -> AsyncIterator[str]:
        if self.provider == "openrouter":
            async for chunk in self._or.stream(
                messages, model=self.model, max_tokens=max_tokens
            ):
                yield chunk
            return
        from llm_adapters.types import ChatMessage

        chat_msgs = [ChatMessage(role=m["role"], content=m["content"]) for m in messages]
        async for tok in self._app_llm.chat(chat_msgs, model=self.model):
            if tok.text:
                yield tok.text


KNOWN_PROVIDERS = ("openrouter", "cliproxy")


def normalize_model_spec(spec: str | None) -> str:
    """Colapsa um prefixo de provider repetido em ``<provider>:<model id>``.

    ``/deepsearch/models`` já devolve ids COM prefixo (``openrouter:<id>``).
    Um cliente que prefixe de novo grava ``openrouter:openrouter:<id>``; o
    strip de um nível deixa ``openrouter:<id>`` como model id e a OpenRouter
    responde 400 "is not a valid model ID" — que foi exatamente o que
    aconteceu em produção.

    Idempotente: um spec correto atravessa inalterado. Vazio vira o padrão
    cliproxy, porque um model id vazio não é roteável.
    """
    s = (spec or "").strip()
    if not s:
        return "cliproxy"
    for provider in KNOWN_PROVIDERS:
        prefix = f"{provider}:"
        if s.startswith(prefix):
            rest = s[len(prefix):]
            while rest.startswith(prefix):
                rest = rest[len(prefix):]
            return f"{prefix}{rest}" if rest else "cliproxy"
    return s


def resolve_role_model(spec: str, *, app_llm: Any, openrouter_key: str) -> RoleLLM:
    spec = normalize_model_spec(spec)
    provider, _, model = spec.partition(":")
    if provider == "openrouter":
        if not openrouter_key:
            # fall back to cliproxy default — never hard-fail a run on a missing key
            cp_model = CLIPROXY_DEFAULT.split(":", 1)[1]
            return RoleLLM(provider="cliproxy", model=cp_model, _app_llm=app_llm)
        return RoleLLM(
            provider="openrouter", model=model, _or=OpenRouterClient(openrouter_key)
        )
    return RoleLLM(provider="cliproxy", model=model, _app_llm=app_llm)
