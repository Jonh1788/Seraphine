/**
 * 031 — Voice memo modal. Triggered by Cmd+Shift+M inside the main
 * window. Records mic audio, uploads to the backend which transcribes,
 * classifies (idea/worry/task/reminder/note), and archives automatically.
 *
 * Skipping the dedicated Tauri window + global shortcut for now — this
 * modal ships 90% of the value with none of the native glue.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

interface VoiceMemoModalProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'idle' | 'recording' | 'processing' | 'done' | 'error';

interface MemoResult {
  type: string;
  title: string;
  archived_to: string;
}

export function VoiceMemoModal({ open, onClose }: VoiceMemoModalProps): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MemoResult | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    if (!open) {
      cleanup();
      setPhase('idle');
      setError(null);
      setResult(null);
      setElapsed(0);
    }
  }, [open, cleanup]);

  const startRecording = useCallback(async () => {
    setError(null);
    setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.start();
      mediaRecorderRef.current = rec;
      startedAtRef.current = performance.now();
      setPhase('recording');

      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((performance.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch (e) {
      setError(`Mic unavailable: ${String(e)}`);
      setPhase('error');
    }
  }, []);

  const stopAndSubmit = useCallback(async () => {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    setPhase('processing');
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }

    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });

    const blob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || 'audio/webm' });
    if (blob.size < 1024) {
      setError('Gravação curta demais.');
      setPhase('error');
      cleanup();
      return;
    }

    try {
      const form = new FormData();
      form.append('audio', blob, 'memo.webm');
      const res = await fetch(`${API_BASE}/voice_memos/audio`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      }
      const payload = await res.json();
      setResult(payload.memo);
      setPhase('done');
    } catch (e) {
      setError(String(e));
      setPhase('error');
    } finally {
      cleanup();
    }
  }, [cleanup]);

  // Keyboard: Space toggles record, Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        if (phase === 'recording') void stopAndSubmit();
        else onClose();
        return;
      }
      if (ev.code === 'Space' && (phase === 'idle' || phase === 'done' || phase === 'error')) {
        ev.preventDefault();
        void startRecording();
      } else if (ev.code === 'Space' && phase === 'recording') {
        ev.preventDefault();
        void stopAndSubmit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, startRecording, stopAndSubmit, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 10, 16, 0.75)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(6px)',
      }}
      onClick={() => {
        if (phase !== 'recording') onClose();
      }}
    >
      <div
        style={{
          background: '#141422',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16,
          padding: '32px 40px',
          minWidth: 420,
          textAlign: 'center',
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Voice memo</div>
        {phase === 'idle' && (
          <>
            <button
              type="button"
              onClick={() => void startRecording()}
              style={{
                background: '#8b5cf6',
                border: 'none',
                color: 'white',
                padding: '16px 32px',
                borderRadius: 999,
                fontSize: 15,
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              Gravar (espaço)
            </button>
            <div style={{ marginTop: 14, fontSize: 12, opacity: 0.55 }}>
              esc pra fechar
            </div>
          </>
        )}
        {phase === 'recording' && (
          <>
            <div
              style={{
                fontSize: 28,
                fontWeight: 700,
                color: '#ef4444',
                marginBottom: 10,
              }}
            >
              ● {elapsed}s
            </div>
            <button
              type="button"
              onClick={() => void stopAndSubmit()}
              style={{
                background: '#ef4444',
                border: 'none',
                color: 'white',
                padding: '12px 28px',
                borderRadius: 999,
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Parar e salvar (espaço)
            </button>
          </>
        )}
        {phase === 'processing' && (
          <div style={{ fontSize: 14, opacity: 0.8 }}>
            Transcrevendo e classificando…
          </div>
        )}
        {phase === 'done' && result && (
          <>
            <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>
              arquivada como <strong>{result.type}</strong>
            </div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{result.title}</div>
            <button
              type="button"
              onClick={onClose}
              style={{
                marginTop: 20,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.2)',
                color: 'white',
                padding: '8px 20px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Fechar
            </button>
          </>
        )}
        {phase === 'error' && (
          <>
            <div style={{ color: '#ef4444', fontSize: 14, marginBottom: 16 }}>
              {error}
            </div>
            <button
              type="button"
              onClick={() => {
                setPhase('idle');
                setError(null);
              }}
              style={{
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.2)',
                color: 'white',
                padding: '8px 20px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Tentar de novo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
