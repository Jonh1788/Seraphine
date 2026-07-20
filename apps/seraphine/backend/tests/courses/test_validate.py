from seraphine.courses.generate import EX_TYPES, clamp_outline, valid_exercise


def test_valid_mcq():
    out = valid_exercise({
        "type": "mcq", "prompt": "2+2?",
        "payload": {"options": ["3", "4", "5"], "answer_idx": 1},
        "explanation": "Dois mais dois.",
    })
    assert out["type"] == "mcq"
    assert out["payload"]["answer_idx"] == 1
    assert out["explanation"] == "Dois mais dois."


def test_mcq_bad_answer_idx_rejected():
    assert valid_exercise({
        "type": "mcq", "prompt": "x?",
        "payload": {"options": ["a", "b"], "answer_idx": 9},
    }) is None


def test_valid_cloze():
    out = valid_exercise({
        "type": "cloze", "prompt": "Complete:",
        "payload": {"text": "O céu é ___.", "answers": ["azul"]},
    })
    assert out["payload"]["answers"] == ["azul"]


def test_cloze_without_blank_rejected():
    assert valid_exercise({
        "type": "cloze", "prompt": "x",
        "payload": {"text": "sem lacuna", "answers": ["a"]},
    }) is None


def test_cloze_multi_blank_rejected():
    # cloze de múltiplas lacunas não é suportado (front/correção assumem 1) →
    # descartado na validação em vez de virar um exercício impossível de acertar.
    assert valid_exercise({
        "type": "cloze", "prompt": "Complete a frase:",
        "payload": {
            "text": "Plantas são ___ ou ___. Ex: ___.",
            "answers": [["autotróficos", "produtores", "cianobactérias"]],
        },
    }) is None


def test_cloze_flattens_list_answers():
    # o LLM às vezes devolve answers como lista-de-listas; achatar em strings
    # planas (NUNCA stringificar a lista → "['azul', 'anil']").
    out = valid_exercise({
        "type": "cloze", "prompt": "Complete:",
        "payload": {"text": "O céu é ___.", "answers": [["azul", "anil"]]},
    })
    assert out["payload"]["answers"] == ["azul", "anil"]
    assert all("[" not in a for a in out["payload"]["answers"])


def test_valid_type():
    out = valid_exercise({
        "type": "type", "prompt": "Capital do Brasil?",
        "payload": {"accepted": ["Brasília"], "rubric": "aceita a cidade"},
    })
    assert out["payload"]["accepted"] == ["Brasília"]


def test_valid_match_pairs():
    out = valid_exercise({
        "type": "match", "prompt": "Case:",
        "payload": {"pairs": [["Brasil", "Brasília"], ["Chile", "Santiago"]]},
    })
    assert len(out["payload"]["pairs"]) == 2


def test_valid_match_steps():
    out = valid_exercise({
        "type": "match", "prompt": "Ordene:",
        "payload": {"steps": ["Primeiro", "Segundo", "Terceiro"]},
    })
    assert out["payload"]["steps"][0] == "Primeiro"


def test_unknown_type_rejected():
    assert valid_exercise({"type": "essay", "prompt": "x", "payload": {}}) is None


def test_missing_prompt_rejected():
    assert valid_exercise({"type": "mcq", "prompt": "", "payload": {"options": ["a", "b"], "answer_idx": 0}}) is None


def test_clamp_outline_caps_and_dedups():
    raw = [{"title": f"Lesson{i}", "objective": "o"} for i in range(20)]
    raw.append({"title": "Lesson0", "objective": "dup"})  # duplicate title
    out = clamp_outline(raw, lo=5, hi=12)
    assert len(out) == 12
    titles = [x["title"] for x in out]
    assert len(titles) == len(set(titles))


def test_ex_types_frozen():
    assert EX_TYPES == {"mcq", "cloze", "type", "match", "graph"}


def _graph_payload(**over):
    p = {
        "expr": "1 - exp(-k*t)",
        "x": {"var": "t", "min": 0, "max": 1},
        "params": [{"name": "k", "min": 1, "max": 20, "default": 5}],
        "target": {"param": "k", "value": 10, "tol": 1.5},
    }
    p.update(over)
    return p


def test_valid_graph_exercise():
    out = valid_exercise({
        "type": "graph", "prompt": "Ajuste k até a curva atingir 63% em t=0.1",
        "payload": _graph_payload(), "explanation": "k=10 dá tau=0.1",
    })
    assert out["type"] == "graph"
    assert out["payload"]["target"]["tol"] == 1.5
    assert out["payload"]["x"]["var"] == "t"


def test_graph_bad_expr_rejected():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(expr="__import__('os')"),
    }) is None


def test_graph_target_param_must_exist():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(target={"param": "zz", "value": 1, "tol": 1}),
    }) is None


def test_graph_bad_ranges_rejected():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(x={"var": "t", "min": 5, "max": 1}),
    }) is None
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(target={"param": "k", "value": 1, "tol": 0}),
    }) is None


def test_ex_types_includes_graph():
    assert "graph" in EX_TYPES
