from seraphine.courses.generate import _valid_expr

V = {"t", "k"}


def test_accepts_real_expressions():
    assert _valid_expr("1 - exp(-k*t)", V)
    assert _valid_expr("sin(2*pi*t) + k^2", V)
    assert _valid_expr("pow(t, 2.1) / (k + 1)", V)
    assert _valid_expr("min(t, k) * e", V)


def test_rejects_unknown_tokens():
    assert not _valid_expr("__import__('os')", V)
    assert not _valid_expr("foo(t)", V)          # função fora da whitelist
    assert not _valid_expr("t; k", V)            # separador estranho
    assert not _valid_expr("x + 1", V)           # variável não declarada
    assert not _valid_expr("k = 2", V)
    assert not _valid_expr("", V)
    assert not _valid_expr("2 ** 3", V)          # ** não é ^ da whitelist
