import { useEffect, useRef, useState } from 'react';
import type { SeraphineWS } from '../ws/client';
import type {
  ServerMessage,
  ToolRequestMessage,
  ToolResultMessage,
} from '../ws/types';

interface Props {
  ws: SeraphineWS | null;
}

interface RecentEntry {
  request_id: string;
  tool: string;
  ok: boolean;
  error: string | null;
}

export function ApprovalPanel({ ws }: Props): JSX.Element | null {
  const [pending, setPending] = useState<ToolRequestMessage[]>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const toolNames = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      const t = (msg as { type?: string }).type;
      if (t === 'tool_request') {
        const req = msg as ToolRequestMessage;
        toolNames.current.set(req.request_id, req.tool);
        setPending((p) => [...p, req]);
      } else if (t === 'tool_result') {
        const res = msg as ToolResultMessage;
        const name = toolNames.current.get(res.request_id) ?? '(auto)';
        toolNames.current.delete(res.request_id);
        setPending((p) => p.filter((r) => r.request_id !== res.request_id));
        setRecent((r) =>
          [
            { request_id: res.request_id, tool: name, ok: res.ok, error: res.error },
            ...r,
          ].slice(0, 5),
        );
      }
    });
    return off;
  }, [ws]);

  const respond = (request_id: string, approved: boolean): void => {
    ws?.send({ type: 'tool_approval', request_id, approved });
  };

  if (pending.length === 0 && recent.length === 0) return null;

  return (
    <div className="card approval">
      <div className="approval__title">Aprovações</div>
      {pending.map((req) => (
        <div key={req.request_id} className="approval__req">
          <div className="approval__tool">{req.tool}</div>
          <pre className="approval__args">{JSON.stringify(req.args, null, 2)}</pre>
          <div className="approval__buttons">
            <button
              type="button"
              className="btn approval__btn-approve"
              onClick={() => respond(req.request_id, true)}
            >
              Aprovar
            </button>
            <button
              type="button"
              className="btn approval__btn-reject"
              onClick={() => respond(req.request_id, false)}
            >
              Rejeitar
            </button>
          </div>
        </div>
      ))}
      {recent.length > 0 && (
        <ul className="approval__recent">
          {recent.map((r) => (
            <li key={r.request_id}>
              <strong>{r.tool}</strong>:{' '}
              <span className={r.ok ? 'ok' : 'err'}>
                {r.ok ? 'ok' : `err — ${r.error ?? 'unknown'}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
