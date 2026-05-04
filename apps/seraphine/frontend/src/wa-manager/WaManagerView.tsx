/* Unified WhatsApp bridges Manager — single-page tool served at
 * sera.jonhdev.io/wa. Lists Seraphine + Aura bridges side by side,
 * surfaces QR/status/recent activity, exposes Disconnect (with optional
 * wipe) per bridge. Polls every 5s; auto-refreshes QR every 10s while
 * any bridge is qr_pending.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api';

interface BridgeStatus {
  slug: string;
  label: string;
  base_url: string;
  status: string;
  phone: string | null;
  name: string | null;
  uptime_s: number;
  error: string | null;
}

interface RecentMessage {
  chatId: string;
  chatName: string;
  author: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
}

const STATUS_DOT: Record<string, string> = {
  ready: '#2DD4BF',
  qr_pending: '#F5A623',
  authenticating: '#7DA4FF',
  disconnected: '#FF5B72',
  unreachable: '#FF5B72',
};

function fmtUptime(s: number): string {
  if (!s) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtPhone(phone: string | null): string {
  if (!phone) return '—';
  // bridge returns bare digits; format as +CC DD NNNNN-NNNN best-effort
  const d = phone.replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) {
    return `+55 ${d.slice(2, 4)} ${d.slice(4, -4)}-${d.slice(-4)}`;
  }
  return phone.startsWith('+') ? phone : `+${phone}`;
}

function fmtRelTime(ts: number): string {
  const ms = Date.now() - ts * 1000;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s atrás`;
  if (s < 3600) return `${Math.round(s / 60)}m atrás`;
  if (s < 86400) return `${Math.round(s / 3600)}h atrás`;
  return `${Math.round(s / 86400)}d atrás`;
}

export function WaManagerView() {
  const [bridges, setBridges] = useState<BridgeStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/wa-manager/bridges`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as { bridges: BridgeStatus[] };
      setBridges(d.bridges);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#06091A',
        color: '#EEF2FF',
        padding: '32px 24px',
        fontFamily: '"DM Sans", system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ marginBottom: 28, display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
            WhatsApp Bridges
          </h1>
          <span style={{ color: '#8B9CC8', fontSize: 13 }}>
            Manager unificado · Seraphine + Aura
          </span>
          <span style={{ marginLeft: 'auto', color: '#4D5E8A', fontSize: 12 }}>
            {loading ? 'carregando…' : `${bridges.length} bridge${bridges.length === 1 ? '' : 's'}`}
          </span>
        </header>

        {error ? (
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: 'rgba(255,91,114,0.08)',
              border: '1px solid rgba(255,91,114,0.20)',
              color: '#FF5B72',
              fontSize: 13,
              marginBottom: 16,
            }}
          >
            Falha ao carregar: {error}
          </div>
        ) : null}

        <div
          style={{
            display: 'grid',
            gap: 18,
            gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
          }}
        >
          {bridges.map((b) => (
            <BridgeCard key={b.slug} bridge={b} onAfterAction={refresh} />
          ))}
        </div>
      </div>
    </div>
  );
}

function BridgeCard({
  bridge,
  onAfterAction,
}: {
  bridge: BridgeStatus;
  onAfterAction: () => void | Promise<void>;
}) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrAge, setQrAge] = useState<number | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [recent, setRecent] = useState<RecentMessage[]>([]);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const lastRecentAt = useRef(0);

  const isQrPending = bridge.status === 'qr_pending';
  const isReady = bridge.status === 'ready';

  // Poll QR while qr_pending
  useEffect(() => {
    if (!isQrPending) {
      setQrUrl(null);
      setQrAge(null);
      return;
    }
    let cancelled = false;
    const fetchQr = async () => {
      setQrLoading(true);
      try {
        const r = await fetch(`${API_BASE}/wa-manager/${bridge.slug}/qr`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { qr: string | null; expires_in_s: number | null };
        if (cancelled) return;
        setQrUrl(d.qr ?? null);
        setQrAge(d.expires_in_s ?? null);
      } catch {
        if (!cancelled) setQrUrl(null);
      } finally {
        if (!cancelled) setQrLoading(false);
      }
    };
    void fetchQr();
    const id = window.setInterval(fetchQr, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bridge.slug, isQrPending]);

  // Pull recent messages periodically when ready
  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;
    const fetchRecent = async () => {
      // throttle to 8s minimum between fetches
      if (Date.now() - lastRecentAt.current < 8000) return;
      lastRecentAt.current = Date.now();
      try {
        const r = await fetch(`${API_BASE}/wa-manager/${bridge.slug}/recent?limit=8`);
        if (!r.ok) return;
        const d = (await r.json()) as { messages: RecentMessage[] };
        if (!cancelled) setRecent(d.messages);
      } catch {
        /* ignore */
      }
    };
    void fetchRecent();
    const id = window.setInterval(fetchRecent, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [bridge.slug, isReady]);

  const onLogout = async (wipe: boolean) => {
    const msg = wipe
      ? `Desconectar ${bridge.label} E APAGAR a sessão? Vai precisar escanear QR de novo.`
      : `Desconectar ${bridge.label}? A sessão fica salva e reconecta sozinha no próximo restart.`;
    if (!window.confirm(msg)) return;
    setLogoutBusy(true);
    try {
      await fetch(
        `${API_BASE}/wa-manager/${bridge.slug}/logout${wipe ? '?wipe=true' : ''}`,
        { method: 'POST' },
      );
      await onAfterAction();
    } finally {
      setLogoutBusy(false);
    }
  };

  return (
    <div
      style={{
        background: '#0C1228',
        border: '1px solid rgba(99,130,255,0.10)',
        borderRadius: 16,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: STATUS_DOT[bridge.status] ?? '#8B9CC8',
            boxShadow: `0 0 6px ${STATUS_DOT[bridge.status] ?? '#8B9CC8'}55`,
          }}
        />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{bridge.label}</h2>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#8B9CC8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {bridge.status}
        </span>
      </header>

      {bridge.error ? (
        <div style={{ color: '#FF5B72', fontSize: 12 }}>
          {bridge.error}
        </div>
      ) : null}

      <dl
        style={{
          margin: 0,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 14px',
          fontSize: 13,
          color: '#8B9CC8',
        }}
      >
        <dt>Telefone</dt>
        <dd style={{ margin: 0, color: '#EEF2FF', fontVariantNumeric: 'tabular-nums' }}>
          {fmtPhone(bridge.phone)}
        </dd>
        <dt>Nome</dt>
        <dd style={{ margin: 0, color: '#EEF2FF' }}>{bridge.name ?? '—'}</dd>
        <dt>Uptime</dt>
        <dd style={{ margin: 0, color: '#EEF2FF', fontVariantNumeric: 'tabular-nums' }}>
          {fmtUptime(bridge.uptime_s)}
        </dd>
      </dl>

      {isQrPending ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: 14,
            borderRadius: 12,
            background: 'rgba(245,166,35,0.05)',
            border: '1px solid rgba(245,166,35,0.20)',
          }}
        >
          {qrUrl ? (
            <img
              src={qrUrl}
              alt="QR code"
              style={{ width: 220, height: 220, background: 'white', padding: 8, borderRadius: 8 }}
            />
          ) : (
            <div
              style={{
                width: 220,
                height: 220,
                display: 'grid',
                placeItems: 'center',
                color: '#F5A623',
                fontSize: 12,
              }}
            >
              {qrLoading ? 'gerando…' : 'aguardando próximo QR…'}
            </div>
          )}
          <div style={{ fontSize: 11, color: '#F5A623' }}>
            {qrAge ? `expira em ~${qrAge}s` : 'rotaciona a cada ~20s'} · escaneia em
            Configurações → Aparelhos conectados → Conectar aparelho
          </div>
        </div>
      ) : null}

      {isReady && recent.length > 0 ? (
        <div>
          <div
            style={{
              fontSize: 11,
              color: '#4D5E8A',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 6,
            }}
          >
            Atividade recente
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
            {recent.map((m, i) => (
              <li
                key={i}
                style={{
                  fontSize: 12,
                  display: 'flex',
                  gap: 8,
                  padding: '6px 8px',
                  borderRadius: 8,
                  background: m.fromMe ? 'rgba(45,212,191,0.06)' : 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(99,130,255,0.06)',
                }}
              >
                <span style={{ color: m.fromMe ? '#2DD4BF' : '#7DA4FF', minWidth: 70, fontWeight: 500 }}>
                  {m.fromMe ? 'Aura' : (m.author || m.chatName || '?').slice(0, 14)}
                </span>
                <span style={{ color: '#EEF2FF', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.body || `[${m.chatName}]`}
                </span>
                <span style={{ color: '#4D5E8A', minWidth: 60, textAlign: 'right' }}>
                  {fmtRelTime(m.timestamp)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <footer style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <button
          type="button"
          onClick={() => void onLogout(false)}
          disabled={logoutBusy || bridge.status === 'unreachable'}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid rgba(99,130,255,0.20)',
            background: 'rgba(255,255,255,0.04)',
            color: '#8B9CC8',
            fontSize: 12,
            cursor: 'pointer',
            opacity: logoutBusy ? 0.5 : 1,
          }}
        >
          Desconectar
        </button>
        <button
          type="button"
          onClick={() => void onLogout(true)}
          disabled={logoutBusy || bridge.status === 'unreachable'}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid rgba(255,91,114,0.30)',
            background: 'rgba(255,91,114,0.08)',
            color: '#FF5B72',
            fontSize: 12,
            cursor: 'pointer',
            opacity: logoutBusy ? 0.5 : 1,
          }}
        >
          Reset (apaga sessão)
        </button>
      </footer>
    </div>
  );
}
