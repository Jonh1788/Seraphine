"""Notes -- CRUD note-taking with Markdown, backlinks, tags and inline tasks."""

from seraphine.notes.models import Note, NoteRef, TaskSummary
from seraphine.notes.service import NoteService

__all__ = ["Note", "NoteRef", "NoteService", "TaskSummary"]
