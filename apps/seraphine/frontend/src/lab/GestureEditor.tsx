import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';
import {
  GESTURE_LIBRARY,
  type GestureDefinition,
} from '../avatar/gestures';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DownloadIcon, UploadIcon } from '../icons/Icons';
import { API_BASE } from '../api';
import { GestureTimeline } from './GestureTimeline';
import {
  exportAllGestures,
  exportSingleGesture,
  pickAndReadGestureFile,
  importGestures,
  type ExportEnvelope,
  type ConflictStrategy,
} from './gestureExportImport';
import { ImportConflictDialog } from './ImportConflictDialog';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

const VRM_BONES = [
  'head', 'neck', 'chest', 'spine',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
];

interface Props {
  controller: VrmAvatarController | null;
}

type GestureSource = 'library' | 'disco' | null;

interface KfDeg {
  bone: string;
  x: number;
  y: number;
  z: number;
  time: number;
}

function defToDegs(def: GestureDefinition): KfDeg[] {
  return def.keyframes.map((kf) => ({
    bone: kf.bone,
    x: Math.round(kf.rotation.x * RAD2DEG),
    y: Math.round(kf.rotation.y * RAD2DEG),
    z: Math.round(kf.rotation.z * RAD2DEG),
    time: kf.time,
  }));
}

