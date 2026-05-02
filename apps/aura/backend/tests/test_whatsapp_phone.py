import pytest
from aura.whatsapp.phone import normalize_e164, mask_e164, InvalidPhone


def test_already_e164():
    assert normalize_e164("+5511987654321") == "+5511987654321"


def test_strips_spaces_dashes_parens():
    assert normalize_e164("+55 (11) 98765-4321") == "+5511987654321"


def test_adds_plus_when_country_code_present():
    assert normalize_e164("5511987654321") == "+5511987654321"


def test_brazilian_landline_no_9_prefix():
    # 10-digit local (DDD + 8) => preserved as-is.
    assert normalize_e164("5511 3333-4444") == "+551133334444"


def test_brazilian_cell_missing_9_prefix_gets_inserted():
    # 12 digits total = 55 + DDD + 8 (cell missing the 9). Insert 9.
    assert normalize_e164("5511 87654321") == "+5511987654321"


def test_too_short_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("12345")


def test_too_long_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("+1234567890123456")


def test_non_digits_after_strip_raises():
    with pytest.raises(InvalidPhone):
        normalize_e164("not-a-phone")


def test_mask_keeps_country_ddd_and_last_two():
    assert mask_e164("+5511987654321") == "+55 11 9••••-••21"


def test_mask_short_number_falls_back_safe():
    assert mask_e164("+155512345") == "+••••2345"
