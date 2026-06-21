import { useEffect } from 'react';
import { useAgentStreamStore } from './agentStreamStore';
import type { AgentEvent } from './types';

/**
 * Subscribes (once, process-wide) to the global agent-event stream and returns
 * the accumulated events. Backed by a Zustand store so the stream PERSISTS
 * across view/tab remounts — leaving the Maestro tab and returning no longer
 * loses the running sessions or an in-flight self-improve run.
 */
export function useAgentStream(): AgentEvent[] {
  const ensureSubscribed = useAgentStreamStore((s) => s.ensureSubscribed);
  useEffect(() => { ensureSubscribed(); }, [ensureSubscribed]);
  return useAgentStreamStore((s) => s.events);
}
