/**
 * Hook de atalhos de teclado do Animation Lab. Encapsula o useEffect
 * gigante de onKey com todas as combinacoes (play/pause, insert, delete,
 * undo/redo, copy/cut/paste, select-all, save, step, close).
 */
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { KfDeg } from '../labUtils';
import { getClipboard, setClipboard } from '../labUtils';
import type { UndoStack } from '../undoStack';

export interface UseLabHotkeysParams {
  selectionRef: MutableRefObject<Set<number>>;
  keyframesRef: MutableRefObject<KfDeg[]>;
  scrubTimeRef: MutableRefObject<number>;
  durationRef: MutableRefObject<number>;
  flashRef: MutableRefObject<(msg: string) => void>;
  undoStackRef: MutableRefObject<UndoStack>;
  insertKfRef: MutableRefObject<() => void>;
  saveRef: MutableRefObject<(() => void) | null>;
  cheatOpen: boolean;
  setCheatOpen: (fn: (v: boolean) => boolean) => void;
  setSelection: (s: Set<number>) => void;
  setPrimaryIdx: (v: number | null) => void;
  setKeyframes: (kfs: KfDeg[]) => void;
  recordKfChange: (label: string, next: KfDeg[]) => void;
  onClose: () => void;
  handlePlayPause: () => void;
  stepScrub: (direction: -1 | 1, toNextKf: boolean) => void;
}

export function useLabHotkeys({
  selectionRef, keyframesRef, scrubTimeRef, durationRef, flashRef,
  undoStackRef, insertKfRef, saveRef,
  cheatOpen, setCheatOpen, setSelection, setPrimaryIdx, setKeyframes,
  recordKfChange, onClose, handlePlayPause, stepScrub,
}: UseLabHotkeysParams): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;

      const mod = e.metaKey || e.ctrlKey;

      if (e.key === 'Escape') {
        if (cheatOpen) { setCheatOpen(() => false); e.preventDefault(); return; }
        if (selectionRef.current.size > 0) {
          e.preventDefault();
          setSelection(new Set());
          setPrimaryIdx(null);
        } else {
          onClose();
        }
        return;
      }
      if (e.key === '?' && !mod) {
        e.preventDefault();
        setCheatOpen(v => !v);
        return;
      }
      if (e.key === ' ' && !mod) {
        e.preventDefault();
        handlePlayPause();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepScrub(-1, e.shiftKey);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepScrub(1, e.shiftKey);
        return;
      }
      if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        insertKfRef.current();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionRef.current.size === 0) return;
        e.preventDefault();
        const toDelete = new Set(selectionRef.current);
        const next = keyframesRef.current.filter((_, i) => !toDelete.has(i));
        recordKfChange(`Apagar ${toDelete.size} kf`, next);
        setSelection(new Set());
        setPrimaryIdx(null);
        return;
      }
      if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        const cmd = undoStackRef.current.undo();
        if (cmd) flashRef.current(`Undo: ${cmd.label}`);
        return;
      }
      if (mod && ((e.key === 'Z') || (e.key === 'z' && e.shiftKey) || (e.key === 'y' || e.key === 'Y'))) {
        e.preventDefault();
        const cmd = undoStackRef.current.redo();
        if (cmd) flashRef.current(`Redo: ${cmd.label}`);
        return;
      }
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveRef.current?.();
        return;
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const kfs = keyframesRef.current;
        const all = new Set<number>();
        for (let i = 0; i < kfs.length; i++) all.add(i);
        setSelection(all);
        setPrimaryIdx(kfs.length > 0 ? 0 : null);
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C') && !e.shiftKey) {
        e.preventDefault();
        const sel = selectionRef.current;
        const kfs = keyframesRef.current;
        if (sel.size === 0) return;
        setClipboard(Array.from(sel).map(i => ({ ...kfs[i] })));
        flashRef.current(`${sel.size} copiado(s)`);
        return;
      }
      if (mod && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        const sel = selectionRef.current;
        const kfs = keyframesRef.current;
        if (sel.size === 0) return;
        setClipboard(Array.from(sel).map(i => ({ ...kfs[i] })));
        const toDelete = new Set(sel);
        const next = kfs.filter((_, i) => !toDelete.has(i));
        recordKfChange(`Cortar ${sel.size} kf`, next);
        setSelection(new Set());
        setPrimaryIdx(null);
        flashRef.current(`${sel.size} recortado(s)`);
        return;
      }
      if (mod && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        const clipboard = getClipboard();
        if (clipboard.length === 0) return;
        const curScrub = scrubTimeRef.current;
        const curDuration = durationRef.current;
        const minTime = Math.min(...clipboard.map(k => k.time));
        const cloned = clipboard.map(k => {
          const newTime = Math.min(curDuration, Math.max(0, curScrub + (k.time - minTime)));
          return { ...k, time: Math.round(newTime * 100) / 100 };
        });
        const merged = [...keyframesRef.current, ...cloned].sort((a, b) => a.time - b.time);
        recordKfChange(`Colar ${cloned.length} kf`, merged);
        const clonedSet = new Set<KfDeg>(cloned);
        const newSel = new Set<number>();
        let newPrimary: number | null = null;
        for (let i = 0; i < merged.length; i++) {
          if (clonedSet.has(merged[i])) {
            newSel.add(i);
            if (newPrimary === null) newPrimary = i;
          }
        }
        setTimeout(() => {
          setSelection(newSel);
          setPrimaryIdx(newPrimary);
        }, 0);
        flashRef.current(`${cloned.length} colado(s)`);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stepScrub, handlePlayPause, cheatOpen, recordKfChange,
      selectionRef, keyframesRef, scrubTimeRef, durationRef, flashRef,
      undoStackRef, insertKfRef, saveRef, setCheatOpen, setSelection,
      setPrimaryIdx, setKeyframes]);
}
