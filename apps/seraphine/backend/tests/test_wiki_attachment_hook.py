import asyncio

import seraphine.attachments.content as content
import seraphine.attachments.store as store


async def test_build_user_content_fires_capture(tmp_path, monkeypatch):
    monkeypatch.setenv("SERAPHINE_DATA_DIR", str(tmp_path))
    seen = {}

    async def _spy(att_id, data, meta):
        seen["id"] = att_id
        return None

    monkeypatch.setattr(content, "capture_attachment", _spy)
    meta = store.save_attachment(b"%PDF-1.4 x", filename="d.pdf", mime="application/pdf")
    parts = await content.build_user_content(
        "resume", images=None, attachments=[{"id": meta["id"]}],
        use_native=True, vision_llm=None,
    )
    await asyncio.sleep(0)  # let the fire-and-forget task run
    assert seen.get("id") == meta["id"]
    # content itself is unchanged (still produces the pdf part)
    assert any(p.get("type") == "pdf" for p in parts)
