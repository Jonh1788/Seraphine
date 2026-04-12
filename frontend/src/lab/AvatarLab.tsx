import { useCallback, useEffect, useRef, useState } from 'react';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';

/** Predefined emotion presets with Portuguese labels. */
const PRESETS: { label: string; icon: string; emotion: string }[] = [
  { label: 'Feliz', icon: '\uD83D\uDE0A', emotion: 'happy' },
  { label: 'Triste', icon: '\uD83D\uDE22', emotion: 'sad' },
  { label: 'Surpresa', icon: '\uD83D\uDE2E', emotion: 'surprised' },
  { label: 'Pensando', icon: '\uD83E\uDD14', emotion: 'thinking' },
  { label: 'Sarcastica', icon: '\uD83D\uDE0F', emotion: 'sarcastic' },
  { label: 'Calorosa', icon: '\uD83E\uDD17', emotion: 'warm' },
  { label: 'Curiosa', icon: '\uD83E\uDDD0', emotion: 'curious' },
  { label: 'Animada', icon: '\uD83E\uDD29', emotion: 'excited' },
  { label: 'Suave', icon: '\uD83D\uDE0C', emotion: 'soft' },
  { label: 'Rindo', icon: '\uD83D\uDE02', emotion: 'laughing' },
];

/** Gesture definitions with Portuguese labels. */
const GESTURES: { label: string; icon: string; name: string }[] = [
  { label: 'Acenar', icon: '\uD83D\uDC4B', name: 'wave' },
  { label: 'Acenar sim', icon: '\uD83D\uDE42', name: 'nod' },
  { label: 'Negar', icon: '\uD83D\uDE45', name: 'shakeHead' },
  { label: 'Inclinar', icon: '\uD83D\uDE0C', name: 'tiltHead' },
  { label: 'Reverencia', icon: '\uD83D\uDE47', name: 'bow' },
];

/** Default expressions list if controller doesn't provide one yet. */
const FALLBACK_EXPRESSIONS = [
  'happy', 'sad', 'angry', 'surprised', 'relaxed', 'excited',
  'sarcastic', 'curious', 'thinking', 'warm', 'soft', 'laughing', 'neutral',
];

/** Parse [tag] patterns from text. */
const TAG_RE = /\[([a-zA-Z]+)\]/g;

/** Known VRM avatars in /public/avatars/. */
const AVATARS: { label: string; url: string }[] = [
  { label: 'Seraphine (original)', url: '/avatars/seraphine.vrm' },
  // Add more .vrm files here as they become available:
  // { label: 'Seraphine v2', url: '/avatars/seraphine-v2.vrm' },
];

/** Camera presets with Portuguese labels. */
const CAMERAS: { label: string; icon: string; preset: string }[] = [
  { label: 'Rosto', icon: '\uD83D\uDC64', preset: 'face' },
  { label: 'Busto', icon: '\uD83D\uDC67', preset: 'bust' },
  { label: 'Corpo inteiro', icon: '\uD83E\uDDCD', preset: 'fullBody' },
];

interface AvatarLabProps {
  controller: VrmAvatarController | null;
  onClose: () => void;
}

