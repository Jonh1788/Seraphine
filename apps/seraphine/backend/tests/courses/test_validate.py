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
    assert EX_TYPES == {"mcq", "cloze", "type", "match"}
