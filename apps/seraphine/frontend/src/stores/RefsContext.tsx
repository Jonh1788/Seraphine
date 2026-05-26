import { createContext, useContext, useRef } from 'react';
import type { MutableRefObject, ReactNode } from 'react';
import type { SeraphineWS } from '../ws/client';
import type { MicCapture, PCMPlayback } from '../audio';
import type { VrmAvatarController } from '../avatar/VrmAvatarController';

export interface AppRefs {
  wsRef: MutableRefObject<SeraphineWS | null>;
  micRef: MutableRefObject<MicCapture | null>;
  playbackRef: MutableRefObject<PCMPlayback | null>;
  avatarCtrlRef: MutableRefObject<VrmAvatarController | null>;
}

const RefsContext = createContext<AppRefs | null>(null);

export function RefsProvider({ children }: { children: ReactNode }): JSX.Element {
  const wsRef = useRef<SeraphineWS | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playbackRef = useRef<PCMPlayback | null>(null);
  const avatarCtrlRef = useRef<VrmAvatarController | null>(null);

  const refs: AppRefs = { wsRef, micRef, playbackRef, avatarCtrlRef };

  return <RefsContext.Provider value={refs}>{children}</RefsContext.Provider>;
}

export function useAppRefs(): AppRefs {
  const ctx = useContext(RefsContext);
  if (!ctx) throw new Error('useAppRefs must be used within RefsProvider');
  return ctx;
}