function degsToRadDef(name: string, duration: number, kfs: KfDeg[]): GestureDefinition {
  return {
    name,
    duration,
    keyframes: kfs.map((k) => ({
      bone: k.bone,
      rotation: { x: k.x * DEG2RAD, y: k.y * DEG2RAD, z: k.z * DEG2RAD },
      time: k.time,
    })),
  };
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function generateTsCode(name: string, duration: number, kfs: KfDeg[]): string {
  const constName = `GESTURE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const kfLines = kfs.map((k) => {
    const rx = k.x !== 0 ? `DEG(${k.x})` : '0';
    const ry = k.y !== 0 ? `DEG(${k.y})` : '0';
    const rz = k.z !== 0 ? `DEG(${k.z})` : '0';
    return `  { bone: "${k.bone}", rotation: { x: ${rx}, y: ${ry}, z: ${rz} }, time: ${k.time} },`;
  });
  return `export const ${constName}: GestureDefinition = {\n  name: "${name}",\n  duration: ${duration},\n  keyframes: [\n${kfLines.join('\n')}\n  ],\n};`;
}

export function GestureEditor({ controller }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [selectedName, setSelectedName] = useState<string>('wave');
  const [duration, setDuration] = useState(1.5);
  const [keyframes, setKeyframes] = useState<KfDeg[]>([]);
  const [source, setSource] = useState<GestureSource>('library');
  const [modified, setModified] = useState(false);
  const [savedGestures, setSavedGestures] = useState<Record<string, any>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>();
  const [selectedKfIndex, setSelectedKfIndex] = useState<number | null>(null);
  const [playheadTime, setPlayheadTime] = useState<number | null>(null);
  const rafRef = useRef<number>(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const pendingSwitch = useRef<string | null>(null);
  const originalRef = useRef<string>('');

  // Import/export state
  const [importBusy, setImportBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<ExportEnvelope | null>(null);
  const [conflictNames, setConflictNames] = useState<string[]>([]);

  useEffect(() => {
    if (!expanded) return;
    fetch(`${API_BASE}/lab/gestures`)
      .then((r) => r.json())
      .then((data) => setSavedGestures(data ?? {}))
      .catch(() => {});
  }, [expanded]);

  const libraryNames = useMemo(() => Object.keys(GESTURE_LIBRARY), []);
  const discoNames = useMemo(
    () => Object.keys(savedGestures).filter((n) => !GESTURE_LIBRARY[n]),
    [savedGestures],
  );

  const loadGesture = useCallback(
    (name: string) => {
      let def: GestureDefinition | null = null;
      let src: GestureSource = null;

      if (savedGestures[name]) {
        const raw = savedGestures[name];
        def = { name: raw.name, duration: raw.duration, keyframes: raw.keyframes };
        src = 'disco';
      }
      if (GESTURE_LIBRARY[name]) {
        if (!def) {
          def = deepClone(GESTURE_LIBRARY[name]);
          src = 'library';
        }
      }
      if (!def) {
        def = { name, duration: 1.0, keyframes: [] };
        src = null;
      }

      const degs = defToDegs(def);
      setSelectedName(name);
      setDuration(def.duration);
      setKeyframes(degs);
      setSource(src);
      setModified(false);
      setSelectedKfIndex(null);
      originalRef.current = JSON.stringify({ duration: def.duration, kfs: degs });
    },
    [savedGestures],
  );

  useEffect(() => {
    if (expanded) loadGesture(selectedName);
  }, [expanded]); // eslint-disable-line react-hooks/exhaustive-deps

  const markModified = useCallback(() => {
    setModified(true);
  }, []);

  const handleSelectGesture = useCallback(
    (name: string) => {
      if (modified) {
        pendingSwitch.current = name;
        setConfirmOpen(true);
        return;
      }
      loadGesture(name);
    },
    [modified, loadGesture],
  );

  const handleConfirmSwitch = useCallback(() => {
    setConfirmOpen(false);
    if (pendingSwitch.current) {
      loadGesture(pendingSwitch.current);
      pendingSwitch.current = null;
    }
  }, [loadGesture]);

  const handleCancelSwitch = useCallback(() => {
    setConfirmOpen(false);
    pendingSwitch.current = null;
  }, []);

  const handleNewGesture = useCallback(() => {
    const name = prompt('Nome da nova gesture:');
    if (!name?.trim()) return;
    const clean = name.trim();
    if (modified) {
      pendingSwitch.current = clean;
      setConfirmOpen(true);
      return;
    }
    setSelectedName(clean);
    setDuration(1.0);
    setKeyframes([]);
    setSource(null);
    setModified(false);
    setSelectedKfIndex(null);
    originalRef.current = JSON.stringify({ duration: 1.0, kfs: [] });
  }, [modified]);

  const flash = useCallback((msg: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(msg);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1500);
  }, []);

  // --- Keyframe mutations ---
  const updateKf = useCallback(
    (idx: number, patch: Partial<KfDeg>) => {
      setKeyframes((prev) => {
        const next = [...prev];
        const patched = { ...next[idx], ...patch };
        next[idx] = patched;
        next.sort((a, b) => a.time - b.time);
        const newIdx = next.indexOf(patched);
        setTimeout(() => setSelectedKfIndex(newIdx !== -1 ? newIdx : idx), 0);
        return next;
      });
      markModified();
    },
    [markModified],
  );

  const removeKf = useCallback(
    (idx: number) => {
      setKeyframes((prev) => prev.filter((_, i) => i !== idx));
      setSelectedKfIndex(null);
      markModified();
    },
    [markModified],
  );

  const addKf = useCallback(() => {
    let newKf: KfDeg;
    if (selectedKfIndex !== null && keyframes[selectedKfIndex]) {
      const sel = keyframes[selectedKfIndex];
      const t = Math.round(Math.min(sel.time + 0.1, duration) * 100) / 100;
      newKf = { bone: sel.bone, x: 0, y: 0, z: 0, time: t };
    } else {
      newKf = { bone: 'head', x: 0, y: 0, z: 0, time: +(duration / 2).toFixed(2) };
    }
    setKeyframes((prev) => {
      const next = [...prev, newKf].sort((a, b) => a.time - b.time);
      const newIdx = next.indexOf(newKf);
      setTimeout(() => setSelectedKfIndex(newIdx), 0);
      return next;
    });
    markModified();
  }, [duration, markModified, selectedKfIndex, keyframes]);

  const duplicateKf = useCallback(
    (idx: number) => {
      const src = keyframes[idx];
      if (!src) return;
      const t = Math.round(Math.min(src.time + 0.1, duration) * 100) / 100;
      const dup: KfDeg = { ...src, time: t };
      setKeyframes((prev) => {
        const next = [...prev, dup].sort((a, b) => a.time - b.time);
        const newIdx = next.indexOf(dup);
        setTimeout(() => setSelectedKfIndex(newIdx), 0);
        return next;
      });
      markModified();
    },
    [keyframes, duration, markModified],
  );

  // --- Timeline callbacks ---
  const handleTimelineTimeChange = useCallback(
    (idx: number, newTime: number) => {
      updateKf(idx, { time: newTime });
    },
    [updateKf],
  );

  // --- Actions ---
  const handlePlay = useCallback(() => {
    if (!controller) return;
    // Cancel any running playhead
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const def = degsToRadDef(selectedName, duration, keyframes);
    controller.playGestureDef?.(def);

    // Visual playhead via RAF
    let start: number | null = null;
    setPlayheadTime(0);
    const tick = (now: number) => {
      if (start === null) start = now;
      const elapsed = (now - start) / 1000;
      if (elapsed >= duration) {
        setPlayheadTime(null);
        rafRef.current = 0;
        return;
      }
      setPlayheadTime(elapsed);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [controller, selectedName, duration, keyframes]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const handleReset = useCallback(() => {
    if (!GESTURE_LIBRARY[selectedName]) return;
    const def = deepClone(GESTURE_LIBRARY[selectedName]);
    setDuration(def.duration);
    setKeyframes(defToDegs(def));
    setSource('library');
    setModified(false);
    setSelectedKfIndex(null);
    originalRef.current = JSON.stringify({ duration: def.duration, kfs: defToDegs(def) });
  }, [selectedName]);

  const handleCopyTs = useCallback(async () => {
    const code = generateTsCode(selectedName, duration, keyframes);
    try {
      await navigator.clipboard.writeText(code);
      flash('Copiado');
    } catch {
      flash('Falha ao copiar');
    }
  }, [selectedName, duration, keyframes, flash]);

  const handleSave = useCallback(async () => {
    const def = degsToRadDef(selectedName, duration, keyframes);
    try {
      const resp = await fetch(`${API_BASE}/lab/gestures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selectedName, definition: def }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setSavedGestures((prev) => ({
        ...prev,
        [selectedName]: { name: def.name, duration: def.duration, keyframes: def.keyframes },
      }));
      setSource('disco');
      setModified(false);
      originalRef.current = JSON.stringify({ duration, kfs: keyframes });
      flash('Salvo');
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedName, duration, keyframes, flash]);

  // --- Export/import handlers ---
  const handleExportCurrent = useCallback(async () => {
    // Only export gestures saved on disk
    if (!savedGestures[selectedName]) {
      flash('Salve o gesto antes de exportar');
      return;
    }
    try {
      await exportSingleGesture(selectedName);
      flash('Exportado');
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selectedName, savedGestures, flash]);

  const handleExportAll = useCallback(async () => {
    try {
      await exportAllGestures();
      flash('Todos exportados');
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [flash]);

  const handleImportPick = useCallback(async () => {
    setImportBusy(true);
    try {
      const envelope = await pickAndReadGestureFile();
      if (!envelope) {
        setImportBusy(false);
        return;
      }

      // Check for conflicts
      const existingNames = new Set([
        ...Object.keys(savedGestures),
        ...Object.keys(GESTURE_LIBRARY),
      ]);
      const conflicts = envelope.gestures
        .map((g) => (g as Record<string, unknown>).name as string)
        .filter((n) => typeof n === 'string' && existingNames.has(n));

      if (conflicts.length > 0) {
        setPendingImport(envelope);
        setConflictNames(conflicts);
        setImportBusy(false);
        return;
      }

      // No conflicts — import directly
      const result = await importGestures(envelope, 'skip');
      if (result.errors.length > 0) {
        flash(`Importado com erros: ${result.errors[0]}`);
      } else {
        flash(`${result.imported.length} gesto(s) importado(s)`);
      }
      // Refresh saved gestures
      const resp = await fetch(`${API_BASE}/lab/gestures`);
      if (resp.ok) setSavedGestures(await resp.json());
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportBusy(false);
    }
  }, [savedGestures, flash]);

  const handleConflictResolve = useCallback(async (strategy: ConflictStrategy) => {
    if (!pendingImport) return;
    setPendingImport(null);
    setConflictNames([]);
    setImportBusy(true);
    try {
      const result = await importGestures(pendingImport, strategy);
      const parts: string[] = [];
      if (result.imported.length > 0) parts.push(`${result.imported.length} importado(s)`);
      if (result.skipped.length > 0) parts.push(`${result.skipped.length} pulado(s)`);
      const renamedCount = Object.keys(result.renamed).length;
      if (renamedCount > 0) parts.push(`${renamedCount} renomeado(s)`);
      if (result.errors.length > 0) parts.push(`${result.errors.length} erro(s)`);
      flash(parts.join(', ') || 'Nenhum gesto importado');
      // Refresh saved gestures
      const resp = await fetch(`${API_BASE}/lab/gestures`);
      if (resp.ok) setSavedGestures(await resp.json());
    } catch (err) {
      flash(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportBusy(false);
    }
  }, [pendingImport, flash]);

  const handleConflictCancel = useCallback(() => {
    setPendingImport(null);
    setConflictNames([]);
  }, []);

  const sourceLabel = modified
    ? ' (modificado)'
    : source === 'disco'
      ? ' (disco)'
      : source === 'library'
        ? ' (library)'
        : '';

  const hasLibraryDefault = !!GESTURE_LIBRARY[selectedName];
  const selKf = selectedKfIndex !== null ? keyframes[selectedKfIndex] : null;

  if (!expanded) {
    return (
      <section className="avatar-lab__section">
        <h3
          className="avatar-lab__section-title gesture-editor__toggle"
          onClick={() => setExpanded(true)}
        >
          Gesture Editor
          <span className="gesture-editor__chevron">+</span>
        </h3>
      </section>
    );
  }

  return (
    <section className="avatar-lab__section gesture-editor">
      <h3
        className="avatar-lab__section-title gesture-editor__toggle"
        onClick={() => setExpanded(false)}
      >
        Gesture Editor
        <span className="gesture-editor__chevron">-</span>
      </h3>

      {/* Gesture selector */}
      <div className="gesture-editor__row">
        <label className="gesture-editor__label">Gesture:</label>
        <select
          className="gesture-editor__select"
          value={selectedName}
          onChange={(e) => handleSelectGesture(e.target.value)}
        >
          <optgroup label="Library">
            {libraryNames.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </optgroup>
          {discoNames.length > 0 && (
            <optgroup label="Salvas em disco">
              {discoNames.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </optgroup>
          )}
        </select>
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={handleNewGesture}
        >
          Nova gesture
        </button>
        <span className="gesture-editor__source">{sourceLabel}</span>
      </div>

      {/* Import/export toolbar */}
      <div className="gesture-editor__row" style={{ gap: 6 }}>
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          disabled={importBusy}
          onClick={() => void handleImportPick()}
          title="Importar gestos de arquivo"
        >
          <UploadIcon size={14} /> Importar
        </button>
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={() => void handleExportAll()}
          title="Exportar todos os gestos salvos"
        >
          <DownloadIcon size={14} /> Exportar todos
        </button>
      </div>

      {/* Duration */}
      <div className="gesture-editor__row">
        <label className="gesture-editor__label">
          Duracao: {duration.toFixed(1)}s
        </label>
        <input
          type="range"
          min="0.3"
          max="3.0"
          step="0.1"
          value={duration}
          onChange={(e) => {
            setDuration(parseFloat(e.target.value));
            markModified();
          }}
          className="avatar-lab__slider-row gesture-editor__slider"
        />
      </div>

      {/* Timeline */}
      <GestureTimeline
        duration={duration}
        keyframes={keyframes}
        selectedIndex={selectedKfIndex}
        playheadTime={playheadTime}
        onSelect={setSelectedKfIndex}
        onTimeChange={handleTimelineTimeChange}
      />

      {/* Inspector */}
      <div className="gesture-inspector">
        {selKf && selectedKfIndex !== null ? (
          <>
            <div className="gesture-inspector__header">
              <span className="gesture-inspector__title">
                {selKf.bone} @ t={selKf.time.toFixed(2)}s
              </span>
              <button
                type="button"
                className="gesture-inspector__btn gesture-inspector__btn--danger"
                onClick={() => removeKf(selectedKfIndex)}
              >
                Apagar
              </button>
              <button
                type="button"
                className="gesture-inspector__btn"
                onClick={() => duplicateKf(selectedKfIndex)}
              >
                Duplicar
              </button>
            </div>

            {/* Bone selector */}
            <div className="gesture-inspector__field">
              <label className="gesture-editor__label">Bone:</label>
              <select
                className="gesture-editor__select gesture-editor__select--bone"
                value={VRM_BONES.includes(selKf.bone) ? selKf.bone : '__custom__'}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    const custom = prompt('Nome do bone:');
                    if (custom?.trim()) updateKf(selectedKfIndex, { bone: custom.trim() });
                  } else {
                    updateKf(selectedKfIndex, { bone: e.target.value });
                  }
                }}
              >
                {VRM_BONES.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
                {!VRM_BONES.includes(selKf.bone) && (
                  <option value={selKf.bone}>{selKf.bone}</option>
                )}
                <option value="__custom__">-- custom --</option>
              </select>
            </div>

            {/* Time */}
            <div className="gesture-inspector__field">
              <label className="gesture-editor__label">t:</label>
              <input
                type="range"
                min="0"
                max={duration}
                step="0.01"
                value={selKf.time}
                onChange={(e) => updateKf(selectedKfIndex, { time: parseFloat(e.target.value) || 0 })}
                className="gesture-editor__slider"
              />
              <input
                type="number"
                min="0"
                max={duration}
                step="0.05"
                value={selKf.time}
                onChange={(e) => updateKf(selectedKfIndex, { time: parseFloat(e.target.value) || 0 })}
                className="gesture-editor__num gesture-editor__num--time"
              />
              <span className="gesture-editor__deg-sign">s</span>
            </div>

            {/* X / Y / Z */}
            {(['x', 'y', 'z'] as const).map((axis) => (
              <div key={axis} className="gesture-editor__axis-row">
                <span className="gesture-editor__axis-label">{axis.toUpperCase()}:</span>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="1"
                  value={selKf[axis]}
                  onChange={(e) => updateKf(selectedKfIndex, { [axis]: parseInt(e.target.value, 10) })}
                  className="gesture-editor__axis-slider"
                />
                <input
                  type="number"
                  min="-180"
                  max="180"
                  step="1"
                  value={selKf[axis]}
                  onChange={(e) => updateKf(selectedKfIndex, { [axis]: parseInt(e.target.value, 10) || 0 })}
                  className="gesture-editor__num"
                />
                <span className="gesture-editor__deg-sign">deg</span>
              </div>
            ))}
          </>
        ) : (
          <p className="gesture-inspector__empty">
            Selecione um keyframe na timeline ou adicione um novo
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="gesture-editor__actions">
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={addKf}
        >
          + Adicionar keyframe
        </button>
        <button
          type="button"
          className="avatar-lab__gesture-btn gesture-editor__play"
          onClick={handlePlay}
        >
          Play
        </button>
        {hasLibraryDefault && (
          <button
            type="button"
            className="avatar-lab__gesture-btn"
            onClick={handleReset}
          >
            Resetar pro default
          </button>
        )}
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={() => void handleCopyTs()}
        >
          Copiar TS
        </button>
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={() => void handleSave()}
        >
          Salvar em disco
        </button>
        <button
          type="button"
          className="avatar-lab__gesture-btn"
          onClick={() => void handleExportCurrent()}
          title="Exportar este gesto como arquivo"
        >
          <DownloadIcon size={14} /> Exportar
        </button>
      </div>

      {feedback && (
        <div className="gesture-editor__feedback">{feedback}</div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Alteracoes nao salvas"
        message="Voce tem alteracoes nao salvas nessa gesture. Deseja descartar?"
        confirmLabel="Descartar"
        cancelLabel="Voltar"
        variant="danger"
        onConfirm={handleConfirmSwitch}
        onCancel={handleCancelSwitch}
      />

      <ImportConflictDialog
        open={conflictNames.length > 0}
        conflictNames={conflictNames}
        totalCount={pendingImport?.gestures.length ?? 0}
        onResolve={(s) => void handleConflictResolve(s)}
        onCancel={handleConflictCancel}
      />
    </section>
  );
}
