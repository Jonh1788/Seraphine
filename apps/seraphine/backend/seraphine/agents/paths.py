"""Validation of project folders agents are allowed to work in.

A project path must be an existing absolute directory (resolved, so symlinks
and ``..`` cannot smuggle the agent elsewhere) and must not be a place where
an agent could do real damage: a drive/filesystem root, the user's home
directory (or one of its ancestors, which would contain it), or system
directories (Windows dir, Program Files, and the usual POSIX system dirs).
"""

from __future__ import annotations

import os
from pathlib import Path

from seraphine.agents.errors import Invalid

_POSIX_SYSTEM_DIRS = (
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root",
    "/run", "/sbin", "/sys", "/usr", "/System", "/Library", "/Applications",
)


def _home() -> Path:
    """User's home directory (indirection so tests can monkeypatch it)."""
    return Path.home()


def _norm(p: Path | str) -> str:
    return os.path.normcase(os.path.normpath(str(p)))


def _is_same_or_inside(candidate: str, base: str) -> bool:
    return candidate == base or candidate.startswith(base.rstrip("\\/") + os.sep)


def _forbidden_roots() -> list[Path]:
    roots: list[Path] = []
    if os.name == "nt":
        for var in ("SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)",
                    "ProgramW6432"):
            val = os.environ.get(var)
            if val:
                roots.append(Path(val))
    else:
        roots.extend(Path(p) for p in _POSIX_SYSTEM_DIRS)
    return roots


def validate_project_path(raw: str) -> Path:
    """Return the resolved project directory or raise ``Invalid`` (422)."""
    text = str(raw or "").strip()
    if not text:
        raise Invalid("caminho do projeto é obrigatório", code="invalid_path")
    path = Path(text)
    if not path.is_absolute():
        raise Invalid("o caminho do projeto precisa ser absoluto", code="invalid_path")
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError) as exc:
        raise Invalid(f"caminho inválido: {exc}", code="invalid_path") from exc
    if not resolved.exists() or not resolved.is_dir():
        raise Invalid("a pasta do projeto não existe", code="invalid_path")

    norm = _norm(resolved)
    # Drive / filesystem root.
    if resolved.parent == resolved or norm == _norm(resolved.anchor):
        raise Invalid("não é permitido usar a raiz do disco como projeto", code="forbidden_path")
    # Home itself, or any ancestor of home (which would contain it).
    try:
        home = _norm(_home().resolve())
    except (OSError, RuntimeError):
        home = ""
    if home and _is_same_or_inside(home, norm):
        raise Invalid(
            "não é permitido usar a pasta pessoal (ou uma pasta que a contenha) como projeto",
            code="forbidden_path",
        )
    # System directories.
    for root in _forbidden_roots():
        try:
            root_norm = _norm(root.resolve())
        except (OSError, RuntimeError):
            root_norm = _norm(root)
        if _is_same_or_inside(norm, root_norm):
            raise Invalid("pasta de sistema não é permitida como projeto", code="forbidden_path")
    return resolved
