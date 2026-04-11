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

import html
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

# --- noise scrubbers (run BEFORE the markdown ones above) ---
# UUIDs (canonical 8-4-4-4-12 form). Killed entirely.
_RE_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
# URLs: http(s)://… and bare www.… — replaced with the word "link" so the
# sentence still flows naturally instead of having a dangling preposition.
# We deliberately stop before trailing sentence punctuation so that the
# period after a URL still ends the sentence cleanly.
_RE_URL = re.compile(
    r"\b(?:https?://|www\.)[^\s<>()\[\]]*[^\s<>()\[\].,;:!?'\"]",
    re.IGNORECASE,
)
# POSIX-style file paths. Requires a leading `/` (not preceded by a
# letter, digit or another slash so we don't bite into URLs or words),
# AND at least three slashes total — that's enough to filter out
# colloquial constructs like "yes/no/maybe" while still catching real
# absolute paths such as `/Users/jonh1788/Dev/foo.py`.
_RE_FILE_PATH = re.compile(
    r"(?<![A-Za-z0-9/])/(?:[A-Za-z0-9._-]+/){2,}[A-Za-z0-9._-]*"
)
# Windows-style file paths: C:\foo\bar
_RE_WIN_PATH = re.compile(r"\b[A-Za-z]:\\(?:[A-Za-z0-9._-]+\\?)+")
# Function-call syntax. We are deliberately conservative: only match when
# the identifier contains a `_` (snake_case) or a `.` (method call), OR
# when the args clearly look like code (contain `=`, a quote or `:`).
# That way we leave Portuguese like "ela disse (talvez)" alone but still
# scrub `web_search(query="x")`, `obj.method(1, 2)`, `f(a=1)`.
_RE_FUNC_CALL = re.compile(
    r"\b(?:[A-Za-z_][A-Za-z0-9_]*\.)+[A-Za-z_][A-Za-z0-9_]*\([^)\n]*\)"
    r"|\b[A-Za-z_][A-Za-z0-9_]*_[A-Za-z0-9_]*\([^)\n]*\)"
    r"|\b[A-Za-z_][A-Za-z0-9_]*\([^)\n]*[=\"':][^)\n]*\)"
)
# Long alphanumeric ID-like tokens (>=20 chars) that mix letters and digits.
# Pure-letter words (even long Portuguese ones) are left alone.
_RE_LONG_ID = re.compile(
    r"\b(?=[A-Za-z0-9]{20,}\b)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]+\b"
)
# Bracket references like [1], [12], [ref], [Ref: 42]
_RE_BRACKET_REF = re.compile(r"\[(?:\d+|[Rr]ef[^\]]*)\]")
# Emojis + misc pictographs + dingbats. Wide ranges, not exhaustive but
# covers what Gemma actually emits.
_RE_EMOJI = re.compile(
    "["
    "\U0001f300-\U0001fAFF"  # symbols & pictographs, supplemental, emoticons
    "\U0001f000-\U0001f2FF"  # mahjong, playing cards, enclosed alphanum
    "\U00002600-\U000027BF"  # misc symbols + dingbats
    "\U0001F1E6-\U0001F1FF"  # regional indicators (flags)
    "]",
    flags=re.UNICODE,
)
# Arrows and a couple of common math glyphs that TTS reads as garbage.
_RE_ARROW = re.compile(r"[\u2190-\u21FF\u27F0-\u27FF\u2900-\u297F]")
# <think>...</think> chain-of-thought scratchpads (sometimes leak past
# the upstream filter).
_RE_THINK = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
# Stray backticks/tildes that survived the structural passes. We do NOT
# include `*` or `_` here because they show up in legit math/identifiers
# (`3 * 4`, `snake_case`) — the bold/italic rules above handle them when
# they actually delimit markdown.
_RE_LEFTOVER_NOISE = re.compile(r"[`~]+")


def strip_markdown_for_tts(text: str) -> str:
    """Return a TTS-friendly plain-text version of `text`.

    Intentionally small and regex-based — this is NOT a markdown
    parser, just a scrubber for the common constructs Gemma emits.
    Anything we miss will still be TTS'd, just with a bit of noise.
    """
    if not text:
        return text
    s = text
    # Decode HTML entities up front so &amp; etc. don't survive as noise
    # nor block downstream regexes.
    s = html.unescape(s)
    # Drop chain-of-thought scratchpads that may leak through.
    s = _RE_THINK.sub(" ", s)
    # Fenced code blocks disappear entirely — reading them aloud is
    # useless and they wreck prosody.
    s = _RE_CODE_FENCE.sub(" ", s)
    # Images: drop entirely (alt text isn't worth the noise). Done before
    # the link rule because the syntax overlaps.
    s = _RE_IMAGE.sub(" ", s)
    # Links: keep the label, drop the URL.
    s = _RE_LINK.sub(r"\1", s)
    # Bare URLs that weren't wrapped in markdown link syntax. Replaced
    # with "link" so the surrounding sentence still flows.
    s = _RE_URL.sub("link", s)
    # Inline code: drop backticks first so the func-call scrubber below
    # can see whatever was wrapped in them.
    s = _RE_INLINE_CODE.sub(r"\1", s)
    # File paths — POSIX and Windows. Done after URLs so we don't strip
    # the path component of an http URL.
    s = _RE_FILE_PATH.sub(" ", s)
    s = _RE_WIN_PATH.sub(" ", s)
    # UUIDs and long mixed-alphanum IDs.
    s = _RE_UUID.sub(" ", s)
    # Bracket references like [1] or [Ref: 42] (before LONG_ID so the
    # content of [Ref: ...] is killed as a unit).
    s = _RE_BRACKET_REF.sub(" ", s)
    s = _RE_LONG_ID.sub(" ", s)
    # Function-call / tool-call syntax like `web_search(query="x")`.
    s = _RE_FUNC_CALL.sub(" ", s)
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
    # Emojis and arrows / math glyphs.
    s = _RE_EMOJI.sub("", s)
    s = _RE_ARROW.sub(" ", s)
    # Anything that LOOKS like markdown noise but slipped past the
    # structural passes (lone backticks/asterisks/etc.).
    s = _RE_LEFTOVER_NOISE.sub("", s)
    # Collapse whitespace noise left behind by the substitutions.
    s = _RE_MULTI_WS.sub(" ", s)
    s = _RE_MULTI_NL.sub("\n\n", s)
    # Tidy up dangling spaces around punctuation produced by deletions.
    s = re.sub(r"\s+([,.;:!?])", r"\1", s)
    return s.strip()
