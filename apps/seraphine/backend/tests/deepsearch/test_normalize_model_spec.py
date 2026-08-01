"""Prefixo de provider duplicado no spec de modelo.

Bug de produção (2026-07-31): `/deepsearch/models` devolve ids JÁ prefixados
(`openrouter:<id>`), o painel de settings prefixava de novo, e ficava gravado
`openrouter:openrouter:google/gemini-2.5-flash`. O strip de um nível deixava
`openrouter:google/gemini-2.5-flash` como model id e a OpenRouter respondia
400 "is not a valid model ID" — o chat inteiro parava.
"""

import pytest

from seraphine.deepsearch.providers import normalize_model_spec


@pytest.mark.parametrize(
    "corrompido,esperado",
    [
        # Os dois valores exatos que apareceram no erro do usuário.
        (
            "openrouter:openrouter:google/gemini-2.5-flash",
            "openrouter:google/gemini-2.5-flash",
        ),
        (
            "openrouter:openrouter:anthropic/claude-sonnet-4.6",
            "openrouter:anthropic/claude-sonnet-4.6",
        ),
        # Mais de duas repetições também colapsam.
        ("openrouter:openrouter:openrouter:x/y", "openrouter:x/y"),
        ("cliproxy:cliproxy:claude-haiku-4-5-20251001", "cliproxy:claude-haiku-4-5-20251001"),
    ],
)
def test_colapsa_prefixo_repetido(corrompido: str, esperado: str) -> None:
    assert normalize_model_spec(corrompido) == esperado


@pytest.mark.parametrize(
    "spec",
    [
        "openrouter:google/gemini-2.5-flash",
        "openrouter:anthropic/claude-sonnet-4.6",
        "cliproxy:claude-haiku-4-5-20251001",
        "cliproxy",
    ],
)
def test_spec_correto_atravessa_inalterado(spec: str) -> None:
    assert normalize_model_spec(spec) == spec


def test_normalizacao_e_idempotente() -> None:
    """Aplicar duas vezes não pode diferir de aplicar uma.

    A função roda na escrita E na leitura, então um valor gravado já
    normalizado passa por ela de novo em todo turno de chat.
    """
    uma = normalize_model_spec("openrouter:openrouter:google/gemini-2.5-flash")
    assert normalize_model_spec(uma) == uma


@pytest.mark.parametrize("vazio", [None, "", "   "])
def test_vazio_cai_no_padrao(vazio: str | None) -> None:
    assert normalize_model_spec(vazio) == "cliproxy"


def test_prefixo_sem_modelo_cai_no_padrao() -> None:
    """`openrouter:` sozinho não é roteável — um model id vazio daria 400."""
    assert normalize_model_spec("openrouter:") == "cliproxy"
    assert normalize_model_spec("openrouter:openrouter:") == "cliproxy"


def test_provider_desconhecido_nao_e_tocado() -> None:
    """Não inventar normalização para o que a função não conhece."""
    assert normalize_model_spec("groq:llama-3.3-70b") == "groq:llama-3.3-70b"


def test_dois_pontos_no_id_sobrevivem() -> None:
    """Só o PREFIXO colapsa; `:` dentro do id do modelo é preservado."""
    assert normalize_model_spec("openrouter:vendor:model:v2") == "openrouter:vendor:model:v2"