export function AvatarLab({ controller, onClose }: AvatarLabProps): JSX.Element {
  const [sliders, setSliders] = useState<Record<string, number>>({});
  const [playingGesture, setPlayingGesture] = useState<string | null>(null);
  const [quickText, setQuickText] = useState('');
  const [quickRunning, setQuickRunning] = useState(false);
  const quickAbortRef = useRef(false);
  const [currentAvatar, setCurrentAvatar] = useState(AVATARS[0]?.url ?? '');
  const [swappingAvatar, setSwappingAvatar] = useState(false);
  const [activeCamera, setActiveCamera] = useState('bust');

  // Resolve available RAW blendshapes from the VRM model (not emotion presets)
  const blendshapes = getBlendshapes(controller);

  // Initialize sliders to 0 for each blendshape
  useEffect(() => {
    const initial: Record<string, number> = {};
    for (const bs of blendshapes) {
      initial[bs] = 0;
    }
    setSliders(initial);
  }, [blendshapes.join(',')]);

  const handleSliderChange = useCallback(
    (name: string, value: number) => {
      setSliders((prev) => ({ ...prev, [name]: value }));
      try {
        // Use the raw blendshape setter — bypasses emotion map, sets exact weight
        controller?.setRawBlendshape?.(name, value);
      } catch {
        // Controller method may not exist yet
      }
    },
    [controller],
  );

  const handlePreset = useCallback(
    (emotion: string) => {
      try {
        controller?.setExpression?.(emotion);
      } catch {
        // ignore
      }
    },
    [controller],
  );

  const handleGesture = useCallback(
    async (name: string) => {
      if (playingGesture) return;
      setPlayingGesture(name);
      try {
        await controller?.playGesture?.(name);
      } catch {
        // gesture may not exist yet
      } finally {
        setPlayingGesture(null);
      }
    },
    [controller, playingGesture],
  );

  const handleReset = useCallback(() => {
    setSliders((prev) => {
      const zeroed: Record<string, number> = {};
      for (const key of Object.keys(prev)) zeroed[key] = 0;
      return zeroed;
    });
    try {
      controller?.resetToIdle?.();
    } catch {
      // ignore
    }
  }, [controller]);

  const handleCameraPreset = useCallback(
    (preset: string) => {
      setActiveCamera(preset);
      try {
        controller?.setCameraPreset?.(preset);
      } catch {
        // ignore
      }
    },
    [controller],
  );

  const handleSwapAvatar = useCallback(
    async (url: string) => {
      if (swappingAvatar || !controller) return;
      setSwappingAvatar(true);
      try {
        await controller.swapAvatar?.(url);
        setCurrentAvatar(url);
      } catch (err) {
        console.error('[lab] avatar swap failed:', err);
      } finally {
        setSwappingAvatar(false);
      }
    },
    [controller, swappingAvatar],
  );

  const handleQuickTest = useCallback(async () => {
    if (!quickText.trim() || quickRunning) return;
    setQuickRunning(true);
    quickAbortRef.current = false;

    const tags: string[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(TAG_RE.source, TAG_RE.flags);
    while ((match = re.exec(quickText)) !== null) {
      tags.push(match[1].toLowerCase());
    }

    for (const tag of tags) {
      if (quickAbortRef.current) break;
      try {
        controller?.setExpression?.(tag, 300);
      } catch {
        // ignore
      }
      // Wait ~1.2s between tags
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (!quickAbortRef.current) {
      // Reset after the sequence
      await new Promise((r) => setTimeout(r, 800));
      try {
        controller?.resetToIdle?.();
      } catch {
        // ignore
      }
    }

    setQuickRunning(false);
  }, [controller, quickText, quickRunning]);

  // Reparent the avatar canvas into the lab's preview area so the user
  // sees it large inside the modal. On cleanup (close), move it back to
  // the sidebar. Three.js continues rendering — it follows the canvas.
  const previewRef = useRef<HTMLDivElement | null>(null);
  const avatarOriginalParentRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const avatarRoot = document.getElementById('seraphine-avatar-root');
    const preview = previewRef.current;
    if (!avatarRoot || !preview) return;
    // Remember where it came from
    avatarOriginalParentRef.current = avatarRoot.parentElement;
    // Move into lab
    preview.appendChild(avatarRoot);
    // Resize canvas to fill the preview area
    const canvas = avatarRoot.querySelector('canvas');
    if (canvas) {
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    }
    return () => {
      // Move back to sidebar
      if (avatarOriginalParentRef.current && avatarRoot.parentElement === preview) {
        avatarOriginalParentRef.current.appendChild(avatarRoot);
        if (canvas) {
          canvas.style.width = '';
          canvas.style.height = '';
        }
      }
    };
  }, []);

  // Keyboard shortcut: Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content avatar-lab"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="avatar-lab__header">
          <h2 className="avatar-lab__title">Avatar Laboratory</h2>
          <button
            type="button"
            className="avatar-lab__close"
            aria-label="Fechar"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        <div className="avatar-lab__body">
          {/* Left: avatar canvas lives here while lab is open */}
          <div className="avatar-lab__preview" ref={previewRef} />

          {/* Right: controls */}
          <div className="avatar-lab__controls">
            {/* Camera presets */}
            <section className="avatar-lab__section">
              <h3 className="avatar-lab__section-title">Camera</h3>
              <div className="avatar-lab__btn-grid">
                {CAMERAS.map((cam) => (
                  <button
                    key={cam.preset}
                    type="button"
                    className={`avatar-lab__btn${activeCamera === cam.preset ? ' avatar-lab__btn--active' : ''}`}
                    onClick={() => handleCameraPreset(cam.preset)}
                  >
                    <span className="avatar-lab__btn-icon">{cam.icon}</span>
                    {cam.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Avatar selector */}
            {AVATARS.length > 1 && (
              <section className="avatar-lab__section">
                <h3 className="avatar-lab__section-title">Avatar</h3>
                <div className="avatar-lab__btn-grid">
                  {AVATARS.map((av) => (
                    <button
                      key={av.url}
                      type="button"
                      className={`avatar-lab__btn${currentAvatar === av.url ? ' avatar-lab__btn--active' : ''}`}
                      disabled={swappingAvatar}
                      onClick={() => handleSwapAvatar(av.url)}
                    >
                      {av.label}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* Raw blendshape sliders */}
            <section className="avatar-lab__section">
              <h3 className="avatar-lab__section-title">Blendshapes</h3>
              <div className="avatar-lab__sliders">
                {blendshapes.map((bs) => (
                  <div key={bs} className="avatar-lab__slider">
                    <label className="avatar-lab__slider-label">{bs}</label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={sliders[bs] ?? 0}
                      onChange={(e) =>
                        handleSliderChange(bs, parseFloat(e.target.value))
                      }
                      className="avatar-lab__slider-input"
                    />
                    <span className="avatar-lab__slider-value">
                      {(sliders[bs] ?? 0).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Presets */}
            <section className="avatar-lab__section">
              <h3 className="avatar-lab__section-title">Presets</h3>
              <div className="avatar-lab__presets">
                {PRESETS.map((p) => (
                  <button
                    key={p.emotion}
                    type="button"
                    className="avatar-lab__preset-btn"
                    onClick={() => handlePreset(p.emotion)}
                  >
                    <span aria-hidden>{p.icon}</span> {p.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Gestures */}
            <section className="avatar-lab__section">
              <h3 className="avatar-lab__section-title">Gestos</h3>
              <div className="avatar-lab__gestures">
                {GESTURES.map((g) => (
                  <button
                    key={g.name}
                    type="button"
                    className="avatar-lab__gesture-btn"
                    disabled={playingGesture !== null}
                    onClick={() => void handleGesture(g.name)}
                  >
                    {playingGesture === g.name ? (
                      <span className="avatar-lab__spinner" />
                    ) : (
                      <span aria-hidden>{g.icon}</span>
                    )}{' '}
                    {g.label}
                  </button>
                ))}
              </div>
            </section>

            {/* Quick text test */}
            <section className="avatar-lab__section">
              <h3 className="avatar-lab__section-title">Teste rapido</h3>
              <div className="avatar-lab__test">
                <input
                  type="text"
                  className="avatar-lab__test-input"
                  placeholder="[happy] Oi! [laughs] Haha"
                  value={quickText}
                  onChange={(e) => setQuickText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleQuickTest();
                  }}
                  disabled={quickRunning}
                />
                <button
                  type="button"
                  className="btn btn-primary avatar-lab__test-btn"
                  disabled={quickRunning || !quickText.trim()}
                  onClick={() => void handleQuickTest()}
                >
                  {quickRunning ? '...' : '\u25B6'}
                </button>
              </div>
              <p className="avatar-lab__test-hint">
                Escreva texto com tags como [happy], [sad], [laughs]. As tags serao executadas em sequencia.
              </p>
            </section>

            {/* Reset */}
            <div className="avatar-lab__reset">
              <button
                type="button"
                className="btn avatar-lab__reset-btn"
                onClick={handleReset}
              >
                Resetar para idle
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Safely get available expressions from controller. */
function getBlendshapes(controller: VrmAvatarController | null): string[] {
  try {
    const list = (controller as any)?.getAvailableBlendshapes?.();
    if (Array.isArray(list) && list.length > 0) return list;
  } catch {
    // method doesn't exist yet
  }
  return FALLBACK_EXPRESSIONS;
}
