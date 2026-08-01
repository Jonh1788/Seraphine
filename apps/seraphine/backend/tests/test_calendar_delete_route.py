"""``DELETE /google/calendar/events/{event_id}`` — apagar um evento.

POR QUE ELA EXISTE
------------------
``POST /google/calendar/events`` nasceu e nunca foi exercitada contra produção
de propósito: criar um compromisso de verdade no Google do usuário, sem meio de
desfazer pelo telefone, não é um teste — é um estrago. Esta rota é o que destrava
aquele: criar pelo celular e apagar pelo celular.

O QUE ESTE ARQUIVO PRENDE
-------------------------
1. **O IDENTIFICADOR.** A lição do ``FactCreate.source`` (um ``str`` onde a
   leitura tinha um ``Literal``, que aceitava 201 e derrubava a lista inteira)
   aqui é MUITO pior, e não é hipótese — está medido:

       httpx.URL(".../calendars/primary/events/..")
           → "https://www.googleapis.com/calendar/v3/calendars/primary"

   O httpx normaliza os segmentos de ponto ANTES de mandar. Um ``event_id`` de
   ``..`` transformaria um ``DELETE`` de evento num ``DELETE`` de CALENDÁRIO —
   a agenda inteira, não uma linha. ``../../outro`` alcança um calendário
   arbitrário. Daí o identificador ser validado em DOIS lugares: na rota (que dá
   o 422 com a frase) e dentro de ``client.delete_event`` (que é a barreira que
   nenhum chamador — nem a ferramenta do modelo, nem a rota da Aura — consegue
   contornar).

2. **SUCESSO NÃO PODE SER INVENTADO.** A ``/planning/accept`` responde
   ``ok:true`` com zero eventos quando não há Google, e a tela de Planejamento
   teve que desmentir isso na mão. Aqui: sem Google conectado é 401, erro do
   Google é erro, e o único ``ok:true`` que não apagou nada nesta chamada é o
   404/410 — que vem marcado com ``ja_nao_existia`` para ninguém confundir "já
   não estava lá" com "eu apaguei agora".

3. **A TELA PRECISA DO ID.** O agregado (``GET /calendar/aggregate``) é de onde
   a lista do dia do celular sai. Sem o ``id`` do evento ali, a linha na tela
   não sabe QUAL evento é, e apagar viraria adivinhação por título — que é a
   mesma classe de dano do item 1.
"""

from __future__ import annotations

import inspect
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from urllib.parse import quote

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from google_integration.client import GoogleAPIError, GoogleAuthError, GoogleClient
from google_integration.routes import _ID_DE_EVENTO, calendar_delete_event
from google_integration.token_store import TokenBundle, TokenStore
from seraphine.main import app
from seraphine.tools.google import CalendarBulkDeleteEventsTool, CalendarDeleteEventTool


# ----------------------------------------------------------------------
# Dublês
# ----------------------------------------------------------------------


class _StubGoogle:
    """Só o que a rota toca. Qualquer outro método é erro de teste."""

    def __init__(
        self,
        *,
        authed: bool = True,
        erro: Exception | None = None,
    ) -> None:
        self._authed = authed
        self._erro = erro
        self.chamadas: list[dict[str, Any]] = []

    async def is_authed(self) -> bool:
        return self._authed

    async def delete_event(self, event_id: str, **kwargs: Any) -> None:
        self.chamadas.append({"event_id": event_id, **kwargs})
        if self._erro is not None:
            raise self._erro


def _swap_client(stub: Any) -> Any:
    prev = getattr(app.state, "google_client", None)
    app.state.google_client = stub
    return prev


@pytest.fixture(scope="module")
def http():
    """Um único boot do app para o arquivo inteiro (o lifespan custa ~25s)."""
    with TestClient(app) as client:
        yield client


def _delete(http: TestClient, stub: Any, event_id: str) -> httpx.Response:
    prev = _swap_client(stub)
    try:
        # `quote(safe="")` é o que o `encodeURIComponent` da camada do
        # frontend faz: o id inteiro vira UM segmento de caminho.
        return http.request("DELETE", f"/google/calendar/events/{quote(event_id, safe='')}")
    finally:
        _swap_client(prev)


class _RequestFalso:
    """O mínimo que ``_client_or_503`` lê.

    Existe porque ".." NÃO CHEGA pelo TestClient: o httpx remove segmentos de
    ponto ao montar a URL, e ``quote`` não escapa ponto (é caractere não
    reservado). Ou seja, este cliente HTTP não consegue nem enviar o ataque —
    mas um ``curl --path-as-is``, ou qualquer cliente que não normalize,
    consegue, e aí o handler recebe ``event_id='..'`` de verdade. Chamar o
    handler direto é a única forma honesta de exercitar esse caminho.
    """

    def __init__(self, cliente: Any) -> None:
        self.app = type("_App", (), {"state": type("_State", (), {"google_client": cliente})()})()


