"""Teto mensal de custo.

Dois erros de modelagem estão travados aqui, porque a tela de Custos não tem
como se recuperar deles depois:

1. **`NULL` não é `0.0`.** "Nunca configurei um teto" e "meu teto é zero" são
   estados diferentes: o primeiro pede o convite a definir um orçamento, o
   segundo diz que qualquer centavo já estourou. Se a API colapsar os dois num
   valor só, a tela não tem de onde separar. O erro concreto é escrever
   `if monthly_usd` onde cabia `is not None` — já apareceu duas vezes neste
   módulo (custo reportado pelo provedor, normalização de modelo).

2. **Mês de calendário não é "últimos 30 dias".** O teto é mensal e vira no dia
   1º. Uma janela deslizante daria um número que nunca zera e que não bate com
   nenhum extrato. Por isso o gasto do bloco `budget` ignora o `days=` do
   summary de propósito.

E uma armadilha aritmética: `gasto / dias_decorridos` divide por zero no dia 1º
se "decorridos" for contado como dias inteiros completos.
"""
from __future__ import annotations

import asyncio
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.memory.store import MemoryStore
from seraphine.telemetry import TelemetryService
from seraphine.telemetry import budget as budget_mod
from seraphine.telemetry import schema
from seraphine.telemetry.routes import router


# ----------------------------------------------------------------------
# fixtures / helpers
# ----------------------------------------------------------------------

@pytest.fixture
async def service(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("telemetry", schema.migrate)
    await store.ensure_schema()
    return TelemetryService(store)


def _seed_call(store, *, ts: datetime, cost_usd: float) -> None:
    """Grava uma chamada com timestamp arbitrário.

    `record()` sempre carimba `now`; a virada de mês só é testável com uma
    linha datada no mês anterior. Espelha o INSERT do service de propósito —
    é o mesmo formato ISO/UTC que ele grava, que é justamente o que a
    comparação `ts >= ?` depende.
    """
    with store._connect() as conn:
        conn.execute(
            "INSERT INTO llm_usage (id, ts, backend, model, feature,"
            " input_tokens, output_tokens, cost_usd)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), ts.astimezone(timezone.utc).isoformat(),
             "openrouter", "x/y", "chat", 0, 0, float(cost_usd)),
        )


# ----------------------------------------------------------------------
# summary — o contrato que a tela de Custos lê
# ----------------------------------------------------------------------

async def test_sem_orcamento_o_summary_traz_budget_nulo(service):
    s = await service.summary(days=30)
    assert s["budget"] is None


async def test_projecao_usa_gasto_real_do_mes(service):
    await service.set_budget(30.0)
    await service.record(backend="openrouter", model="x/y", cost_usd=11.60)
    s = await service.summary(days=30)
    b = s["budget"]
    assert b["monthly_usd"] == 30.0
    assert b["spent_usd"] == pytest.approx(11.60)
    assert b["days_left"] >= 0
    # projeção = gasto/dia decorrido * dias do mês; nunca negativa
    assert b["projected_usd"] >= b["spent_usd"]


async def test_orcamento_zero_e_valido_e_diferente_de_ausente(service):
    """0 significa 'não quero gastar nada'. `null` significa 'não configurei'."""
    await service.set_budget(0.0)
    s = await service.summary(days=30)
    assert s["budget"] is not None
    assert s["budget"]["monthly_usd"] == 0.0


async def test_teto_zero_com_gasto_ja_estourou(service):
    """A leitura que a tela precisa fazer de um teto zero: sem percentual
    possível (divisão por zero), mas estourado — o oposto de 'não configurado',
    que não estoura nada."""
    await service.set_budget(0.0)
    await service.record(backend="openrouter", model="x/y", cost_usd=0.01)
    b = (await service.summary(days=30))["budget"]
    assert b["over_budget"] is True
    assert b["pct_used"] is None  # 0.01/0 não é um percentual


async def test_teto_zero_sem_gasto_nao_estourou(service):
    """Contraprova do teste acima: `over_budget` olha o gasto, não o teto."""
    await service.set_budget(0.0)
    b = (await service.summary(days=30))["budget"]
    assert b["over_budget"] is False


async def test_bloco_budget_tem_exatamente_as_chaves_do_contrato(service):
    """A Task 12 lê estas chaves. Remover ou renomear uma quebra a tela."""
    await service.set_budget(10.0)
    b = (await service.summary(days=30))["budget"]
    assert set(b) == {
        "monthly_usd", "spent_usd", "days_left", "projected_usd",
        "pct_used", "over_budget",
    }


