import seraphine.attachments.content as content
import seraphine.attachments.store as store


async def test_no_attachments_returns_str():
    out = await content.build_user_content(
        "oi", images=None, attachments=None, use_native=True, vision_llm=None,
    )
    assert out == "oi"


async def test_native_pdf_makes_pdf_part(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"%PDF-1.4 hi", filename="x.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "resume", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    assert isinstance(parts, list)
    assert parts[0] == {"type": "text", "text": "resume"}
    pdfs = [p for p in parts if p.get("type") == "pdf"]
    assert len(pdfs) == 1
    assert pdfs[0]["data_url"].startswith("data:application/pdf;base64,")


async def test_native_image_makes_image_url(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"\x89PNG", filename="x.png", mime="image/png")
    parts = await content.build_user_content(
        "o que e", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    imgs = [p for p in parts if p.get("type") == "image_url"]
    assert len(imgs) == 1
    assert imgs[0]["image_url"]["url"].startswith("data:image/png;base64,")


async def test_fallback_pdf_extracts_text(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(content, "extract_pdf_text", lambda data, **k: "TEXTO_EXTRAIDO")
    meta = store.save_attachment(b"whatever", filename="x.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "oi", images=None, attachments=[{"id": meta["id"]}],
        use_native=False, vision_llm=None,
    )
    joined = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    assert "TEXTO_EXTRAIDO" in joined


async def test_fallback_image_without_vision_llm_is_placeholder(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    meta = store.save_attachment(b"\x89PNG", filename="x.png", mime="image/png")
    parts = await content.build_user_content(
        "oi", images=None, attachments=[{"id": meta["id"]}],
        use_native=False, vision_llm=None,
    )
    joined = " ".join(p.get("text", "") for p in parts if p.get("type") == "text")
    assert "vis" in joined.lower()  # "visão indisponível"


async def test_legacy_images_passthrough():
    parts = await content.build_user_content(
        "x", images=["data:image/png;base64,AAAA"], attachments=None,
        use_native=True, vision_llm=None,
    )
    imgs = [p for p in parts if p.get("type") == "image_url"]
    assert imgs[0]["image_url"]["url"] == "data:image/png;base64,AAAA"
