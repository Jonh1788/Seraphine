"""``POST /google/calendar/events`` — a rota de criação de evento.

POR QUE ELA EXISTE
------------------
A capacidade de criar evento existia só como ferramenta do modelo
(``calendar_create_event``). O modal de novo evento do celular não tinha onde
salvar: ``src/calendar/api.ts`` só lê.

O QUE ESTE ARQUIVO PRENDE
-------------------------
A lição do ``FactCreate.source``: **o modelo de ENTRADA tem que estar alinhado
com o modelo de LEITURA.** Aqui a leitura é o evento cru do Google que
``GET /google/calendar/events`` devolve, e ela distingue duas coisas que a
escrita podia atropelar em silêncio:

1. ``start.date`` (dia inteiro) contra ``start.dateTime`` (com hora) — é assim
   que ``google/utils.ts::isAllDay`` decide, e é o que ``calendar_agg`` usa
   como chave do dia. Emitir ``dateTime`` para um evento de dia inteiro
   INVENTA MEIA-NOITE: o evento existe, mas volta como um compromisso às 00:00.
2. o calendário alvo. Todo caminho de leitura deste app (o router, o
   ``calendar_agg``) chama ``list_events`` com o ``calendar_id`` padrão. Um
   evento criado em qualquer outro calendário nasce invisível para o app
   inteiro — por isso o payload não tem como escolher calendário, e o teste
   compara com o default da PRÓPRIA função de leitura.

E o conjunto de repetições aceito tem que ser exatamente o conjunto que sabemos
traduzir para RRULE: uma repetição sem tradução viraria um evento único, sem
erro nenhum — a repetição sumiria calada.
"""

from __future__ import annotations

import inspect
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, get_args

import httpx
import pytest
from fastapi.testclient import TestClient

from google_integration.client import GoogleAuthError, GoogleClient
from google_integration.routes import (
    _RRULE,
    CalendarEventCreate,
    Repeticao,
)
from google_integration.token_store import TokenBundle, TokenStore
from seraphine.main import app


# ----------------------------------------------------------------------
# Dublês
# ----------------------------------------------------------------------


class _StubGoogle:
    """Só o que a rota toca. Qualquer outro método é erro de teste."""

    def __init__(
        self,
        *,
        authed: bool = True,
        resultado: dict[str, Any] | None = None,
        erro: Exception | None = None,
    ) -> None:
        self._authed = authed
        self._resultado = resultado or {
            "id": "evt-1",
            "htmlLink": "https://cal.example/evt-1",
        }
        self._erro = erro
        self.chamadas: list[dict[str, Any]] = []

    async def is_authed(self) -> bool:
        return self._authed

    async def create_event(self, **kwargs: Any) -> dict[str, Any]:
        self.chamadas.append(kwargs)
        if self._erro is not None:
            raise self._erro
        return self._resultado


def _swap_client(stub: Any) -> Any:
    prev = getattr(app.state, "google_client", None)
    app.state.google_client = stub
    return prev


@pytest.fixture(scope="module")
def http():
    """Um único boot do app para o arquivo inteiro.

    Subir o lifespan custa ~25s (ele tenta alcançar cliproxy/ollama). Um
    ``TestClient`` por teste transformava este arquivo em dez minutos.
    """
    with TestClient(app) as client:
        yield client


def _post(http: TestClient, stub: Any, payload: dict[str, Any]) -> httpx.Response:
    prev = _swap_client(stub)
    try:
        return http.post("/google/calendar/events", json=payload)
    finally:
        _swap_client(prev)


COM_HORA = {
    "summary": "Retro do time",
    "start": "2026-06-19T14:00",
    "end": "2026-06-19T15:00",
}


# ----------------------------------------------------------------------
# Caminho feliz
# ----------------------------------------------------------------------


