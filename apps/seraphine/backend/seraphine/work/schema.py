"""Schema migrator for work projects."""

from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS work_projects (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          area        TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL DEFAULT 'active',
          priority    TEXT NOT NULL DEFAULT 'medium',
          tags        TEXT NOT NULL DEFAULT '[]',
          links       TEXT NOT NULL DEFAULT '[]',
          due_date    TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS work_project_links (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id   TEXT NOT NULL,
          title       TEXT NOT NULL DEFAULT '',
          metadata    TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL,
          FOREIGN KEY(project_id) REFERENCES work_projects(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_work_projects_status_updated
          ON work_projects(status, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_work_projects_due_date
          ON work_projects(due_date);
        CREATE INDEX IF NOT EXISTS idx_work_project_links_project
          ON work_project_links(project_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_project_links_unique_target
          ON work_project_links(project_id, target_type, target_id);
        """
    )
