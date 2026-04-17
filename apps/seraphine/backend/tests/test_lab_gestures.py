"""Tests for lab gesture persistence routes."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from seraphine.lab.routes import router, _GESTURES_FILE

# Minimal FastAPI app for testing
from fastapi import FastAPI

_app = FastAPI()
_app.include_router(router)
client = TestClient(_app)


@pytest.fixture(autouse=True)
def _clean_file(tmp_path: Path):
    fake_file = tmp_path / "gestures.json"
    with patch("seraphine.lab.routes._GESTURES_FILE", fake_file), \
         patch("seraphine.lab.routes._DATA_DIR", tmp_path):
        yield


def _wave_def() -> dict:
    return {
        "name": "testWave",
        "duration": 1.5,
        "keyframes": [
            {"bone": "rightUpperArm", "rotation": {"x": 0, "y": 0, "z": 0.35}, "time": 0},
            {"bone": "rightUpperArm", "rotation": {"x": 0, "y": 0, "z": 0}, "time": 1.5},
        ],
    }


def test_get_empty():
    resp = client.get("/lab/gestures")
    assert resp.status_code == 200
    assert resp.json() == {}


def test_post_then_get_roundtrip():
    wave = _wave_def()
    resp = client.post("/lab/gestures", json={"name": "testWave", "definition": wave})
    assert resp.status_code == 200

    resp = client.get("/lab/gestures")
    assert resp.status_code == 200
    data = resp.json()
    assert "testWave" in data
    assert data["testWave"]["duration"] == 1.5
    assert len(data["testWave"]["keyframes"]) == 2


def test_post_preserves_other_keys():
    wave = _wave_def()
    client.post("/lab/gestures", json={"name": "wave1", "definition": wave})

    nod = {
        "name": "nod1",
        "duration": 0.8,
        "keyframes": [
            {"bone": "head", "rotation": {"x": 0.17, "y": 0, "z": 0}, "time": 0},
        ],
    }
    client.post("/lab/gestures", json={"name": "nod1", "definition": nod})

    data = client.get("/lab/gestures").json()
    assert "wave1" in data
    assert "nod1" in data
    assert data["wave1"]["duration"] == 1.5
    assert data["nod1"]["duration"] == 0.8
