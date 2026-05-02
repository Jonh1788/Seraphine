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
    # Image syntax `![...](...)` is dropped entirely — no leading `!`
    # should remain. Previous version was a no-op tautology.
    assert "!" not in out


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
    # HTML tags are stripped: content survives, no angle brackets remain.
    # Previous version short-circuited via `or` and never validated the
    # tag-removal invariant.
    out = strip_markdown_for_tts("<b>olá</b> <br>mundo")
    assert "<" not in out and ">" not in out
    assert "olá" in out
    assert "mundo" in out


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


# ----------------------------------------------------------------------
# noise scrubbers — UUIDs, IDs, URLs, paths, function calls, emojis, etc.
# ----------------------------------------------------------------------


def test_strips_uuid() -> None:
    out = strip_markdown_for_tts(
        "O id é 550e8400-e29b-41d4-a716-446655440000 e pronto."
    )
    assert "550e8400" not in out
    assert "446655440000" not in out
    assert "O id é" in out and "e pronto." in out


def test_strips_long_alphanumeric_id() -> None:
    out = strip_markdown_for_tts("ref: cmnt495w90003ay5qenfiksr4 acabou")
    assert "cmnt495w90003ay5qenfiksr4" not in out
    assert "acabou" in out


def test_does_not_strip_long_pure_letter_word() -> None:
    # Long Portuguese word, no digits — must be preserved.
    out = strip_markdown_for_tts("é inconstitucionalissimamentemuito grande")
    assert "inconstitucionalissimamentemuito" in out


def test_strips_https_url_replaces_with_link() -> None:
    out = strip_markdown_for_tts("veja em https://example.com/page agora")
    assert "https" not in out
    assert "example.com" not in out
    assert "link" in out
    assert "agora" in out


def test_url_at_end_of_sentence_keeps_period() -> None:
    out = strip_markdown_for_tts("Encontrei aqui: https://example.com/news/12345.")
    assert "https" not in out
    assert "12345" not in out
    assert out.rstrip().endswith(".")


def test_strips_www_url() -> None:
    out = strip_markdown_for_tts("acesse www.exemplo.com.br para ver")
    assert "www" not in out
    assert "link" in out


def test_strips_unix_file_path() -> None:
    out = strip_markdown_for_tts(
        "salvei em /Users/jonh1788/Dev/foo.py sem problema"
    )
    assert "/Users/jonh1788" not in out
    assert "foo.py" not in out
    assert "sem problema" in out


def test_does_not_strip_simple_slash_phrase() -> None:
    # "yes/no/maybe" has only two slashes inside, no leading slash — must
    # not be touched by the file-path scrubber.
    out = strip_markdown_for_tts("a resposta é yes/no/maybe")
    assert "yes/no/maybe" in out


def test_strips_windows_path() -> None:
    out = strip_markdown_for_tts(r"abre C:\Users\Foo\bar.txt aqui")
    assert "C:" not in out
    assert "bar.txt" not in out


def test_strips_function_call_with_kwargs() -> None:
    out = strip_markdown_for_tts('chamando web_search(query="x") agora')
    assert "web_search" not in out
    assert "query" not in out
    assert "agora" in out


def test_strips_method_call() -> None:
    out = strip_markdown_for_tts("execute obj.method(1, 2) já")
    assert "obj.method" not in out
    assert "(1, 2)" not in out
    assert "execute" in out and "já" in out


def test_keeps_natural_parenthetical() -> None:
    # Plain Portuguese parentheticals must NOT be eaten by the func-call
    # scrubber — they have a space before `(` and no kwarg-like syntax
    # inside.
    out = strip_markdown_for_tts("ela disse (talvez) que sim")
    assert "talvez" in out
    out2 = strip_markdown_for_tts("Python (linguagem) é legal")
    assert "linguagem" in out2


def test_strips_bracket_reference() -> None:
    out = strip_markdown_for_tts("isso é importante [1] mesmo")
    assert "[1]" not in out
    assert "importante" in out and "mesmo" in out


def test_strips_ref_bracket_with_id() -> None:
    out = strip_markdown_for_tts("vide [Ref: abc123def456789012] no final")
    assert "Ref" not in out
    assert "abc123def456789012" not in out
    assert "no final" in out


def test_strips_emoji() -> None:
    out = strip_markdown_for_tts("Olá 👋 mundo 🌍 lindo ✨")
    assert "👋" not in out
    assert "🌍" not in out
    assert "✨" not in out
    assert "Olá" in out and "mundo" in out and "lindo" in out


def test_strips_arrows() -> None:
    out = strip_markdown_for_tts("antes → depois ⇒ sempre")
    assert "→" not in out
    assert "⇒" not in out
    assert "antes" in out and "depois" in out and "sempre" in out


def test_strips_think_block() -> None:
    out = strip_markdown_for_tts(
        "Resposta final: <think>raciocínio interno</think> tudo certo"
    )
    assert "raciocínio interno" not in out
    assert "Resposta final" in out
    assert "tudo certo" in out


def test_unescapes_html_entities() -> None:
    out = strip_markdown_for_tts("café &amp; pão &lt;3")
    assert "&amp;" not in out
    assert "&lt;" not in out
    assert "&" in out  # actual ampersand
    assert "café" in out and "pão" in out


def test_realistic_messy_assistant_reply() -> None:
    text = (
        "Ok! Busquei sobre o clima e encontrei essa informação: "
        "https://example.com/news/12345. A temperatura é de 25°C. "
        "Veja mais em `weather_api.get_forecast(city='SP')` → "
        "temperatura: 25. [Ref: abc123def456789012]"
    )
    out = strip_markdown_for_tts(text)
    assert "http" not in out
    assert "example.com" not in out
    assert "weather_api" not in out
    assert "get_forecast" not in out
    assert "city=" not in out
    assert "→" not in out
    assert "[Ref" not in out
    assert "abc123def456789012" not in out
    assert "`" not in out
    # Sanity: the actual content survives.
    assert "Busquei sobre o clima" in out
    assert "temperatura" in out
    assert "25" in out


def test_does_not_split_sentences_after_scrub() -> None:
    # The scrubber must leave sentence terminators intact so the
    # downstream sentence splitter still works.
    out = strip_markdown_for_tts(
        "Veja https://example.com/x. Depois www.foo.com/y? Tudo bem!"
    )
    assert out.count(".") >= 1
    assert "?" in out
    assert "!" in out
