"""Tests for lab animation catalog routes."""
from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from seraphine.lab.routes import router

_app = FastAPI()
_app.include_router(router)
client = TestClient(_app)


@pytest.fixture(autouse=True)
def _tmp_data(tmp_path: Path):
    with patch("seraphine.lab.routes._DATA_DIR", tmp_path), \
         patch("seraphine.lab.routes._ANIMATIONS_DIR", tmp_path / "animations"), \
         patch("seraphine.lab.routes._ANIMATIONS_FILE", tmp_path / "animations.json"):
        yield


def _upload(label="Acenar", source="mixamo", tags="acenar, ola", loop="false",
            name="wave.fbx", content=b"FBXDATA"):
    return client.post(
        "/lab/animations",
        files={"file": (name, io.BytesIO(content), "application/octet-stream")},
        data={"label": label, "source": source, "tags": tags, "loop": loop},
    )


def test_list_empty():
    assert client.get("/lab/animations").json() == []


def test_upload_then_list():
    r = _upload()
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["source"] == "mixamo"
    assert rec["tags"] == ["acenar", "ola"]
    assert rec["loop"] is False
    assert rec["id"]
    listed = client.get("/lab/animations").json()
    assert len(listed) == 1 and listed[0]["id"] == rec["id"]


def test_upload_rejects_bad_extension():
    r = _upload(name="evil.exe")
    assert r.status_code == 400


def test_upload_rejects_oversize():
    big = b"x" * (25 * 1024 * 1024 + 1)
    r = _upload(content=big)
    assert r.status_code == 400


def test_serve_file_returns_bytes():
    rec = _upload(content=b"HELLOFBX").json()
    r = client.get(f"/lab/animations/{rec['id']}/file")
    assert r.status_code == 200
    assert r.content == b"HELLOFBX"


def test_update_tags_and_source_moves_file():
    rec = _upload(source="mixamo").json()
    r = client.put(f"/lab/animations/{rec['id']}",
                   json={"tags": ["comemorar"], "source": "blender"})
    assert r.status_code == 200
    updated = r.json()
    assert updated["tags"] == ["comemorar"]
    assert updated["source"] == "blender"
    # file still served after the move
    assert client.get(f"/lab/animations/{rec['id']}/file").status_code == 200


def test_delete_removes_record_and_file():
    rec = _upload().json()
    assert client.delete(f"/lab/animations/{rec['id']}").status_code == 200
    assert client.get("/lab/animations").json() == []
    assert client.get(f"/lab/animations/{rec['id']}/file").status_code == 404


def test_update_unknown_404():
    assert client.put("/lab/animations/nope", json={"label": "x"}).status_code == 404
    assert client.delete("/lab/animations/nope").status_code == 404
