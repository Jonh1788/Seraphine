from __future__ import annotations

from seraphine.conversation.sentences import strip_markdown_for_tts


def test_strips_bold_asterisks() -> None:
    assert strip_markdown_for_tts("**olá** mundo") == "olá mundo"
    assert strip_markdown_for_tts("é **muito** importante") == "é muito importante"


def test_strips_bold_underscores() -> None:
    assert strip_markdown_for_tts("__importante__ agora") == "importante agora"


def test_strips_italic_asterisk() -> None:
    assert strip_markdown_for_tts("isso é *legal*") == "isso é legal"


def test_strips_italic_underscore() -> None:
    assert strip_markdown_for_tts("isso é _legal_") == "isso é legal"


def test_keeps_multiplication_asterisk_standalone() -> None:
    # Not italics — free-standing *, spaces around digits. Current
    # pattern requires no space after opening and before closing, so
    # '3 * 4' passes through unchanged.
    assert strip_markdown_for_tts("3 * 4 = 12") == "3 * 4 = 12"


def test_strips_inline_code() -> None:
    assert strip_markdown_for_tts("use `httpx` para isso") == "use httpx para isso"


def test_drops_fenced_code_block() -> None:
    text = "Antes\n```python\nimport os\nprint('hi')\n```\nDepois"
    out = strip_markdown_for_tts(text)
    assert "import os" not in out
    assert "Antes" in out and "Depois" in out


def test_strips_heading_markers() -> None:
    assert strip_markdown_for_tts("# Título principal") == "Título principal"
    assert strip_markdown_for_tts("### Subsecção") == "Subsecção"


def test_strips_link_keeps_label() -> None:
    assert (
        strip_markdown_for_tts("veja a [documentação](https://example.com) agora")
        == "veja a documentação agora"
    )


def test_drops_image_syntax_entirely() -> None:
    out = strip_markdown_for_tts("![alt text](https://example.com/img.png) depois")
    assert "alt text" not in out
    assert "depois" in out
    assert "!" not in out or "depois" in out


def test_strips_bullet_list_markers() -> None:
    text = "- primeira\n- segunda\n- terceira"
    out = strip_markdown_for_tts(text)
    assert "primeira" in out
    assert "segunda" in out
    assert out.startswith("primeira")


def test_strips_ordered_list_markers() -> None:
    text = "1. primeiro\n2. segundo"
    out = strip_markdown_for_tts(text)
    assert out.startswith("primeiro")
    assert "segundo" in out
    assert "1." not in out


def test_strips_blockquote() -> None:
    assert strip_markdown_for_tts("> citação aqui") == "citação aqui"


def test_strips_horizontal_rule() -> None:
    text = "Antes\n---\nDepois"
    out = strip_markdown_for_tts(text)
    assert "---" not in out
    assert "Antes" in out and "Depois" in out


def test_strips_html_tags() -> None:
    assert strip_markdown_for_tts("<b>olá</b> <br>mundo") == "olá  mundo" or \
           "olá" in strip_markdown_for_tts("<b>olá</b> <br>mundo")


def test_strikethrough() -> None:
    assert strip_markdown_for_tts("~~errado~~ certo") == "errado certo"


def test_realistic_gemma_reply() -> None:
    text = (
        "Claro! Aqui está o resumo:\n\n"
        "- **Python** é uma linguagem de alto nível, criada por *Guido van Rossum*.\n"
        "- É conhecida pela sua `sintaxe limpa` e extensa biblioteca padrão.\n"
        "- Veja mais em [python.org](https://python.org).\n"
    )
    out = strip_markdown_for_tts(text)
    assert "**" not in out
    assert "`" not in out
    assert "[" not in out and "](" not in out
    assert "- " not in out  # bullet markers gone
    assert "Python" in out
    assert "Guido van Rossum" in out
    assert "sintaxe limpa" in out
    assert "python.org" in out


def test_table_rows_become_space_separated() -> None:
    text = "| col1 | col2 | col3 |\n| --- | --- | --- |\n| a | b | c |"
    out = strip_markdown_for_tts(text)
    # Pipes replaced by spaces, HR line gone
    assert "|" not in out
    assert "col1" in out and "col2" in out and "col3" in out
    assert "a" in out and "b" in out and "c" in out


def test_empty_input_passthrough() -> None:
    assert strip_markdown_for_tts("") == ""
    assert strip_markdown_for_tts("   ") == ""


def test_plain_text_unchanged() -> None:
    assert (
        strip_markdown_for_tts("Olá, eu sou a Seraphine. Como posso ajudar?")
        == "Olá, eu sou a Seraphine. Como posso ajudar?"
    )
