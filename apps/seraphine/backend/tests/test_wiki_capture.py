import seraphine.wiki.capture as cap
import seraphine.wiki.files as f


def test_export_deepsearch_run(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    run = {"id": "r1", "query": "café arábica", "report": "# Resultado\nblá", "created_at": "2026-06-29T10:00:00+00:00", "status": "done"}
    ref = cap.export_deepsearch_run(run)
    assert ref and ref.startswith("research/")
    text = f.read_source(ref)
    assert "café arábica" in text and "Resultado" in text


def test_export_deepsearch_run_skips_empty_report(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    assert cap.export_deepsearch_run({"id": "r2", "query": "x", "report": "", "created_at": "2026-06-29T10:00:00+00:00", "status": "done"}) is None


async def test_capture_attachment_pdf(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(cap, "extract_pdf_text", lambda data, **k: "TEXTO DO PDF")
    meta = {"kind": "pdf", "mime": "application/pdf", "filename": "doc.pdf"}
    ref = await cap.capture_attachment("att123", b"%PDF-...", meta)
    assert ref == "attachments/att123.md"
    text = f.read_source(ref)
    assert "TEXTO DO PDF" in text and "doc.pdf" in text
    # idempotent: second call does not duplicate / re-extract
    ref2 = await cap.capture_attachment("att123", b"%PDF-...", meta)
    assert ref2 == ref


async def test_capture_attachment_image_stub(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_WIKI_DATA_DIR", str(tmp_path))
    meta = {"kind": "image", "mime": "image/png", "filename": "foto.png"}
    ref = await cap.capture_attachment("img1", b"\x89PNG", meta)
    text = f.read_source(ref)
    assert "foto.png" in text  # v1: minimal image source note
