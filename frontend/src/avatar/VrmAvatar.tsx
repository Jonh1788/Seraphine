import { useEffect, useRef } from "react";
import { VrmAvatarController } from "./VrmAvatarController";

export interface VrmAvatarProps {
  avatarUrl: string;
  width?: number;
  height?: number;
  onReady?: (controller: VrmAvatarController) => void;
}

export function VrmAvatar(props: VrmAvatarProps): JSX.Element {
  const { avatarUrl, width, height, onReady } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new VrmAvatarController(canvas);
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
  }, [avatarUrl, onReady]);

  return (
    <div role="img" aria-label="Seraphine avatar">
      <canvas ref={canvasRef} width={width ?? 400} height={height ?? 600} />
    </div>
  );
}
