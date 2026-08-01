"""`FactCreate.source` tem que ser o mesmo Literal de `store.Fact.source`.

Enquanto era `str` puro, este era o pior bug latente do backend de memória:

    POST /memory/facts {"text": "...", "source": "mobile"}   -> 201 OK

e a partir daí `GET /memory/facts` levantava para a lista INTEIRA, porque
`store.list_facts` reconstrói cada linha por `Fact`, cujo `source` é
`Literal[...]`. Todos os outros fatos sumiam junto, e a linha envenenada não
podia ser apagada por tela nenhuma — nenhuma conseguia listá-la.

`MemoryPanel.tsx` escapava por sorte: manda `source: 'explicit'` fixo.
Qualquer outro cliente derrubava a memória do usuário.
"""

import pytest
from pydantic import ValidationError

from seraphine.memory.routes import FactCreate
from seraphine.memory.store import Fact

VALIDOS = ["explicit", "reflection", "user_taught", "observation"]


def test_os_dois_modelos_aceitam_exatamente_o_mesmo_conjunto():
    """A invariante de verdade: se divergirem de novo, o bug volta.

    Não basta testar valores conhecidos — o que protege é a igualdade dos
    conjuntos, que pega alguém acrescentando uma fonte só de um lado.
    """
    entrada = FactCreate.model_fields["source"].annotation
    saida = Fact.model_fields["source"].annotation
    assert entrada == saida


@pytest.mark.parametrize("fonte", VALIDOS)
def test_fontes_canonicas_passam(fonte: str):
    assert FactCreate(text="oi", source=fonte).source == fonte


@pytest.mark.parametrize("fonte", ["mobile", "app", "", "Explicit", "explicit "])
def test_fonte_fora_da_lista_e_recusada_na_entrada(fonte: str):
    """422 na entrada custa uma requisição; 201 custava a memória toda."""
    with pytest.raises(ValidationError):
        FactCreate(text="oi", source=fonte)


def test_o_default_e_uma_fonte_valida():
    """Um default fora do Literal envenenaria todo POST que omitisse o campo."""
    assert FactCreate(text="oi").source in VALIDOS


def test_a_linha_envenenada_derrubaria_a_leitura_inteira():
    """Prova o mecanismo do dano, para o teste explicar o porquê e não só o quê.

    Se `Fact` aceitasse a fonte inválida, este teste falharia e a correção
    acima seria desnecessária — é o que amarra a gravidade ao código.
    """
    with pytest.raises(ValidationError):
        Fact(
            id="1",
            text="oi",
            source="mobile",  # type: ignore[arg-type]
            confidence=1.0,
            created_at="2026-08-01T00:00:00Z",
        )
