from seraphine.cv_triage.quality import is_usable


def test_normal_text_passes():
    assert is_usable("João Silva — desenvolvedor backend Python com 8 anos de experiência. " * 5)


def test_empty_fails():
    assert not is_usable("")
    assert not is_usable("   \n\n\t   ")


def test_short_text_fails():
    assert not is_usable("Curriculum Vitae")  # < 200 chars


def test_binary_garbage_fails():
    assert not is_usable("ÿÿÿ\x00\x01\x02" * 200)


def test_only_symbols_fails():
    assert not is_usable("!@#$%^&*()-_=+[]{}|;:,.<>?/" * 20)


def test_exact_50_percent_alnum_ratio_fails():
    """Exact 50% alnum + 50% symbol must fail under strict-greater operator.

    See quality.py: the operator is `>` not `>=`, so a 50/50 mix (e.g. 100
    letters + 100 symbols at 200 chars) is rejected as not-enough-signal.
    """
    text = "a" * 100 + "!" * 100  # 200 chars, exactly 50% alnum
    assert not is_usable(text)


def test_exact_min_chars_boundary():
    """At exactly _MIN_CHARS (200) chars and clean ratio, must pass."""
    text = "a" * 200
    assert is_usable(text)