def _google_api_error(status: int, reason: str = "notFound") -> GoogleAPIError:
    return GoogleAPIError(
        status_code=status,
        method="DELETE",
        url="https://www.googleapis.com/calendar/v3/calendars/primary/events/evt-1",
        body='{"error": {"code": %d}}' % status,
        reason=reason,
    )


# ----------------------------------------------------------------------
# Caminho feliz
# ----------------------------------------------------------------------


def test_apaga_o_evento_e_diz_qual(http) -> None:
    stub = _StubGoogle()
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["ok"] is True
    # O id VOLTA. Quem chamou confere que sumiu o que pediu para sumir.
    assert corpo["id"] == "evt-1"
    assert corpo["ja_nao_existia"] is False
    assert [c["event_id"] for c in stub.chamadas] == ["evt-1"]


def test_a_exclusao_so_alcanca_o_calendario_que_a_leitura_consulta(http) -> None:
    """Mesma amarra da criação: apagar num calendário que a leitura não abre
    seria apagar algo que a tela nunca mostrou."""
    lido = inspect.signature(GoogleClient.list_events).parameters["calendar_id"].default

    stub = _StubGoogle()
    assert _delete(http, stub, "evt-1").status_code == 200
    assert stub.chamadas[0].get("calendar_id", lido) == lido


@pytest.mark.parametrize(
    "event_id",
    [
        "evt-1",
        "abc123_20260620T120000Z",  # instância de um evento recorrente
        "6d3n0l6qk8vp6b9k6ss30b9k6c",  # base32hex, a forma documentada
        "importado@google.com",  # evento importado de outro calendário
        "a" * 1024,  # o teto documentado pelo Google
    ],
)
def test_os_ids_que_o_google_realmente_emite_passam(http, event_id: str) -> None:
    """O guarda não pode ser mais estrito que a realidade: instância de
    recorrente tem ``_``/maiúsculas, importado tem ``@``."""
    stub = _StubGoogle()
    resp = _delete(http, stub, event_id)
    assert resp.status_code == 200, resp.text
    assert stub.chamadas[0]["event_id"] == event_id


# ----------------------------------------------------------------------
# O identificador — o dano mede-se em CALENDÁRIO, não em linha
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "event_id,motivo",
    [
        ("...", "só pontos, nenhum caractere de id"),
        ("a b", "espaço — %20 chega decodificado no handler"),
        ("evt#1", "fragmento"),
        ("evt%1", "escape quebrado"),
        ("evt*", "fora do alfabeto"),
        ("<script>", "nem parece id"),
        ("a" * 1025, "acima do teto do Google"),
    ],
)
def test_id_invalido_responde_422_sem_tocar_no_google(
    http, event_id: str, motivo: str
) -> None:
    stub = _StubGoogle()
    resp = _delete(http, stub, event_id)

    assert resp.status_code == 422, f"{motivo}: {resp.status_code} {resp.text}"
    assert "identificador" in resp.json()["detail"].lower(), motivo
    # E O GOOGLE NÃO FOI TOCADO. É esta linha que separa "recusou" de
    # "recusou depois de apagar".
    assert stub.chamadas == [], motivo


@pytest.mark.parametrize("event_id", ["..", ".", "../..", ""])
async def test_a_rota_recusa_o_segmento_de_ponto_que_o_httpx_nem_deixa_enviar(
    event_id: str,
) -> None:
    """O caso que mais dói, exercitado onde ele existe.

    Ver ``_RequestFalso``: o TestClient não consegue mandar ``..`` (o httpx
    normaliza antes de sair), então o teste acima nunca cobriria isto. Um
    cliente que não normalize manda, e aí o handler recebe o ``..`` cru.
    """
    stub = _StubGoogle()
    with pytest.raises(HTTPException) as exc:
        await calendar_delete_event(_RequestFalso(stub), event_id)  # type: ignore[arg-type]

    assert exc.value.status_code == 422
    assert "identificador" in str(exc.value.detail).lower()
    assert stub.chamadas == []


def test_o_guarda_do_id_recusa_o_que_a_normalizacao_do_httpx_transformaria() -> None:
    """A medida crua, sem rota no meio, do que motivou o guarda."""
    assert httpx.URL(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/.."
    ).path == "/calendar/v3/calendars/primary"

    for perigoso in ("..", ".", "../..", "", "   "):
        assert not _ID_DE_EVENTO.match(perigoso), perigoso


