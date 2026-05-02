"""E.164 phone normalization tailored to Brazilian and international input, with a display masker for safe rendering."""

from __future__ import annotations

import re


class InvalidPhone(ValueError):
    pass


_E164_RE = re.compile(r"^\+\d{10,15}$")
_BRAZIL_CC = "55"


def normalize_e164(raw: str) -> str:
    if not isinstance(raw, str):
        raise InvalidPhone("phone must be a string")
    cleaned = re.sub(r"[\s\-\(\)\.]+", "", raw)
    if cleaned.startswith("+"):
        candidate = cleaned
    else:
        if not cleaned.isdigit():
            raise InvalidPhone(f"invalid characters: {raw!r}")
        candidate = "+" + cleaned

    if not candidate[1:].isdigit():
        raise InvalidPhone(f"non-digit after +: {raw!r}")

    digits = candidate[1:]
    # BR cells lost their leading 9 in the 12-digit form (55 + DDD + 8 local digits);
    # post-2012 cell local numbers begin with 6/7/8/9, so digits[4] in "6789" disambiguates them from landlines (2/3/4/5).
    if (
        digits.startswith(_BRAZIL_CC)
        and len(digits) == 12
        and digits[4] in "6789"
    ):
        candidate = f"+{digits[:4]}9{digits[4:]}"

    if not _E164_RE.match(candidate):
        raise InvalidPhone(f"not E.164: {candidate}")

    return candidate


def mask_e164(phone: str) -> str:
    if not phone or not phone.startswith("+"):
        return phone
    if len(phone) >= 14 and phone.startswith("+55"):
        cc = phone[:3]
        ddd = phone[3:5]
        last2 = phone[-2:]
        return f"{cc} {ddd} 9••••-••{last2}"
    last4 = phone[-4:]
    return f"+••••{last4}"
