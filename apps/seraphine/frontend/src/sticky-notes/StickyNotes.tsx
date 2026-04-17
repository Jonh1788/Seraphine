/**
 * 055 — Sticky notes overlay.
 *
 * Renders all active desktop_notes as draggable post-its on top of
 * the current window. Polls the backend every 30s so notes created
 * via tool calls (from anywhere) show up automatically.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

interface StickyNote {
  id: string;
  text: string;
  color: string;
  x: number;
  y: number;
}

const COLORS: Record<string, string> = {
  yellow: '#facc15',
  pink: '#f472b6',
  blue: '#60a5fa',
  green: '#4ade80',
};

export function StickyNotesOverlay(): JSX.Element {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const fetchNotes = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/desktop_notes`);
      if (!res.ok) return;
      const data = await res.json() as { notes: StickyNote[] };
      setNotes(data.notes || []);
    } catch { /* */ }
  }, []);

  useEffect(() => {
    void fetchNotes();
    const id = setInterval(() => void fetchNotes(), 30_000);
    return () => clearInterval(id);
  }, [fetchNotes]);

  const dismiss = useCallback(async (id: string) => {
    try {
      await fetch(`${API_BASE}/desktop_notes/${id}`, { method: 'DELETE' });
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch { /* */ }
  }, []);

  const saveMove = useCallback(async (id: string, x: number, y: number) => {
    try {
      await fetch(`${API_BASE}/desktop_notes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y }),
      });
    } catch { /* */ }
  }, []);

  useEffect(() => {
    const onMove = (ev: MouseEvent): void => {
      if (!dragRef.current) return;
      const { id, dx, dy } = dragRef.current;
      const x = ev.clientX - dx;
      const y = ev.clientY - dy;
      setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, x, y } : n)));
    };
    const onUp = (): void => {
      if (!dragRef.current) return;
      const id = dragRef.current.id;
      dragRef.current = null;
      const note = notesRef.current.find((n) => n.id === id);
      if (note) void saveMove(id, note.x, note.y);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [saveMove]);

  // Keep a ref in sync so the mouseup handler sees the latest position.
  const notesRef = useRef<StickyNote[]>([]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  if (notes.length === 0) return <></>;

  return (
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 9000 }}>
      {notes.map((n) => {
        const bg = COLORS[n.color] || COLORS.yellow;
        return (
          <div
            key={n.id}
            onMouseDown={(ev) => {
              dragRef.current = {
                id: n.id,
                dx: ev.clientX - n.x,
                dy: ev.clientY - n.y,
              };
              ev.preventDefault();
            }}
            style={{
              position: 'absolute',
              left: n.x,
              top: n.y,
              width: 220,
              minHeight: 140,
              padding: '12px 14px',
              background: bg,
              color: '#1a1a2e',
              borderRadius: 4,
              boxShadow: '0 8px 18px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2)',
              fontFamily: '"Permanent Marker", "Caveat", cursive',
              fontSize: 15,
              lineHeight: 1.4,
              cursor: 'grab',
              userSelect: 'none',
              pointerEvents: 'auto',
              transform: `rotate(${(Number(n.id.slice(-1)) % 4) - 2}deg)`,
            }}
          >
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); void dismiss(n.id); }}
              style={{
                position: 'absolute',
                top: 4,
                right: 6,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 14,
                opacity: 0.55,
              }}
            >
              ✕
            </button>
            <div style={{ whiteSpace: 'pre-wrap', paddingRight: 14 }}>{n.text}</div>
          </div>
        );
      })}
    </div>
  );
}
