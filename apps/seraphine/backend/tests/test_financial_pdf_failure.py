"""A importação de PDF não pode reportar fracasso como sucesso.

Vem de um caso real (2026-08-03): a fatura do C6 chegou protegida por senha,
a Estratégia 1 — a ÚNICA que lê PDF escaneado, mandando o arquivo para o LLM —
morreu num `import pikepdf` que nunca esteve nas dependências, o `except` a
engoliu como warning, e as duas estratégias restantes dependem de texto que uma
fatura em imagem não tem.

O resultado foi `ok=True` com "Nenhuma transacao encontrada" — indistinguível
de um documento genuinamente vazio. A Seraphine então explicou ao usuário, com
confiança, que a fatura era uma imagem sem texto extraível. Estava certa sobre
a imagem e errada sobre a conclusão: existia um caminho para isso, e ele foi
pulado em silêncio.
"""

from __future__ import annotations

import pytest

from seraphine.tools.financial import ImportFinancialPdfTool


@pytest.fixture
def tool() -> ImportFinancialPdfTool:
    return ImportFinancialPdfTool(service=None, llm=None)


async def test_documento_vazio_de_verdade_continua_sendo_sucesso(
    tool: ImportFinancialPdfTool,
) -> None:
    """Sem transações E sem falha é um extrato vazio — não é erro."""
    result = await tool._insert_and_report([], "none", 1, "/tmp/x.pdf", failures=[])
    assert result.ok
    assert "Nenhuma transacao encontrada" in (result.output or "")


async def test_nada_encontrado_com_estrategia_quebrada_e_erro(
    tool: ImportFinancialPdfTool,
) -> None:
    """O caso do C6: uma estratégia levantou, nenhuma achou nada."""
    result = await tool._insert_and_report(
        [], "none", 0, "/tmp/x.pdf",
        failures=["pdf-nativo: No module named 'pikepdf'"],
    )
    assert not result.ok


async def test_o_erro_diz_qual_estrategia_falhou_e_por_que(
    tool: ImportFinancialPdfTool,
) -> None:
    """Sem isso o modelo inventa um diagnóstico — foi o que aconteceu."""
    result = await tool._insert_and_report(
        [], "none", 0, "/tmp/x.pdf",
        failures=["pdf-nativo: No module named 'pikepdf'"],
    )
    assert "pdf-nativo" in (result.error or "")
    assert "pikepdf" in (result.error or "")


async def test_varias_falhas_aparecem_todas(
    tool: ImportFinancialPdfTool,
) -> None:
    result = await tool._insert_and_report(
        [], "none", 0, "/tmp/x.pdf",
        failures=["pdf-nativo: boom", "texto: senha incorreta"],
    )
    assert "pdf-nativo" in (result.error or "")
    assert "texto" in (result.error or "")


async def test_transacoes_encontradas_ignoram_falha_anterior(
    tool: ImportFinancialPdfTool,
) -> None:
    """Estratégia 1 cair e a 2 salvar é o fluxo normal de fallback, não erro.

    Sem service configurado o caminho devolve o mesmo 'nenhuma transação',
    então o que se prende aqui é que a falha NÃO transforma isso em erro.
    """
    result = await tool._insert_and_report(
        [{"date": "2026-08-01", "description": "Mercado", "amount": 240.0}],
        "llm-text", 1, "/tmp/x.pdf",
        failures=["pdf-nativo: boom"],
    )
    assert result.ok


def test_pikepdf_esta_declarada_como_dependencia() -> None:
    """A raiz. O código importa pikepdf no caminho de senha, e ela nunca
    esteve no pyproject — então TODA fatura protegida pulava a única
    estratégia capaz de ler PDF em imagem."""
    from pathlib import Path

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    assert "pikepdf" in pyproject.read_text(), (
        "pikepdf não está declarada; o caminho de PDF com senha vai falhar em "
        "silêncio em qualquer ambiente novo"
    )


def test_pikepdf_importavel_no_ambiente() -> None:
    """Declarar não basta — o ambiente instalado é o que roda."""
    import importlib

    assert importlib.util.find_spec("pikepdf") is not None
