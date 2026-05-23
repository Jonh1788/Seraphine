"""Unit tests for the extraction cascade.

The three extractor functions (`_pdfplumber_extract`, `_tesseract_extract`,
`_vision_extract`) are patched so these tests run on macOS without Tesseract
or poppler installed — only the cascade decision logic is exercised here.
"""

from pathlib import Path
from unittest.mock import patch

import pytest

from seraphine.cv_triage.extraction import extract_with_fallback
from seraphine.cv_triage.models import TextSource


@pytest.fixture
def pdf_path(tmp_path: Path) -> Path:
    p = tmp_path / "x.pdf"
    p.write_bytes(b"%PDF-1.4\n%fake")
    return p


GOOD_TEXT = "Joana é uma desenvolvedora backend Python com 8 anos de experiência. " * 10
# Mixed control-char garbage that `is_usable` reliably rejects (alnum ratio < 0.5).
# A pure "ÿ" * 300 string would not work: Python treats ÿ (U+00FF) as alnum, so
# the heuristic would consider it usable and skip the vision stage. See
# tests/cv_triage/test_quality.py::test_binary_garbage_fails for the same pattern.
JUNK = "ÿÿÿ\x00\x01\x02" * 200


def test_pdfplumber_only_when_text_is_good(pdf_path: Path) -> None:
    with patch("seraphine.cv_triage.extraction._pdfplumber_extract", return_value=GOOD_TEXT) as p, \
         patch("seraphine.cv_triage.extraction._tesseract_extract") as t, \
         patch("seraphine.cv_triage.extraction._vision_extract") as v:
        res = extract_with_fallback(pdf_path, vision_client=None)
        assert res.source == TextSource.PDFPLUMBER
        assert res.text == GOOD_TEXT
        p.assert_called_once()
        t.assert_not_called()
        v.assert_not_called()


def test_falls_through_to_tesseract(pdf_path: Path) -> None:
    with patch("seraphine.cv_triage.extraction._pdfplumber_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._tesseract_extract", return_value=GOOD_TEXT) as t, \
         patch("seraphine.cv_triage.extraction._vision_extract") as v:
        res = extract_with_fallback(pdf_path, vision_client=None)
        assert res.source == TextSource.TESSERACT
        t.assert_called_once()
        v.assert_not_called()


def test_falls_through_to_vision(pdf_path: Path) -> None:
    with patch("seraphine.cv_triage.extraction._pdfplumber_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._tesseract_extract", return_value=JUNK), \
         patch("seraphine.cv_triage.extraction._vision_extract", return_value=GOOD_TEXT) as v:
        res = extract_with_fallback(pdf_path, vision_client=object())
        assert res.source == TextSource.VISION
        v.assert_called_once()


def test_all_fail_returns_none_source(pdf_path: Path) -> None:
    with patch("seraphine.cv_triage.extraction._pdfplumber_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._tesseract_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._vision_extract", return_value=""):
        res = extract_with_fallback(pdf_path, vision_client=object())
        assert res.source == TextSource.NONE
        assert res.text == ""


def test_skips_vision_when_client_absent(pdf_path: Path) -> None:
    with patch("seraphine.cv_triage.extraction._pdfplumber_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._tesseract_extract", return_value=""), \
         patch("seraphine.cv_triage.extraction._vision_extract") as v:
        res = extract_with_fallback(pdf_path, vision_client=None)
        assert res.source == TextSource.NONE
        v.assert_not_called()
