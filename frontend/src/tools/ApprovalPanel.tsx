import { useEffect, useState } from 'react';
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

  useEffect(() => {
    if (!ws) return;
    const off = ws.onMessage((msg: ServerMessage | ArrayBuffer) => {
      if (msg instanceof ArrayBuffer) return;
      const t = (msg as { type?: string }).type;
      if (t === 'tool_request') {
        const req = msg as ToolRequestMessage;
        setPending((p) => [...p, req]);
      } else if (t === 'tool_result') {
        const res = msg as ToolResultMessage;
        setPending((p) => p.filter((r) => r.request_id !== res.request_id));
        setRecent((r) =>
          [
            { request_id: res.request_id, tool: '', ok: res.ok, error: res.error },
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
    <div
      style={{
        border: '1px solid #ccc',
        padding: '0.75rem',
        borderRadius: 6,
        marginTop: '1rem',
        background: '#fafafa',
      }}
    >
      <h3 style={{ margin: '0 0 0.5rem 0' }}>Tool approvals</h3>
      {pending.map((req) => (
        <div
          key={req.request_id}
          style={{
            border: '1px solid #ddd',
            padding: '0.5rem',
            marginBottom: '0.5rem',
            background: 'white',
          }}
        >
          <div>
            <strong>{req.tool}</strong>
          </div>
          <pre
            style={{
              background: '#f4f4f4',
              padding: '0.25rem',
              fontSize: 12,
              overflowX: 'auto',
            }}
          >
            {JSON.stringify(req.args, null, 2)}
          </pre>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" onClick={() => respond(req.request_id, true)}>
              Approve
            </button>
            <button type="button" onClick={() => respond(req.request_id, false)}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {recent.length > 0 && (
        <div style={{ fontSize: 12, marginTop: '0.5rem' }}>
          <div>Recent:</div>
          <ul style={{ margin: 0, paddingLeft: '1rem' }}>
            {recent.map((r) => (
              <li key={r.request_id}>
                {r.ok ? 'ok' : `err: ${r.error ?? 'unknown'}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
