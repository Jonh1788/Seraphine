from __future__ import annotations

from seraphine.conversation.sentences import flush_remainder, split_sentences


def test_single_complete_sentence_with_trailing_space() -> None:
    sents, rem = split_sentences("Olá mundo. ")
    assert sents == ["Olá mundo."]
    assert rem == ""


def test_two_sentences() -> None:
    sents, rem = split_sentences("Olá. Como vai? ")
    assert sents == ["Olá.", "Como vai?"]
    assert rem == ""


def test_incomplete_trailing_sentence_kept_as_remainder() -> None:
    sents, rem = split_sentences("Olá mundo. Eu sou a Sera")
    assert sents == ["Olá mundo."]
    assert rem == "Eu sou a Sera"


def test_decimal_number_does_not_split() -> None:
    sents, rem = split_sentences("Pi vale 3.14 aproximadamente. ")
    assert sents == ["Pi vale 3.14 aproximadamente."]
    assert rem == ""


def test_abbrev_does_not_split() -> None:
    sents, rem = split_sentences("Dr. Strange ligou. Tudo bem? ")
    assert sents == ["Dr. Strange ligou.", "Tudo bem?"]
    assert rem == ""


def test_ellipsis_treated_as_single_terminator() -> None:
    sents, rem = split_sentences("Hmm... acho que sim. ")
    assert sents == ["Hmm... acho que sim."]
    assert rem == ""


def test_run_of_punctuation_collapses() -> None:
    sents, rem = split_sentences("Sério?! Eu não acredito. ")
    assert sents == ["Sério?!", "Eu não acredito."]
    assert rem == ""


def test_quoted_sentence() -> None:
    sents, rem = split_sentences('Ele disse "olá". Depois saiu. ')
    assert sents == ['Ele disse "olá".', "Depois saiu."]
    assert rem == ""


def test_terminator_at_end_without_whitespace_is_kept_for_next_chunk() -> None:
    # We cannot tell mid-stream if more text follows, so the chunk stays.
    sents, rem = split_sentences("Olá mundo.")
    assert sents == []
    assert rem == "Olá mundo."


def test_progressive_streaming_simulation() -> None:
    """Feed the splitter incrementally as if tokens are streaming in."""
    pieces = ["Olá", " mundo", ".", " Como", " vai", "?", " Tudo", " bem", "."]
    buf = ""
    out: list[str] = []
    for p in pieces:
        buf += p
        sents, buf = split_sentences(buf)
        out.extend(sents)
    # Final flush after the stream ends:
    tail = flush_remainder(buf)
    if tail:
        out.append(tail)
    assert out == ["Olá mundo.", "Como vai?", "Tudo bem."]


def test_flush_remainder_strips_and_filters_empty() -> None:
    assert flush_remainder("   ") is None
    assert flush_remainder("oi") == "oi"
    assert flush_remainder("  oi  ") == "oi"