def test_cria_o_evento_e_devolve_o_que_criou(http) -> None:
    stub = _StubGoogle()
    resp = _post(http, stub, {**COM_HORA, "location": "Sala 3"})

    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["ok"] is True
    assert corpo["id"] == "evt-1"
    assert corpo["html_link"] == "https://cal.example/evt-1"
    assert corpo["all_day"] is False
    assert corpo["recurrence"] == []

    assert len(stub.chamadas) == 1
    kwargs = stub.chamadas[0]
    assert kwargs["summary"] == "Retro do time"
    assert kwargs["location"] == "Sala 3"
    assert kwargs["all_day"] is False


def test_hora_sem_fuso_e_de_sao_paulo_nao_de_utc(http) -> None:
    """O modal manda ``YYYY-MM-DDTHH:MM`` cru — a hora que a pessoa VIU.

    Lê-la como UTC empurraria um compromisso das 14:00 para as 11:00 na tela.
    A convenção do projeto (``planning/service.py``, ``journal``) é
    America/Sao_Paulo para horário local sem fuso.
    """
    stub = _StubGoogle()
    assert _post(http, stub, COM_HORA).status_code == 201

    inicio: datetime = stub.chamadas[0]["start"]
    assert inicio.utcoffset() == timedelta(hours=-3)
    assert (inicio.hour, inicio.minute) == (14, 0)


def test_fuso_explicito_e_respeitado(http) -> None:
    stub = _StubGoogle()
    payload = {**COM_HORA, "start": "2026-06-19T14:00:00Z", "end": "2026-06-19T15:00:00Z"}
    assert _post(http, stub, payload).status_code == 201

    inicio: datetime = stub.chamadas[0]["start"]
    assert inicio.utcoffset() == timedelta(0)


# ----------------------------------------------------------------------
# Dia inteiro — a distinção que a leitura faz
# ----------------------------------------------------------------------


def test_dia_inteiro_chega_ao_cliente_como_dia_inteiro(http) -> None:
    stub = _StubGoogle()
    resp = _post(
        http,
        stub,
        {"summary": "Feriado", "start": "2026-06-19", "end": "2026-06-19", "all_day": True},
    )

    assert resp.status_code == 201, resp.text
    assert resp.json()["all_day"] is True
    assert stub.chamadas[0]["all_day"] is True