async def test_gasto_do_mes_ignora_o_parametro_days(service):
    """`days=` recorta os agregados de cima; o teto é mensal e não se move com
    ele. Com days=1 e days=30 o mesmo gasto do mês aparece no bloco."""
    await service.set_budget(50.0)
    await service.record(backend="openrouter", model="x/y", cost_usd=7.0)
    um = (await service.summary(days=1))["budget"]
    trinta = (await service.summary(days=30))["budget"]
    assert um["spent_usd"] == trinta["spent_usd"] == pytest.approx(7.0)


# ----------------------------------------------------------------------
# get/set — NULL vs 0.0 no armazenamento
# ----------------------------------------------------------------------

async def test_budget_comeca_nulo(service):
    assert await service.get_budget() is None


async def test_set_e_get_fazem_roundtrip(service):
    await service.set_budget(42.5)
    assert await service.get_budget() == 42.5


async def test_zero_sobrevive_ao_roundtrip(service):
    """O caso que um `if monthly_usd` transforma em NULL na gravação."""
    await service.set_budget(0.0)
    lido = await service.get_budget()
    assert lido is not None, "0.0 virou 'não configurado' na ida ou na volta"
    assert lido == 0.0


async def test_set_none_limpa_o_teto(service):
    await service.set_budget(30.0)
    await service.set_budget(None)
    assert await service.get_budget() is None
    assert (await service.summary(days=30))["budget"] is None


async def test_teto_negativo_e_recusado(service):
    """Teto negativo não tem leitura possível na tela."""
    with pytest.raises(ValueError):
        await service.set_budget(-1.0)


@pytest.mark.parametrize("valor", [float("inf"), float("nan")])
async def test_teto_nao_finito_e_recusado(service, valor):
    """`inf`/`nan` atravessam `>= 0` e depois quebram a serialização JSON."""
    with pytest.raises(ValueError):
        await service.set_budget(valor)


# ----------------------------------------------------------------------
# janela do mês — virada, dia 1º, meses de tamanhos diferentes
# ----------------------------------------------------------------------

def test_janela_do_mes_no_dia_primeiro():
    """Dia 1º: 1 dia decorrido (não 0), e sobram os outros 30."""
    inicio, decorridos, do_mes = budget_mod.month_window(
        datetime(2026, 8, 1, 0, 0, tzinfo=timezone.utc)
    )
    assert inicio == "2026-08-01T00:00:00+00:00"
    assert decorridos == 1
    assert do_mes == 31


def test_janela_do_mes_no_ultimo_dia():
    _, decorridos, do_mes = budget_mod.month_window(
        datetime(2026, 8, 31, 23, 59, tzinfo=timezone.utc)
    )
    assert decorridos == 31
    assert do_mes == 31


@pytest.mark.parametrize(
    "quando,do_mes",
    [
        (datetime(2026, 2, 10, tzinfo=timezone.utc), 28),
        (datetime(2028, 2, 10, tzinfo=timezone.utc), 29),  # bissexto
        (datetime(2026, 4, 10, tzinfo=timezone.utc), 30),
        (datetime(2026, 12, 10, tzinfo=timezone.utc), 31),
    ],
)
def test_dias_do_mes_vem_do_calendario(quando, do_mes):
    assert budget_mod.month_window(quando)[2] == do_mes


@pytest.mark.parametrize("dia", [1, 2, 15, 28, 31])
def test_decorridos_mais_restantes_fecham_o_mes(dia):
    """Invariante que dá sentido aos dois números na tela."""
    agora = datetime(2026, 8, dia, 12, 0, tzinfo=timezone.utc)
    _, decorridos, do_mes = budget_mod.month_window(agora)
    b = budget_mod.build_budget_block(100.0, 10.0, now=agora)
    assert decorridos + b["days_left"] == do_mes


def test_dia_primeiro_nao_divide_por_zero():
    """`(now - inicio_do_mes).days` seria 0 no dia 1º. A projeção conta o dia
    corrente como decorrido justamente para não estourar aqui."""
    b = budget_mod.build_budget_block(
        30.0, 2.0, now=datetime(2026, 8, 1, 0, 0, 1, tzinfo=timezone.utc)
    )
    assert b["projected_usd"] == pytest.approx(2.0 * 31)
    assert b["days_left"] == 30


