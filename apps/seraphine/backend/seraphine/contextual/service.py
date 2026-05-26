"""095 — Contextual actions service.

Maintains a built-in registry of app-to-action mappings and records usage
for frequency-based ranking.
"""

from __future__ import annotations

import re
import sqlite3
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

from seraphine.contextual.types import AppActions, ContextualAction


# -----------------------------------------------------------------------
# Built-in registry
# -----------------------------------------------------------------------

BUILTIN_REGISTRY: list[AppActions] = [
    AppActions(
        app_pattern=r"(?i)(code|cursor|xcode|android studio)",
        actions=[
            ContextualAction("run_tests", "Rodar testes", "Executa a suite de testes do projeto", "run_tests"),
            ContextualAction("git_status", "Git status", "Mostra o status do repositorio", "git_status"),
            ContextualAction("git_diff", "Git diff", "Mostra as alteracoes pendentes", "git_diff"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(safari|chrome|arc|firefox|brave)",
        actions=[
            ContextualAction("save_reading", "Salvar pagina", "Salva a pagina atual na lista de leitura", "save_reading_item"),
            ContextualAction("summarize_page", "Resumir pagina", "Busca e resume o conteudo da pagina ativa", "web_fetch_summarize"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(spotify|music|apple music)",
        actions=[
            ContextualAction("now_playing", "O que ta tocando?", "Mostra a musica atual", "now_playing"),
            ContextualAction("learn_taste", "Salvar gosto musical", "Registra preferencia musical na memoria", "learn_music_taste"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(terminal|iterm|warp|ghostty|tabby)",
        actions=[
            ContextualAction("clipboard_explain", "Explicar clipboard", "Explica o conteudo copiado do terminal", "clipboard_explain"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(zoom|google meet|facetime)",
        actions=[
            ContextualAction("meeting_prep", "Preparar reuniao", "Monta contexto para a proxima reuniao", "meeting_prep"),
            ContextualAction("create_meeting_note", "Notas da reuniao", "Cria nota com contexto da reuniao", "create_note"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(finder)",
        actions=[
            ContextualAction("list_dir", "Listar diretorio", "Lista arquivos do diretorio atual", "list_dir"),
            ContextualAction("open_path", "Abrir no terminal", "Abre o caminho selecionado", "open_path"),
        ],
    ),
    AppActions(
        app_pattern=r"(?i)(slack|discord)",
        actions=[
            ContextualAction("add_task_from_chat", "Criar tarefa", "Cria uma tarefa a partir do contexto", "add_task"),
        ],
    ),
]


class ContextualActionsService:
    """Resolves contextual actions for a given app name and tracks usage."""

    def __init__(self, store: object) -> None:
        self._store = store
        self._registry: list[AppActions] = list(BUILTIN_REGISTRY)
        # Pre-compile patterns
        self._compiled: list[tuple[re.Pattern[str], list[ContextualAction]]] = [
            (re.compile(aa.app_pattern), aa.actions) for aa in self._registry
        ]

    def get_actions_for_app(self, app_name: str) -> list[ContextualAction]:
        """Return all actions whose pattern matches *app_name*."""
        result: list[ContextualAction] = []
        for pattern, actions in self._compiled:
            if pattern.search(app_name):
                result.extend(actions)
        return result

    def record_usage(self, app_name: str, action_id: str) -> None:
        """Persist a usage event (synchronous, runs in thread on caller)."""
        with self._store._connect() as conn:  # type: ignore[attr-defined]
            conn.execute(
                "INSERT INTO contextual_action_usage (id, app_name, action_id, used_at) VALUES (?, ?, ?, ?)",
                (uuid.uuid4().hex, app_name, action_id, datetime.now(timezone.utc).isoformat()),
            )

    def get_ranked_actions(self, app_name: str) -> list[ContextualAction]:
        """Return actions for *app_name* sorted by descending usage frequency."""
        actions = self.get_actions_for_app(app_name)
        if not actions:
            return []

        with self._store._connect() as conn:  # type: ignore[attr-defined]
            rows = conn.execute(
                "SELECT action_id, COUNT(*) as cnt FROM contextual_action_usage WHERE app_name = ? GROUP BY action_id",
                (app_name,),
            ).fetchall()

        freq: Counter[str] = Counter()
        for action_id, cnt in rows:
            freq[action_id] = cnt

        # Stable sort: more-used first, ties keep original order
        return sorted(actions, key=lambda a: -freq.get(a.id, 0))

    def get_settings(self) -> dict[str, object]:
        """Return current configuration (enabled, registry summary)."""
        return {
            "enabled": True,
            "apps": [
                {
                    "pattern": aa.app_pattern,
                    "actions": [a.to_dict() for a in aa.actions],
                }
                for aa in self._registry
            ],
        }

    def update_settings(self, patch: dict[str, object]) -> dict[str, object]:
        """Apply partial settings update.  Currently a no-op stub that
        returns the current config — user-custom app mappings are a
        follow-up feature.
        """
        # Future: toggle enabled, add/remove custom app patterns
        return self.get_settings()
