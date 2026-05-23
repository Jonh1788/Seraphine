"""Safe zip extraction for the CV-triage upload route.

Extracts only `.pdf` files into a target directory, with guards against:
  - Path traversal (`..`, absolute paths, NUL bytes)
  - Zip bombs (cap on total uncompressed bytes)
  - Non-zip payloads

Filenames are flattened via `os.path.basename` — nested directories inside
the zip are NOT preserved. If two entries share a basename (e.g.
`folder1/cv.pdf` and `folder2/cv.pdf`), the later one silently overwrites
the earlier. The Mac client (Task 15 wizard) zips a single flat folder of
PDFs, so collisions are not expected in practice; downstream code treats
the returned list as the canonical set of files on disk.
"""

import io
import os
import zipfile
from pathlib import Path


class ZipExtractionError(ValueError):
    pass


def extract_pdfs_safely(
    zip_bytes: bytes,
    dest_dir: Path,
    *,
    max_uncompressed_bytes: int = 100 * 1024 * 1024,
) -> list[Path]:
    if not zipfile.is_zipfile(io.BytesIO(zip_bytes)):
        raise ZipExtractionError("not a zip")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_root = dest_dir.resolve()
    extracted: list[Path] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        total = sum(i.file_size for i in zf.infolist())
        if total > max_uncompressed_bytes:
            raise ZipExtractionError(
                f"zip too large uncompressed: {total} > {max_uncompressed_bytes}"
            )
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            if name.startswith(("__MACOSX/", "._")) or os.path.basename(name) == ".DS_Store":
                continue
            if not name.lower().endswith(".pdf"):
                continue
            if "\x00" in name or name.startswith("/") or ".." in Path(name).parts:
                raise ZipExtractionError(f"unsafe path: {name!r}")
            target = (dest_root / os.path.basename(name)).resolve()
            if os.path.commonpath([str(dest_root), str(target)]) != str(dest_root):
                raise ZipExtractionError(f"unsafe path: {name!r}")
            with zf.open(info) as src, open(target, "wb") as dst:
                dst.write(src.read())
            extracted.append(target)
    return extracted