def test_projecao_no_ultimo_dia_iguala_o_gasto():
    """No último dia não há mais o que extrapolar."""
    b = budget_mod.build_budget_block(
        30.0, 25.0, now=datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
    )
    assert b["projected_usd"] == pytest.approx(25.0)
    assert b["days_left"] == 0


def test_projecao_no_meio_do_mes():
    b = budget_mod.build_budget_block(
        100.0, 10.0, now=datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)
    )
    assert b["projected_usd"] == pytest.approx(10.0 / 10 * 31)
    assert b["pct_used"] == pytest.approx(10.0)


async def test_virada_de_mes_zera_o_gasto(service):
    """Uma chamada do mês passado não entra no gasto deste mês — é isso que
    diferencia teto mensal de janela de 30 dias corridos."""
    agora = datetime.now(timezone.utc)
    _seed_call(service.store, ts=agora.replace(day=1) - timedelta(days=2), cost_usd=99.0)
    await service.set_budget(30.0)
    b = (await service.summary(days=30))["budget"]
    assert b["spent_usd"] == 0.0, "gasto do mês anterior vazou para este mês"


async def test_gasto_do_mes_soma_so_o_mes_corrente(service):
    """Contraprova: o filtro exclui o mês passado sem excluir o mês corrente."""
    agora = datetime.now(timezone.utc)
    _seed_call(service.store, ts=agora.replace(day=1) - timedelta(days=2), cost_usd=99.0)
    _seed_call(service.store, ts=agora.replace(day=1, hour=0, minute=0), cost_usd=1.0)
    _seed_call(service.store, ts=agora, cost_usd=2.0)
    gasto = await asyncio.to_thread(
        lambda: budget_mod.spent_this_month(service.store._connect(), now=agora)
    )
    assert gasto == pytest.approx(3.0)


async def test_gasto_visto_do_mes_seguinte_e_zero(service):
    """O mesmo dado, lido depois da virada, some do teto — sem apagar nada."""
    agora = datetime.now(timezone.utc)
    await service.record(backend="openrouter", model="x/y", cost_usd=5.0)
    proximo = (agora.replace(day=1) + timedelta(days=40)).replace(day=1)
    gasto = await asyncio.to_thread(
        lambda: budget_mod.spent_this_month(service.store._connect(), now=proximo)
    )
    assert gasto == 0.0


# ----------------------------------------------------------------------
# build_budget_block — a fronteira NULL vs 0.0, isolada
# ----------------------------------------------------------------------

def test_bloco_nulo_quando_o_teto_e_nulo():
    assert budget_mod.build_budget_block(None, 12.0) is None


def test_bloco_existe_quando_o_teto_e_zero():
    """A mutação `if monthly_usd` mata exatamente este teste."""
    b = budget_mod.build_budget_block(0.0, 12.0)
    assert b is not None
    assert b["monthly_usd"] == 0.0
    assert b["spent_usd"] == pytest.approx(12.0)


def test_pct_used_com_teto_normal():
    b = budget_mod.build_budget_block(40.0, 10.0)
    assert b["pct_used"] == pytest.approx(25.0)
    assert b["over_budget"] is False


def test_pct_used_passa_de_cem_quando_estoura():
    """Não é clampado: a tela precisa poder dizer "162% do teto"."""
    b = budget_mod.build_budget_block(10.0, 16.2)
    assert b["pct_used"] == pytest.approx(162.0)
    assert b["over_budget"] is True


# ----------------------------------------------------------------------
# schema
# ----------------------------------------------------------------------

def test_migrate_cria_a_tabela_de_budget_e_e_idempotente():
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    schema.migrate(conn)  # idempotente — não pode levantar
    cols = {row[1] for row in conn.execute("PRAGMA table_info(telemetry_budget)")}
    assert cols == {"id", "monthly_usd"}


def test_migrate_semeia_uma_linha_com_teto_nulo():
    """A linha nasce com `NULL`: existir não é o mesmo que estar configurada."""
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    linhas = conn.execute("SELECT id, monthly_usd FROM telemetry_budget").fetchall()
    assert linhas == [(1, None)]


