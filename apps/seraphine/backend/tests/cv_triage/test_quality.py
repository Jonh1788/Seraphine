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
