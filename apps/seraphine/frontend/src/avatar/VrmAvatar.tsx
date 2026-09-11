import { useEffect, useRef, useState } from "react";
import { VrmAvatarController } from "./VrmAvatarController";

export interface VrmAvatarProps {
  avatarUrl: string;
  width?: number;
  height?: number;
  onReady?: (controller: VrmAvatarController) => void;
  /** Enable user orbit/zoom controls (main avatar view only). */
  cameraControls?: boolean;
  /** Closest the user can zoom in (world units). Default 0.35. */
  cameraMinDistance?: number;
  /** Farthest the user can zoom out (world units). Default 4.0. */
  cameraMaxDistance?: number;
}

export function VrmAvatar(props: VrmAvatarProps): JSX.Element {
  const { avatarUrl, width, height, onReady, cameraControls, cameraMinDistance, cameraMaxDistance } = props;
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const [recreateKey, setRecreateKey] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    // dispose() releases the WebGL context. A new effect (including React
    // StrictMode's setup/cleanup/setup) must get a fresh canvas as well.
    const canvas = document.createElement('canvas');
    canvas.width = width ?? 400;
    canvas.height = height ?? 600;
    host.appendChild(canvas);
    setError(false);
    let controller: VrmAvatarController;
    try {
      controller = new VrmAvatarController(canvas, {
        cameraControls,
        minDistance: cameraMinDistance,
        maxDistance: cameraMaxDistance,
      });
    } catch (err) {
      console.warn('[VrmAvatar] renderer unavailable', err);
      canvas.remove();
      setError(true);
      return;
    }
    // After a real WebGL context loss, three's GL state is unusable — rebuild.
    controller.onContextRestoreNeeded = () => setRecreateKey((k) => k + 1);
    let cancelled = false;
    controller
      .loadAvatar(avatarUrl)
      .then(() => {
        if (cancelled) return;
        onReady?.(controller);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[VrmAvatar] failed to load avatar", err);
        canvas.hidden = true;
        setError(true);
      });
    return () => {
      cancelled = true;
      controller.dispose();
      canvas.remove();
    };
  }, [avatarUrl, width, height, onReady, cameraControls, cameraMinDistance, cameraMaxDistance, recreateKey]);

  return (
    <div id="seraphine-avatar-root">
      <div ref={canvasHostRef} role="img" aria-label="Avatar da Seraphine" />
      {error && (
        <div role="status">
          <p>O avatar 3D não pôde ser carregado.</p>
          <button type="button" onClick={() => setRecreateKey((key) => key + 1)}>
            Recarregar avatar
          </button>
        </div>
      )}
    </div>
  );
}