async def test_o_cliente_recusa_o_id_perigoso_sem_emitir_requisicao(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A barreira que nenhum chamador contorna.

    A rota valida, mas a ferramenta do modelo e a rota da Aura chamam
    ``client.delete_event`` direto — e o id delas vem de um LLM. O guarda mora
    no caminho de escrita, então vale para todos.
    """
    client = await _cliente_autenticado(tmp_path)
    pedidos: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(f"{request.method} {request.url}")
        return httpx.Response(204)

    _patch_httpx(monkeypatch, handler)

    for perigoso in ("..", "../../outro", "", "   ", "a/b"):
        with pytest.raises(ValueError):
            await client.delete_event(perigoso)

    assert pedidos == [], "nenhuma requisição podia ter saído"


async def test_a_url_do_delete_e_a_do_evento(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = await _cliente_autenticado(tmp_path)
    pedidos: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(f"{request.method} {request.url.path}")
        return httpx.Response(204)

    _patch_httpx(monkeypatch, handler)
    await client.delete_event("evt-del")

    assert pedidos == ["DELETE /calendar/v3/calendars/primary/events/evt-del"]


# ----------------------------------------------------------------------
# Google desconectado / erro do Google — sucesso não se inventa
# ----------------------------------------------------------------------


def test_google_desconectado_responde_401_e_diz_o_que_fazer(http) -> None:
    stub = _StubGoogle(authed=False)
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 401, resp.text
    detalhe = resp.json()["detail"]
    assert "Google" in detalhe
    assert "/google/oauth/start" in detalhe
    assert stub.chamadas == []


def test_credencial_sumida_no_meio_do_caminho_tambem_e_401(http) -> None:
    stub = _StubGoogle(erro=GoogleAuthError("no google credentials on file"))
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 401, resp.text
    assert "google" in resp.json()["detail"].lower()


def test_integracao_nao_configurada_responde_503(http) -> None:
    resp = _delete(http, None, "evt-1")
    assert resp.status_code == 503, resp.text


def test_permissao_insuficiente_nao_vira_sucesso(http) -> None:
    """403 é 403. Se virasse 200, a linha sumiria da tela e o compromisso
    continuaria no Google — o pior resultado possível desta rota."""
    stub = _StubGoogle(erro=_google_api_error(403, "insufficientPermissions"))
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 403, resp.text
    assert "/google/oauth/start" in resp.json()["detail"]


def test_erro_do_google_vira_502_e_nao_ok(http) -> None:
    stub = _StubGoogle(erro=_google_api_error(500, "backendError"))
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 502, resp.text


def test_falha_inesperada_tambem_nao_vira_ok(http) -> None:
    stub = _StubGoogle(erro=RuntimeError("socket fechou"))
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 502, resp.text


# ----------------------------------------------------------------------
# "Já não existia" — ok:true honesto, e marcado
# ----------------------------------------------------------------------


@pytest.mark.parametrize("status", [404, 410])
def test_evento_que_ja_sumiu_responde_ok_dizendo_que_ja_nao_existia(
    http, status: int
) -> None:
    """Apagado pela web enquanto a tela estava aberta. O resultado para quem
    pediu é o mesmo — o evento não está na agenda —, mas a resposta não finge
    que foi ESTA chamada que o apagou."""
    stub = _StubGoogle(erro=_google_api_error(status, "notFound"))
    resp = _delete(http, stub, "evt-1")

    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["ok"] is True
    assert corpo["ja_nao_existia"] is True
    assert corpo["id"] == "evt-1"


def test_a_exclusao_de_verdade_nao_se_marca_como_ja_nao_existia(http) -> None:
    """A outra metade do teste acima: a distinção precisa distinguir."""
    resp = _delete(http, _StubGoogle(), "evt-1")
    assert resp.json()["ja_nao_existia"] is False


# ----------------------------------------------------------------------
# Um caminho de escrita só — a rota e a ferramenta do modelo
# ----------------------------------------------------------------------


async def test_a_ferramenta_do_modelo_usa_o_mesmo_caminho_de_escrita_da_rota(
    tmp_path: Path,
) -> None:
    """Igual ao que a criação fez: a ferramenta montava a URL na mão e chamava
    ``_authed_request``. Duas cópias da mesma escrita divergem — e só uma das
    duas teria ganhado o guarda do identificador."""
    client = await _cliente_autenticado(tmp_path)
    chamadas: list[tuple[str, dict[str, Any]]] = []

    async def _delete_event(event_id: str, **kwargs: Any) -> None:
        chamadas.append((event_id, kwargs))

    client.delete_event = _delete_event  # type: ignore[method-assign]

    resultado = await CalendarDeleteEventTool(client).execute({"event_id": "evt-9"})

    assert resultado.ok is True
    assert chamadas == [("evt-9", {"calendar_id": "primary"})]


async def test_a_ferramenta_do_modelo_recusa_o_id_perigoso(tmp_path: Path) -> None:
    """O id da ferramenta vem de um LLM — é a fonte menos confiável de todas."""
    client = await _cliente_autenticado(tmp_path)
    resultado = await CalendarDeleteEventTool(client).execute({"event_id": ".."})

    assert resultado.ok is False
    assert "identificador" in (resultado.error or "").lower()


async def test_a_ferramenta_em_lote_tambem_passa_pelo_guarda(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cliente de verdade: o guarda tem que agir DENTRO de ``delete_event``,
    senão o lote seria a porta que sobrou aberta."""
    client = await _cliente_autenticado(tmp_path)
    pedidos: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        pedidos.append(request.url.path)
        return httpx.Response(204)

    _patch_httpx(monkeypatch, handler)

    resultado = await CalendarBulkDeleteEventsTool(client).execute(
        {"event_ids": ["evt-1", "..", "evt-2"]}
    )

    # O id perigoso falha SOZINHO; os outros dois foram apagados, e nenhuma
    # requisição saiu para o calendário.
    assert pedidos == [
        "/calendar/v3/calendars/primary/events/evt-1",
        "/calendar/v3/calendars/primary/events/evt-2",
    ]
    assert resultado.metadata["deleted_count"] == 2
    assert [f["event_id"] for f in resultado.metadata["failed"]] == [".."]


async def test_em_lote_um_evento_que_ja_sumiu_conta_como_apagado(
    tmp_path: Path,
) -> None:
    """O comentário do lote sempre disse que 410 é aceitável, mas
    ``_authed_request`` levanta em tudo >= 400: o ramo era código morto e um
    evento já apagado contava como FALHA."""
    client = await _cliente_autenticado(tmp_path)

    async def _delete_event(event_id: str, **kwargs: Any) -> None:
        raise _google_api_error(410, "deleted")

    client.delete_event = _delete_event  # type: ignore[method-assign]

    resultado = await CalendarBulkDeleteEventsTool(client).execute(
        {"event_ids": ["evt-1"]}
    )

    assert resultado.ok is True
    assert resultado.metadata["deleted_count"] == 1


# ----------------------------------------------------------------------
# A tela precisa saber QUAL evento é
# ----------------------------------------------------------------------


def test_o_agregado_carrega_o_id_do_evento(http) -> None:
    """A lista do dia do celular sai de ``GET /calendar/aggregate``. Sem o id
    ali, a linha na tela não sabe qual evento apagar — e casar por título e
    horário é a mesma adivinhação que o guarda do identificador existe para
    impedir (dois "Dentista" às 14h são dois eventos diferentes)."""

    class _StubLista:
        async def is_authed(self) -> bool:
            return True

        async def list_events(self, **kwargs: Any) -> list[dict[str, Any]]:
            return [
                {
                    "id": "evt-do-dia",
                    "summary": "Dentista",
                    "start": {"dateTime": "2026-06-19T14:00:00-03:00"},
                    "end": {"dateTime": "2026-06-19T15:00:00-03:00"},
                }
            ]

    prev = _swap_client(_StubLista())
    try:
        resp = http.get("/calendar/aggregate?start=2026-06-19&end=2026-06-19")
    finally:
        _swap_client(prev)

    assert resp.status_code == 200, resp.text
    eventos = resp.json()["days"][0]["events"]
    assert len(eventos) == 1
    assert eventos[0]["id"] == "evt-do-dia"
    assert eventos[0]["title"] == "Dentista"


# ----------------------------------------------------------------------
# Helpers de cliente real
# ----------------------------------------------------------------------


async def _cliente_autenticado(tmp_path: Path) -> GoogleClient:
    store = TokenStore(tmp_path / "tokens.enc")
    await store.save(
        TokenBundle(
            access_token="live",
            refresh_token="rt",
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
            scopes=[],
        )
    )
    return GoogleClient(
        token_store=store, client_id="cid", client_secret="sec", scopes=[]
    )


def _patch_httpx(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    real_ac = httpx.AsyncClient

    def patched_ac(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_ac(*args, **kwargs)

    monkeypatch.setattr("google_integration.client.httpx.AsyncClient", patched_ac)
