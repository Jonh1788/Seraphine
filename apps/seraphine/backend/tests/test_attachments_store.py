import os

import seraphine.attachments.store as store


def test_kind_for_mime():
    assert store.kind_for_mime("application/pdf") == "pdf"
    assert store.kind_for_mime("image/png") == "image"


def test_save_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"%PDF-1.4 hi", filename="a.pdf", mime="application/pdf")
    assert meta["kind"] == "pdf"
    assert meta["mime"] == "application/pdf"
    assert meta["filename"] == "a.pdf"
    assert meta["size"] == len(b"%PDF-1.4 hi")
    loaded = store.load_attachment(meta["id"])
    assert loaded is not None
    data, meta2 = loaded
    assert data == b"%PDF-1.4 hi"
    assert meta2["id"] == meta["id"]


def test_load_rejects_bad_id(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    assert store.load_attachment("../etc/passwd") is None
    assert store.load_attachment("") is None
    assert store.load_attachment("nope") is None


def test_validation_error():
    assert store.validation_error("text/plain", 10) == (415, "unsupported media type")
    assert store.validation_error("application/pdf", store.MAX_PDF_BYTES + 1) == (413, "file too large")
    assert store.validation_error("image/png", store.MAX_IMAGE_BYTES + 1) == (413, "file too large")
    assert store.validation_error("image/png", 5) is None
    assert store.validation_error("application/pdf", 5) is None


def test_cleanup_removes_old(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"x", filename="a.png", mime="image/png")
    d = store.attachments_dir()
    for p in d.glob(f"{meta['id']}*"):
        os.utime(p, (1.0, 1.0))  # epoch — way past any TTL
    removed = store.cleanup(ttl_hours=24)
    assert removed >= 1
    assert store.load_attachment(meta["id"]) is None
