import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** mobile: bottom sheet (default), full: edge-to-edge fullscreen on mobile */
  mobileMode?: "sheet" | "full";
  /** Hide the default close button + header */
  hideHeader?: boolean;
  /** Extra classes on the panel */
  className?: string;
  /** Max width on lg+ (defaults to max-w-2xl) */
  maxWidth?: string;
}

const DRAG_DISMISS_PX = 90;

export function Sheet({
  open,
  onClose,
  title,
  children,
  mobileMode = "sheet",
  hideHeader = false,
  className = "",
  maxWidth = "max-w-2xl",
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  const handlePointerDown = (e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (dragStartY.current == null) return;
    const dy = e.clientY - dragStartY.current;
    if (dy > 0) setDragOffset(dy);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragStartY.current == null) return;
    const dy = e.clientY - dragStartY.current;
    dragStartY.current = null;
    if (dy > DRAG_DISMISS_PX) {
      onClose();
      setDragOffset(0);
    } else {
      setDragOffset(0);
    }
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  if (!mounted) return null;

  const isFullMobile = mobileMode === "full";

  return (
    <div
      className={[
        "fixed inset-0 z-50 transition-opacity duration-200",
        open ? "opacity-100" : "opacity-0 pointer-events-none",
      ].join(" ")}
      onTransitionEnd={() => {
        if (!open) setMounted(false);
      }}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={[
          "absolute inset-x-0 bottom-0 lg:inset-0 lg:flex lg:items-center lg:justify-center",
          "pointer-events-none",
        ].join(" ")}
      >
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          className={[
            "pointer-events-auto bg-bg-s2 text-ink-primary shadow-glass",
            isFullMobile
              ? "h-[100dvh] w-full rounded-none lg:h-auto lg:rounded-xl3"
              : "max-h-[88dvh] w-full rounded-t-xl3 lg:rounded-xl3",
            "lg:max-h-[85vh] lg:w-full",
            maxWidth,
            "flex flex-col transition-transform duration-300 ease-out",
            open ? "translate-y-0" : "translate-y-full lg:translate-y-4",
            className,
          ].join(" ")}
          style={{
            transform:
              dragOffset > 0 && open
                ? `translateY(${dragOffset}px)`
                : undefined,
            transition: dragOffset > 0 ? "none" : undefined,
          }}
        >
          {!isFullMobile && (
            <div
              className="lg:hidden flex justify-center pt-2.5 pb-1.5 cursor-grab active:cursor-grabbing touch-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <div className="h-1.5 w-10 rounded-full bg-white/15" />
            </div>
          )}
          {!hideHeader && (title || onClose) ? (
            <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-3 border-b border-white/5">
              <div className="font-display text-lg font-semibold truncate">{title}</div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="grid place-items-center h-9 w-9 rounded-lg bg-white/5 hover:bg-white/10 text-ink-dim"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          <div
            className={[
              "flex-1 overflow-y-auto",
              isFullMobile ? "pb-safe" : "pb-[max(env(safe-area-inset-bottom),16px)]",
            ].join(" ")}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
