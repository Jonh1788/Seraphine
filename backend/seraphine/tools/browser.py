"""Browser automation tools for macOS.

Uses AppleScript to control Google Chrome + YouTube scraping to find
direct play URLs. No extra dependencies beyond httpx + bs4.
"""

from __future__ import annotations

import asyncio
import re
import ssl
from typing import Any
from urllib.parse import quote_plus

import httpx
import truststore

from seraphine.tools.base import Tool, ToolResult

_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"


class PlayMusicTool(Tool):
    name = "play_music"
    description = (
        "Search and play music on YouTube Music. Can play a specific song, "
        "artist, album, playlist, or a vague mood/vibe. Opens Chrome and "
        "auto-plays. After playing, ALWAYS call learn_music_taste to record "
        "what was played and whether the user asked for it or you suggested it.\n\n"
        "Examples:\n"
        "- Specific: 'Evidências Chitãozinho e Xororó'\n"
        "- Artist: 'músicas do Djavan'\n"
        "- Playlist/vibe: 'playlist chill lofi para estudar'\n"
        "- Mood: 'algo animado pra malhar'\n"
        "- Genre: 'bossa nova mix'\n\n"
        "For vague requests ('toque algo maneiro', 'coloca uma música'), "
        "first check the user's music taste via recall/facts, then suggest "
        "something based on their preferences before playing."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Search query. Can be a song name, artist, album, "
                    "playlist name, mood, or genre. Be descriptive for "
                    "playlists: 'playlist lofi hip hop chill' works better "
                    "than just 'lofi'."
                ),
            },
            "type": {
                "type": "string",
                "enum": ["song", "playlist", "album", "artist"],
                "description": (
                    "What to search for. 'song' finds a single track, "
                    "'playlist' finds a playlist/mix, 'album' finds an album, "
                    "'artist' opens the artist's page. Default: auto-detect."
                ),
            },
        },
        "required": ["query"],
    }
    requires_confirmation = False
    category = "other"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        query = str(args.get("query", "")).strip()
        if not query:
            return ToolResult(ok=False, error="query is required")
        search_type = str(args.get("type", "")).strip().lower()

        try:
            # Append type hint to query for better YouTube results
            type_suffix = {
                "playlist": " playlist",
                "album": " album",
                "artist": "",
            }.get(search_type, "")
            full_query = query + type_suffix

            # Try to find a direct YouTube URL
            if search_type == "playlist":
                url = await _find_ytmusic_playlist_url(full_query)
            else:
                url = await _find_ytmusic_url(full_query)

            if url:
                await _open_in_chrome(url)
                type_label = {"playlist": "playlist", "album": "álbum", "artist": "artista"}.get(search_type, "música")
                return ToolResult(
                    ok=True,
                    output=f"Tocando {type_label} '{query}' no YouTube Music.",
                    metadata={"query": query, "type": search_type, "url": url},
                )

            # Fallback: open search
            search_url = f"https://music.youtube.com/search?q={quote_plus(query)}"
            await _open_in_chrome(search_url)
            return ToolResult(
                ok=True,
                output=f"Abri a busca por '{query}' no YouTube Music. Clique no resultado pra tocar.",
                metadata={"query": query, "type": search_type, "url": search_url},
            )

        except Exception as e:
            return ToolResult(ok=False, error=f"browser automation failed: {e}")


class LearnMusicTasteTool(Tool):
    name = "learn_music_taste"
    description = (
        "Record the user's music taste. Call this EVERY TIME after playing "
        "music, and also when the user mentions liking/disliking music. "
        "This builds a profile of genres, artists, moods, and preferences "
        "so you can make better suggestions when the user says 'play something'. "
        "Also record negative preferences (what they DON'T like).\n\n"
        "Examples of when to call:\n"
        "- After playing a song the user requested → liked=true\n"
        "- User says 'gostei dessa' → liked=true, with the current song\n"
        "- User says 'troca' or 'não gostei' → liked=false\n"
        "- User mentions 'eu curto rock' → genre preference\n"
        "- User says 'toque algo maneiro' and you suggest → record suggestion"
    )
    json_schema = {
        "type": "object",
        "properties": {
            "artist": {
                "type": "string",
                "description": "Artist name, if known.",
            },
            "song": {
                "type": "string",
                "description": "Song name, if known.",
            },
            "genre": {
                "type": "string",
                "description": "Genre or style (rock, sertanejo, lofi, bossa nova, etc).",
            },
            "mood": {
                "type": "string",
                "description": "Mood or context (animado, chill, estudar, malhar, triste, etc).",
            },
            "liked": {
                "type": "boolean",
                "description": "true if the user liked/requested it, false if they disliked/skipped.",
            },
            "note": {
                "type": "string",
                "description": "Any extra context about the preference.",
            },
        },
        "required": ["liked"],
    }
    requires_confirmation = False
    category = "memory"

    def __init__(self, store: Any = None) -> None:
        self._store = store

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        liked = bool(args.get("liked", True))
        artist = str(args.get("artist", "")).strip()
        song = str(args.get("song", "")).strip()
        genre = str(args.get("genre", "")).strip()
        mood = str(args.get("mood", "")).strip()
        note = str(args.get("note", "")).strip()

        # Build a descriptive fact string
        parts: list[str] = []
        if liked:
            if song and artist:
                parts.append(f"Usuário gosta de '{song}' de {artist}")
            elif artist:
                parts.append(f"Usuário gosta do artista {artist}")
            elif song:
                parts.append(f"Usuário gosta da música '{song}'")
        else:
            if song and artist:
                parts.append(f"Usuário não gostou de '{song}' de {artist}")
            elif artist:
                parts.append(f"Usuário não curte {artist}")
            elif song:
                parts.append(f"Usuário não gostou de '{song}'")

        if genre:
            if liked:
                parts.append(f"curte {genre}")
            else:
                parts.append(f"não curte {genre}")

        if mood:
            parts.append(f"contexto: {mood}")
        if note:
            parts.append(note)

        fact_text = ". ".join(parts) if parts else f"Preferência musical: {'positiva' if liked else 'negativa'}"

        # Save as a fact in the memory store
        if self._store is not None:
            try:
                await self._store.add_fact(
                    text=fact_text,
                    source="user_taught",
                    confidence=0.9 if liked else 0.8,
                )
            except Exception:
                pass

        return ToolResult(
            ok=True,
            output=f"Registrado: {fact_text}",
            metadata={
                "artist": artist,
                "song": song,
                "genre": genre,
                "mood": mood,
                "liked": liked,
            },
        )


