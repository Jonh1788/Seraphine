import io
import zipfile
from pathlib import Path
import pytest
from seraphine.cv_triage.zip_utils import extract_pdfs_safely, ZipExtractionError

def _make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()

def test_extracts_pdfs_only(tmp_path):
    data = _make_zip({
        "a.pdf": b"%PDF-1.4",
        "b.PDF": b"%PDF-1.4",
        "notes.txt": b"hello",
        "__MACOSX/x": b"meta",
        ".DS_Store": b"meta",
    })
    out = extract_pdfs_safely(data, tmp_path)
    names = sorted(p.name for p in out)
    assert names == ["a.pdf", "b.PDF"]

def test_rejects_path_traversal(tmp_path):
    data = _make_zip({"../../etc/passwd.pdf": b"%PDF"})
    with pytest.raises(ZipExtractionError, match="unsafe path"):
        extract_pdfs_safely(data, tmp_path)

def test_rejects_absolute_path(tmp_path):
    data = _make_zip({"/etc/foo.pdf": b"%PDF"})
    with pytest.raises(ZipExtractionError, match="unsafe path"):
        extract_pdfs_safely(data, tmp_path)

def test_rejects_oversized_uncompressed(tmp_path):
    payload = b"%PDF" + b"\x00" * (101 * 1024 * 1024)
    data = _make_zip({"big.pdf": payload})
    with pytest.raises(ZipExtractionError, match="too large"):
        extract_pdfs_safely(data, tmp_path, max_uncompressed_bytes=100 * 1024 * 1024)

def test_rejects_not_a_zip(tmp_path):
    with pytest.raises(ZipExtractionError, match="not a zip"):
        extract_pdfs_safely(b"hello world", tmp_path)
