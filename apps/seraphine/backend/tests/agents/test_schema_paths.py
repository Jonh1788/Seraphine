"""Schema idempotency and project-path validation."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from seraphine.agents import paths as agent_paths
from seraphine.agents import schema
from seraphine.agents.errors import Invalid
from seraphine.agents.paths import validate_project_path

TABLES = {
    "agent_projects", "agent_defs", "agent_project_access", "agent_tasks",
    "agent_runs", "agent_run_events", "agent_messages", "agent_approvals",
}


def test_migrate_is_idempotent():
    conn = sqlite3.connect(":memory:")
    schema.migrate(conn)
    schema.migrate(conn)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert TABLES <= names
    # the per-project task number is unique
    conn.execute("INSERT INTO agent_tasks (id, project_id, number, title, created_at, updated_at)"
                 " VALUES ('t1', 'p', 1, 'x', 'n', 'n')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO agent_tasks (id, project_id, number, title, created_at, updated_at)"
                     " VALUES ('t2', 'p', 1, 'y', 'n', 'n')")


def test_tmp_dir_is_accepted(tmp_path: Path):
    assert validate_project_path(str(tmp_path)) == tmp_path.resolve()


def test_nonexistent_rejected(tmp_path: Path):
    with pytest.raises(Invalid):
        validate_project_path(str(tmp_path / "nope"))


def test_file_rejected(tmp_path: Path):
    f = tmp_path / "a.txt"
    f.write_text("x")
    with pytest.raises(Invalid):
        validate_project_path(str(f))


def test_relative_and_empty_rejected():
    with pytest.raises(Invalid):
        validate_project_path("some/relative")
    with pytest.raises(Invalid):
        validate_project_path("   ")


def test_drive_root_rejected(tmp_path: Path):
    with pytest.raises(Invalid) as exc:
        validate_project_path(tmp_path.resolve().anchor)
    assert exc.value.code == "forbidden_path"


def test_home_rejected_and_ancestor_rejected(tmp_path: Path, monkeypatch):
    home = tmp_path / "fakehome"
    inner = home / "proj"
    inner.mkdir(parents=True)
    monkeypatch.setattr(agent_paths, "_home", lambda: home)
    with pytest.raises(Invalid):
        validate_project_path(str(home))
    # a folder that CONTAINS home would expose it too
    with pytest.raises(Invalid):
        validate_project_path(str(tmp_path))
    # a subfolder of home is fine
    assert validate_project_path(str(inner)) == inner.resolve()


def test_system_dirs_rejected(tmp_path: Path, monkeypatch):
    system = tmp_path / "Windows"
    (system / "System32").mkdir(parents=True)
    monkeypatch.setattr(agent_paths, "_forbidden_roots", lambda: [system])
    monkeypatch.setattr(agent_paths, "_home", lambda: tmp_path / "elsewhere-home")
    with pytest.raises(Invalid):
        validate_project_path(str(system))
    with pytest.raises(Invalid):
        validate_project_path(str(system / "System32"))
