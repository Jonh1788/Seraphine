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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [recreateKey, setRecreateKey] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new VrmAvatarController(canvas, {
      cameraControls,
      minDistance: cameraMinDistance,
      maxDistance: cameraMaxDistance,
    });
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
        // eslint-disable-next-line no-console
        console.error("[VrmAvatar] failed to load avatar", err);
      });
    return () => {
      cancelled = true;
      controller.dispose();
    };
  }, [avatarUrl, onReady, cameraControls, cameraMinDistance, cameraMaxDistance, recreateKey]);

  return (
    <div id="seraphine-avatar-root" role="img" aria-label="Seraphine avatar">
      <canvas ref={canvasRef} width={width ?? 400} height={height ?? 600} />
    </div>
  );
}
