"""Notebook + Note dataclasses."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Notebook:
    id: str
    user_id: str
    name: str
    color: str
    created_at: str
    updated_at: str
    note_count: int = 0


@dataclass
class Note:
    id: str
    notebook_id: str
    user_id: str
    title: str | None
    content_md: str
    created_at: str
    updated_at: str