class OpenUrlTool(Tool):
    name = "open_url"
    description = (
        "Open a URL in Google Chrome. Use this to open websites, "
        "web apps, or any URL the user wants to visit."
    )
    json_schema = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "URL to open in Chrome.",
            },
        },
        "required": ["url"],
    }
    requires_confirmation = False
    category = "other"

    async def execute(self, args: dict[str, Any]) -> ToolResult:
        url = str(args.get("url", "")).strip()
        if not url:
            return ToolResult(ok=False, error="url is required")
        if not url.startswith(("http://", "https://")):
            url = "https://" + url

        try:
            await _open_in_chrome(url)
            return ToolResult(
                ok=True,
                output=f"Abri {url} no Chrome.",
                metadata={"url": url},
            )
        except Exception as e:
            return ToolResult(ok=False, error=f"failed to open URL: {e}")


# ---- Helpers ----


async def _open_in_chrome(url: str) -> None:
    """Open a URL in a NEW tab in Chrome, without redirecting the current tab."""
    await _run_osascript(f'''
        tell application "Google Chrome"
            activate
            if (count of windows) = 0 then
                make new window
            end if
            tell front window
                make new tab with properties {{URL:"{url}"}}
            end tell
        end tell
    ''')


async def _find_ytmusic_url(query: str) -> str | None:
    """Find the first video ID from YouTube search and return a YouTube Music watch URL."""
    search_url = f"https://www.youtube.com/results?search_query={quote_plus(query)}+music"
    ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    try:
        async with httpx.AsyncClient(
            timeout=10, follow_redirects=True, verify=ssl_ctx,
            headers={"User-Agent": _UA, "Accept-Language": "pt-BR,pt;q=0.9"},
        ) as client:
            resp = await client.get(search_url)
            resp.raise_for_status()
            video_ids = re.findall(r'"videoId":"([a-zA-Z0-9_-]{11})"', resp.text)
            if video_ids:
                return f"https://music.youtube.com/watch?v={video_ids[0]}"
    except Exception:
        pass
    return None


async def _find_ytmusic_playlist_url(query: str) -> str | None:
    """Find a playlist ID from YouTube search and return a YouTube Music playlist URL."""
    search_url = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp=EgIQAw%253D%253D"
    ssl_ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    try:
        async with httpx.AsyncClient(
            timeout=10, follow_redirects=True, verify=ssl_ctx,
            headers={"User-Agent": _UA, "Accept-Language": "pt-BR,pt;q=0.9"},
        ) as client:
            resp = await client.get(search_url)
            resp.raise_for_status()
            # Look for playlist IDs (start with PL or RD for mixes)
            playlist_ids = re.findall(r'"playlistId":"([a-zA-Z0-9_-]+)"', resp.text)
            if playlist_ids:
                return f"https://music.youtube.com/playlist?list={playlist_ids[0]}"
            # Fallback: find a video and let YouTube Music create a radio
            video_ids = re.findall(r'"videoId":"([a-zA-Z0-9_-]{11})"', resp.text)
            if video_ids:
                return f"https://music.youtube.com/watch?v={video_ids[0]}&list=RDAMVM{video_ids[0]}"
    except Exception:
        pass
    return None


async def _run_osascript(script: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "osascript", "-e", script,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"osascript failed: {err}")
    return stdout.decode("utf-8", errors="replace")
