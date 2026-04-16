"""Music module — focus auto-play driven by memory taste (SDD 017-A).

Exposes ``FocusMusicService`` which reads music taste facts from the
memory store, composes a YouTube Music search query, and delegates
playback to the existing ``play_music`` tool.
"""

from seraphine.music.service import FocusMusicService

__all__ = ["FocusMusicService"]
