"""Notes -- simple CRUD note-taking with Markdown content + tags."""

from seraphine.notes.models import Note
from seraphine.notes.service import NoteService

__all__ = ["Note", "NoteService"]
