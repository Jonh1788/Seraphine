"""Sentence-boundary splitter for streaming TTS.

Used by the WS layer to start synthesizing the assistant reply as soon as
the first sentence is complete, instead of waiting for the entire LLM turn
to finish. This roughly halves the time-to-first-audio for multi-sentence
replies.

The splitter is intentionally tiny and PT/EN-friendly:

- Sentence terminators: `.`, `!`, `?`, plus `…`.
- A terminator only ends a sentence if followed by whitespace OR a
  recognised quote/bracket then whitespace. Trailing terminators with no
  whitespace after are kept for the next chunk (we cannot tell mid-stream
  whether more text follows).
- Decimal numbers (`3.14`) and abbreviations like `Dr.`, `Sr.` are NOT
  treated as sentence ends thanks to a digit-or-letter look-behind/around.
"""

from __future__ import annotations

import re

_END_PUNCT = set(".!?…")
# A small abbreviation set; if a `.` is preceded by one of these (case
# sensitive on the dot's left side), skip the split. Keep the list short on
# purpose — overzealous filtering hurts more than it helps in chat.
_ABBREVS = {
    "Sr",
    "Sra",
    "Dr",
    "Dra",
    "St",
    "Mr",
    "Mrs",
    "Ms",
    "vs",
    "etc",
    "Av",
    "p",
    "pp",
    "cf",
    "fig",
    "ex",
}


def _is_decimal_dot(buf: str, i: int) -> bool:
    """`buf[i] == '.'` and surrounded by digits on both sides."""
    if i == 0 or i + 1 >= len(buf):
        return False
    return buf[i - 1].isdigit() and buf[i + 1].isdigit()


def _is_abbrev_dot(buf: str, i: int) -> bool:
    """`buf[i] == '.'` and the word immediately to the left is in _ABBREVS."""
    j = i
    while j > 0 and buf[j - 1].isalpha():
        j -= 1
    word = buf[j:i]
    return word in _ABBREVS


def split_sentences(buf: str) -> tuple[list[str], str]:
    """Pull complete sentences from the front of `buf`.

    Returns ``(sentences, remainder)`` where ``remainder`` is text that may
    still grow into a complete sentence on a future call.
    """
    sentences: list[str] = []
    start = 0
    i = 0
    n = len(buf)
    while i < n:
        c = buf[i]
        if c not in _END_PUNCT:
            i += 1
            continue
        if c == "." and (_is_decimal_dot(buf, i) or _is_abbrev_dot(buf, i)):
            i += 1
            continue
        # Absorb runs of terminators (e.g. "...", "?!").
        j = i + 1
        while j < n and buf[j] in _END_PUNCT:
            j += 1
        # Optional closing quote / bracket right after the punctuation.
        if j < n and buf[j] in '"\')]}»’”':
            j += 1
        # We need a whitespace (or end of buffer) to confirm the boundary.
        # If we are at end of buffer, we can't know whether more characters
        # are coming — leave it for the next call.
        if j >= n:
            break
        if buf[j].isspace():
            # Look at the next non-whitespace char. If it's lowercase, this
            # is almost certainly a continuation (ellipsis pause, mid-thought
            # punctuation), so DON'T split. If it's uppercase OR we hit end
            # of buffer, treat as a real sentence boundary.
            k = j
            while k < n and buf[k].isspace():
                k += 1
            if k < n and not buf[k].isupper():
                # Lowercase continuation — keep scanning for the next terminator.
                i = k
                continue
            sent = buf[start:j].strip()
            if sent:
                sentences.append(sent)
            start = k
            i = k
            if k >= n:
                break
            continue
        i += 1
    remainder = buf[start:]
    return sentences, remainder


def flush_remainder(remainder: str) -> str | None:
    """Trim the trailing tail and return it as a final sentence, or None."""
    s = remainder.strip()
    return s or None


# ------------------------------------------------------------------
# Markdown stripping for TTS
# ------------------------------------------------------------------
# The LLM often emits markdown formatting (bold/italic/code/headings/
# links/lists) that renders nicely in the chat UI but is pure noise
# when fed to a TTS model — you end up hearing "asterisk asterisk"
# or the TTS getting confused by stray punctuation. Strip it BEFORE
# pushing sentences to the speak queue. The client still receives
# the raw formatted text over the WS for the ChatView to render.

_RE_CODE_FENCE = re.compile(r"```[\s\S]*?```")
_RE_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_RE_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_RE_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_RE_BOLD_STAR = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_RE_BOLD_UNDER = re.compile(r"__(.+?)__", re.DOTALL)
_RE_ITALIC_STAR = re.compile(r"(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])")
_RE_ITALIC_UNDER = re.compile(r"(?<![_\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![_\w])")
_RE_STRIKE = re.compile(r"~~(.+?)~~", re.DOTALL)
_RE_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_RE_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_RE_BULLET = re.compile(r"^\s{0,3}[-*+]\s+", re.MULTILINE)
_RE_ORDERED = re.compile(r"^\s{0,3}\d+[.)]\s+", re.MULTILINE)
_RE_HR = re.compile(r"^\s{0,3}(?:---+|___+|\*\*\*+)\s*$", re.MULTILINE)
_RE_HTML_TAG = re.compile(r"<[^>]+>")
_RE_TABLE_PIPE = re.compile(r"\s*\|\s*")
_RE_MULTI_WS = re.compile(r"[ \t]{2,}")
_RE_MULTI_NL = re.compile(r"\n{3,}")


def strip_markdown_for_tts(text: str) -> str:
    """Return a TTS-friendly plain-text version of `text`.

    Intentionally small and regex-based — this is NOT a markdown
    parser, just a scrubber for the common constructs Gemma emits.
    Anything we miss will still be TTS'd, just with a bit of noise.
    """
    if not text:
        return text
    s = text
    # Fenced code blocks disappear entirely — reading them aloud is
    # useless and they wreck prosody.
    s = _RE_CODE_FENCE.sub(" ", s)
    # Inline code: keep the content, drop the backticks.
    s = _RE_INLINE_CODE.sub(r"\1", s)
    # Images: drop entirely (alt text isn't worth the noise).
    s = _RE_IMAGE.sub(" ", s)
    # Links: keep the label, drop the URL.
    s = _RE_LINK.sub(r"\1", s)
    # Bold / italic / strike — keep the inner text.
    s = _RE_BOLD_STAR.sub(r"\1", s)
    s = _RE_BOLD_UNDER.sub(r"\1", s)
    s = _RE_ITALIC_STAR.sub(r"\1", s)
    s = _RE_ITALIC_UNDER.sub(r"\1", s)
    s = _RE_STRIKE.sub(r"\1", s)
    # Block-level markers at line start: drop the marker, keep the
    # content.
    s = _RE_HEADING.sub("", s)
    s = _RE_BLOCKQUOTE.sub("", s)
    s = _RE_BULLET.sub("", s)
    s = _RE_ORDERED.sub("", s)
    # Horizontal rules and raw HTML tags vanish.
    s = _RE_HR.sub("", s)
    s = _RE_HTML_TAG.sub("", s)
    # Tables: replace pipe separators with a single space so each row
    # reads as "col col col" instead of "col pipe col pipe col".
    s = _RE_TABLE_PIPE.sub(" ", s)
    # Collapse whitespace noise left behind by the substitutions.
    s = _RE_MULTI_WS.sub(" ", s)
    s = _RE_MULTI_NL.sub("\n\n", s)
    return s.strip()
