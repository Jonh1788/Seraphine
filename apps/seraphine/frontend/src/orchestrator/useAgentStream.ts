import { useEffect, useRef, useState } from 'react';
import { onAgentEvent, onAgentExit } from './api';
import type { AgentEvent } from './types';

export function useAgentStream(): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const unsub = useRef<Array<() => void>>([]);
  useEffect(() => {
    let live = true;
    void onAgentEvent((e) => { if (live) setEvents((p) => [...p, e]); }).then((u) => unsub.current.push(u));
    void onAgentExit((id) => { if (live) setEvents((p) => [...p, { agent_id: id, kind: { kind: 'other' }, raw: { exit: true } }]); })
      .then((u) => unsub.current.push(u));
    return () => { live = false; unsub.current.forEach((u) => u()); unsub.current = []; };
  }, []);
  return events;
}