async def test_dia_inteiro_vira_date_no_corpo_do_google_e_o_fim_e_exclusivo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O corpo de verdade, no cliente: ``date``, nunca ``dateTime``.

    ``isAllDay(ev)`` é ``!start.dateTime && !!start.date``. Um ``dateTime``
    aqui faria o evento voltar como um compromisso às 00:00 — a meia-noite
    inventada que o modal se recusa a mandar. E o ``end.date`` do Google é
    EXCLUSIVO: um evento de um dia só termina no dia seguinte.
    """
    client = await _cliente_autenticado(tmp_path)
    capturado: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        capturado["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"id": "evt-1"})

    _patch_httpx(monkeypatch, handler)

    await client.create_event(
        summary="Feriado",
        start=datetime(2026, 6, 19, tzinfo=timezone.utc),
        end=datetime(2026, 6, 19, tzinfo=timezone.utc),
        all_day=True,
    )

    assert capturado["body"]["start"] == {"date": "2026-06-19"}
    assert capturado["body"]["end"] == {"date": "2026-06-20"}
    assert "dateTime" not in json.dumps(capturado["body"])


async def test_com_hora_continua_saindo_como_datetime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """O outro lado da mesma moeda: sem dia inteiro, nada de ``date``."""
    client = await _cliente_autenticado(tmp_path)
    capturado: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        capturado["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(200, json={"id": "evt-1"})

    _patch_httpx(monkeypatch, handler)

    await client.create_event(
        summary="Retro",
        start=datetime(2026, 6, 19, 14, tzinfo=timezone.utc),
        end=datetime(2026, 6, 19, 15, tzinfo=timezone.utc),
    )

    assert "dateTime" in capturado["body"]["start"]
    assert "date" not in capturado["body"]["start"]


# ----------------------------------------------------------------------
# Repetição — o conjunto tem que fechar
# ----------------------------------------------------------------------


def test_toda_repeticao_aceita_tem_traducao_para_rrule(http) -> None:
    """A igualdade dos CONJUNTOS, não uma lista de valores conhecidos.

    Se alguém acrescentar 'quinzenal' ao ``Literal`` sem acrescentar a RRULE,
    o evento seria criado SEM repetição nenhuma — sem erro, sem aviso. E uma
    RRULE órfã no mapa é uma repetição que ninguém consegue pedir.
    """
    assert set(get_args(Repeticao)) == set(_RRULE)


def test_repeticao_semanal_vira_rrule(http) -> None:
    stub = _StubGoogle()
    resp = _post(http, stub, {**COM_HORA, "repeat": "semanal"})

    assert resp.status_code == 201, resp.text
    assert stub.chamadas[0]["recurrence"] == ["RRULE:FREQ=WEEKLY"]
    assert resp.json()["recurrence"] == ["RRULE:FREQ=WEEKLY"]


def test_sem_repeticao_nao_manda_recorrencia(http) -> None:
    """Ausência, não lista vazia: é ``None`` que faz o cliente omitir o campo."""
    stub = _StubGoogle()
    resp = _post(http, stub, {**COM_HORA, "repeat": "nunca"})
    assert resp.status_code == 201
    assert stub.chamadas[0]["recurrence"] is None
    assert resp.json()["recurrence"] == []


@pytest.mark.parametrize(
    "repeticao,rrule",
    [
        ("diario", "RRULE:FREQ=DAILY"),
        ("semanal", "RRULE:FREQ=WEEKLY"),
        ("mensal", "RRULE:FREQ=MONTHLY"),
        ("anual", "RRULE:FREQ=YEARLY"),
    ],
)
def test_cada_repeticao_tem_a_frequencia_do_google(http, repeticao: str, rrule: str) -> None:
    stub = _StubGoogle()
    assert _post(http, stub, {**COM_HORA, "repeat": repeticao}).status_code == 201
    assert stub.chamadas[0]["recurrence"] == [rrule]


# ----------------------------------------------------------------------
# O calendário alvo — escrever onde ninguém lê é o mesmo que não escrever
# ----------------------------------------------------------------------


def test_a_escrita_so_alcanca_o_calendario_que_a_leitura_consulta(http) -> None:
    """Todo caminho de leitura usa o ``calendar_id`` PADRÃO de ``list_events``.

    Se o payload pudesse escolher outro, o evento nasceria invisível para o
    app inteiro: nem o router (``GET /google/calendar/events``) nem o
    ``calendar_agg`` passam ``calendar_id``.
    """
    lido = inspect.signature(GoogleClient.list_events).parameters["calendar_id"].default

    stub = _StubGoogle()
    assert _post(http, stub, COM_HORA).status_code == 201
    assert stub.chamadas[0].get("calendar_id", lido) == lido

    # E não há campo de entrada capaz de mudar isso.
    assert "calendar_id" not in CalendarEventCreate.model_fields


def test_calendar_id_no_payload_e_ignorado_e_nao_vaza_para_o_google(http) -> None:
    stub = _StubGoogle()
    resp = _post(http, stub, {**COM_HORA, "calendar_id": "financas"})

    assert resp.status_code == 201, resp.text
    assert stub.chamadas[0].get("calendar_id", "primary") == "primary"


# ----------------------------------------------------------------------
# Google desconectado — o caso que mais importa depois do sucesso
# ----------------------------------------------------------------------


def test_google_desconectado_responde_401_e_diz_o_que_fazer(http) -> None:
    """A rota ``/planning/accept`` responde ``ok:true`` com zero eventos quando
    não há Google. Aqui não: não deu para criar, a resposta diz isso."""
    stub = _StubGoogle(authed=False)
    resp = _post(http, stub, COM_HORA)

    assert resp.status_code == 401, resp.text
    detalhe = resp.json()["detail"]
    assert "Google" in detalhe
    assert "/google/oauth/start" in detalhe
    # e nada foi tentado contra o Google
    assert stub.chamadas == []


def test_credencial_sumida_no_meio_do_caminho_tambem_e_401(http) -> None:
    stub = _StubGoogle(erro=GoogleAuthError("no google credentials on file"))
    resp = _post(http, stub, COM_HORA)

    assert resp.status_code == 401, resp.text
    assert "google" in resp.json()["detail"].lower()


def test_integracao_nao_configurada_responde_503(http) -> None:
    resp = _post(http, None, COM_HORA)
    assert resp.status_code == 503, resp.text


# ----------------------------------------------------------------------
# Payload inválido — 422 antes de tocar no Google
# ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload,motivo",
    [
        ({"summary": "", "start": "2026-06-19T14:00", "end": "2026-06-19T15:00"}, "título vazio"),
        ({"summary": "  ", "start": "2026-06-19T14:00", "end": "2026-06-19T15:00"}, "título em branco"),
        ({"summary": "x", "start": "2026-06-19", "end": "2026-06-19T15:00"}, "com hora, mas o início é só um dia"),
        ({"summary": "x", "start": "2026-06-19T14:00", "end": "2026-06-19"}, "com hora, mas o fim é só um dia"),
        ({"summary": "x", "start": "2026-06-19T14:00", "end": "2026-06-19T13:00"}, "fim antes do início"),
        ({"summary": "x", "start": "ontem", "end": "hoje"}, "não é data nenhuma"),
        (
            {"summary": "x", "start": "2026-02-30T14:00", "end": "2026-02-30T15:00"},
            "a forma casa mas o dia não existe",
        ),
        (
            {"summary": "x", "start": "2026-02-30", "end": "2026-02-30", "all_day": True},
            "dia inteiro num dia que não existe",
        ),
        (
            {"summary": "x", "start": "2026-06-19T14:00", "end": "2026-06-19T15:00", "repeat": "quinzenal"},
            "repetição fora do conjunto",
        ),
        (
            {"summary": "x", "start": "2026-06-19T14:00", "end": "2026-06-19T15:00", "all_day": True},
            "dia inteiro com hora dentro",
        ),
        (
            {"summary": "x", "start": "2026-06-20", "end": "2026-06-19", "all_day": True},
            "dia inteiro com o fim antes do início",
        ),
    ],
)
def test_payload_invalido_responde_422_sem_tocar_no_google(
    http, payload: dict[str, Any], motivo: str
) -> None:
    stub = _StubGoogle()
    resp = _post(http, stub, payload)

    assert resp.status_code == 422, f"{motivo}: {resp.text}"
    assert stub.chamadas == [], motivo


def test_dia_inteiro_de_um_dia_so_e_valido(http) -> None:
    """A borda do teste acima: início == fim é um evento de UM dia, não erro."""
    stub = _StubGoogle()
    resp = _post(
        http,
        stub,
        {"summary": "Feriado", "start": "2026-06-19", "end": "2026-06-19", "all_day": True},
    )
    assert resp.status_code == 201, resp.text


def test_evento_com_hora_de_duracao_zero_e_valido(http) -> None:
    stub = _StubGoogle()
    resp = _post(
        http, stub, {"summary": "x", "start": "2026-06-19T14:00", "end": "2026-06-19T14:00"}
    )
    assert resp.status_code == 201, resp.text


def test_local_vazio_nao_vira_local_em_branco_no_google(http) -> None:
    """O modal manda ``local: ''`` quando a pessoa não preencheu."""
    stub = _StubGoogle()
    assert _post(http, stub, {**COM_HORA, "location": ""}).status_code == 201
    assert stub.chamadas[0].get("location") is None


# ----------------------------------------------------------------------
# Helpers de cliente real (para os testes de corpo)
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