def test_migrate_nao_apaga_um_teto_ja_gravado():
    """`ensure_schema` roda a cada boot. Um INSERT sem OR IGNORE zeraria o teto
    do usuário em todo restart."""
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    budget_mod.write_budget(conn, 77.0)
    schema.migrate(conn)
    assert budget_mod.read_budget(conn) == 77.0


def test_tabela_de_budget_e_linha_unica():
    """`id = 1` é o único teto que existe; uma segunda linha seria um segundo
    orçamento silencioso."""
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO telemetry_budget (id, monthly_usd) VALUES (2, 5.0)")


# ----------------------------------------------------------------------
# rotas
# ----------------------------------------------------------------------

@pytest.fixture
def client(tmp_path):
    store = MemoryStore(tmp_path / "t.sqlite")
    store.register_migrator("telemetry", schema.migrate)
    asyncio.run(store.ensure_schema())
    app = FastAPI()
    app.include_router(router)
    app.state.telemetry_service = TelemetryService(store)
    return TestClient(app)


def test_get_budget_devolve_nulo_quando_nao_configurado(client):
    r = client.get("/telemetry/budget")
    assert r.status_code == 200
    assert r.json() == {"monthly_usd": None}


def test_put_budget_grava_e_devolve_o_valor(client):
    r = client.put("/telemetry/budget", json={"monthly_usd": 25.0})
    assert r.status_code == 200
    assert r.json() == {"monthly_usd": 25.0}
    assert client.get("/telemetry/budget").json() == {"monthly_usd": 25.0}


def test_put_budget_zero_atravessa_a_rota(client):
    """Zero precisa sobreviver à serialização também, não só ao banco."""
    assert client.put("/telemetry/budget", json={"monthly_usd": 0.0}).status_code == 200
    assert client.get("/telemetry/budget").json() == {"monthly_usd": 0.0}
    b = client.get("/telemetry/summary?days=30").json()["budget"]
    assert b is not None and b["monthly_usd"] == 0.0


def test_put_budget_nulo_limpa(client):
    client.put("/telemetry/budget", json={"monthly_usd": 25.0})
    assert client.put("/telemetry/budget", json={"monthly_usd": None}).status_code == 200
    assert client.get("/telemetry/budget").json() == {"monthly_usd": None}
    assert client.get("/telemetry/summary?days=30").json()["budget"] is None


@pytest.mark.parametrize("corpo", [{"monthly_usd": -1}, {}, {"monthly_usd": "trinta"}])
def test_put_budget_recusa_corpo_invalido(client, corpo):
    """Campo ausente também é 422: `{}` não pode significar 'limpe o teto'
    por omissão — limpar é dizer `null` explicitamente."""
    assert client.put("/telemetry/budget", json=corpo).status_code == 422


@pytest.mark.parametrize("bruto", [b'{"monthly_usd": Infinity}',
                                   b'{"monthly_usd": 1e400}',
                                   b'{"monthly_usd": NaN}'])
def test_put_budget_recusa_nao_finito(client, bruto):
    """O parser JSON do Python aceita `Infinity`/`NaN`/`1e400` e entrega `inf`.
    Precisa virar 422 — e não 500, que é o que sai quando a validação declarativa
    do pydantic tenta ecoar `inf` no corpo do erro."""
    r = client.put("/telemetry/budget", content=bruto,
                   headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert client.get("/telemetry/budget").json() == {"monthly_usd": None}


def test_summary_pela_rota_traz_o_bloco_budget(client):
    b = client.get("/telemetry/summary?days=7").json()
    assert "budget" in b
    assert b["budget"] is None


def test_summary_sem_servico_tambem_traz_a_chave_budget():
    """O fallback precisa ter a mesma forma do summary real — senão a tela lê
    `undefined` em vez de `null` e o convite a definir um teto não aparece."""
    app = FastAPI()
    app.include_router(router)
    body = TestClient(app).get("/telemetry/summary?days=7").json()
    assert "budget" in body
    assert body["budget"] is None


@pytest.mark.parametrize("chamada", [
    lambda c: c.get("/telemetry/budget"),
    lambda c: c.put("/telemetry/budget", json={"monthly_usd": 10.0}),
])
def test_budget_sem_servico_falha_alto(chamada):
    """Sem serviço, `{"monthly_usd": null}` seria mentira: leria como "não
    configurado" e o PUT descartaria a gravação em silêncio."""
    app = FastAPI()
    app.include_router(router)
    assert chamada(TestClient(app)).status_code == 503
