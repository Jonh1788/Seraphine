import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { CheckIcon, MicIcon, RefreshIcon, XIcon } from '../icons/Icons';
import { useTheme } from '../theme';
import type { ThemeDef, ThemeId } from '../theme';
import { NotificationSettingsPanel } from './NotificationSettingsPanel';
import { GoogleAuthPanel } from '../google';

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  // In-flight wake-word feature (see realtime/useWakeWord.ts). Optional
  // so the drawer renders even before the wake-word UI is wired here.
  wakeWordEnabled?: boolean;
  onWakeWordToggle?: (next: boolean) => void;
}

interface IntegrationStatus {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'off';
  detail: string;
}

export function SettingsDrawer({
  open,
  onClose,
  wakeWordEnabled = false,
  onWakeWordToggle,
}: SettingsDrawerProps): JSX.Element {
  const { theme, setTheme, themes } = useTheme();
  const [statuses, setStatuses] = useState<IntegrationStatus[]>([]);
  const [waQr, setWaQr] = useState<{ url: string | null; msg: string | null; loading: boolean }>({
    url: null,
    msg: null,
    loading: false,
  });
  const [checking, setChecking] = useState(false);

  const refreshStatus = useCallback(async () => {
    setChecking(true);
    const next: IntegrationStatus[] = [];
    const check = async (
      id: string,
      label: string,
      path: string,
      parser: (body: unknown) => IntegrationStatus,
    ): Promise<void> => {
      try {
        const res = await fetch(`${API_BASE}${path}`);
        if (!res.ok) {
          next.push({ id, label, status: 'off', detail: `HTTP ${res.status}` });
          return;
        }
        next.push(parser(await res.json()));
      } catch {
        next.push({ id, label, status: 'off', detail: 'indisponivel' });
      }
    };

    await Promise.all([
      check('backend', 'Backend', '/health', () => ({
        id: 'backend',
        label: 'Backend',
        status: 'ok',
        detail: 'online',
      })),
      check('google', 'Google', '/google/oauth/status', (body) => {
        const b = body as { authed?: boolean; email?: string };
        return {
          id: 'google',
          label: 'Google',
          status: b.authed ? 'ok' : 'warn',
          detail: b.authed ? (b.email || 'conectado') : 'nao conectado',
        };
      }),
      check('whatsapp', 'WhatsApp', '/whatsapp/status', (body) => {
        const b = body as { ready?: boolean; status?: string; connected?: boolean };
        const ok = Boolean(b.ready || b.connected || b.status === 'ready');
        return {
          id: 'whatsapp',
          label: 'WhatsApp',
          status: ok ? 'ok' : 'warn',
          detail: b.status || (ok ? 'conectado' : 'aguardando QR'),
        };
      }),
      check('push', 'Push', '/push/status', (body) => {
        const b = body as { configured?: boolean; subscription_count?: number };
        return {
          id: 'push',
          label: 'Notificacoes',
          status: b.configured ? 'ok' : 'warn',
          detail: b.configured ? `${b.subscription_count || 0} inscricoes` : 'VAPID nao configurado',
        };
      }),
      check('memory', 'Memoria', '/memory/health', (body) => {
        const b = body as { ok?: boolean; status?: string };
        return {
          id: 'memory',
          label: 'Memoria',
          status: b.ok === false ? 'warn' : 'ok',
          detail: b.status || 'operacional',
        };
      }),
    ]);
    setStatuses(next);
    setChecking(false);
  }, []);

  // WhatsApp pairing: fetch the bridge QR (data URL) so the user can scan it.
  const loadWhatsAppQr = useCallback(async () => {
    setWaQr({ url: null, msg: null, loading: true });
    try {
      const res = await fetch(`${API_BASE}/whatsapp/qr`);
      if (!res.ok) {
        setWaQr({ url: null, msg: `Bridge indisponivel (HTTP ${res.status})`, loading: false });
        return;
      }
      const data = (await res.json()) as { qr?: string | null; message?: string };
      if (data.qr) {
        setWaQr({ url: data.qr, msg: null, loading: false });
      } else {
        setWaQr({ url: null, msg: data.message || 'Sem QR no momento (talvez ja conectado).', loading: false });
      }
    } catch {
      setWaQr({ url: null, msg: 'Falha ao buscar o QR.', loading: false });
    }
  }, []);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  return (
    <>
      {open && (
        <div
          className="settings-drawer__backdrop"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={`settings-drawer${open ? ' settings-drawer--open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Configuracoes"
        aria-hidden={!open}
      >
        <header className="settings-drawer__header">
          <h2 className="settings-drawer__title">Configuracoes</h2>
          <button
            type="button"
            className="settings-drawer__close"
            onClick={onClose}
            aria-label="Fechar"
          >
            <XIcon size={18} />
          </button>
        </header>

        <div className="settings-drawer__body">
          <section className="settings-drawer__section">
            <h3 className="settings-drawer__section-title">Tema</h3>
            <div className="theme-grid">
              {themes.map((def) => (
                <ThemeCard
                  key={def.id}
                  def={def}
                  active={def.id === theme}
                  onSelect={setTheme}
                />
              ))}
            </div>
          </section>

          <section className="settings-drawer__section">
            <h3 className="settings-drawer__section-title">Voz e presenca</h3>
            <label className="settings-drawer__toggle">
              <span>
                <MicIcon size={16} />
                Wake word
              </span>
              <input
                type="checkbox"
                checked={wakeWordEnabled}
                onChange={(e) => onWakeWordToggle?.(e.target.checked)}
                disabled={!onWakeWordToggle}
              />
            </label>
            <p className="settings-drawer__hint">
              Mantem o microfone em espera para ativar a conversa por voz quando o realtime estiver desligado.
            </p>
          </section>

          <section className="settings-drawer__section">
            <h3 className="settings-drawer__section-title">Integracoes</h3>
            <GoogleAuthPanel />
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ fontSize: 13, color: 'var(--text)' }}>WhatsApp</span>
                <button
                  type="button"
                  className="obs-btn obs-btn--ghost"
                  style={{ fontSize: 12, padding: '6px 12px' }}
                  onClick={() => void loadWhatsAppQr()}
                  disabled={waQr.loading}
                >
                  {waQr.loading ? 'Carregando...' : waQr.url ? 'Atualizar QR' : 'Mostrar QR'}
                </button>
              </div>
              {waQr.url && (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 8,
                    padding: 12,
                    background: 'var(--bg-1)',
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                  }}
                >
                  <img
                    src={waQr.url}
                    alt="QR code do WhatsApp"
                    width={200}
                    height={200}
                    style={{ borderRadius: 8, background: '#fff', padding: 8 }}
                  />
                  <p style={{ fontSize: 11, color: 'var(--text-dim)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
                    No celular: WhatsApp &rarr; Aparelhos conectados &rarr; Conectar aparelho, e escaneie.
                  </p>
                </div>
              )}
              {waQr.msg && <p className="settings-drawer__placeholder">{waQr.msg}</p>}
            </div>
          </section>

          <section className="settings-drawer__section">
            <div className="settings-drawer__section-row">
              <h3 className="settings-drawer__section-title">Diagnostico</h3>
              <button
                type="button"
                className="settings-drawer__icon-btn"
                onClick={() => void refreshStatus()}
                disabled={checking}
                aria-label="Atualizar diagnostico"
              >
                <RefreshIcon size={15} />
              </button>
            </div>
            <div className="settings-status-list">
              {statuses.map((item) => (
                <div key={item.id} className="settings-status-list__item">
                  <span className={`settings-status-list__dot settings-status-list__dot--${item.status}`} />
                  <span className="settings-status-list__label">{item.label}</span>
                  <span className="settings-status-list__detail">{item.detail}</span>
                </div>
              ))}
              {statuses.length === 0 && (
                <div className="settings-drawer__placeholder">
                  {checking ? 'Verificando...' : 'Sem dados ainda.'}
                </div>
              )}
            </div>
          </section>

          <NotificationSettingsPanel />
        </div>
      </aside>
    </>
  );
}

interface ThemeCardProps {
  def: ThemeDef;
  active: boolean;
  onSelect: (id: ThemeId) => void;
}

function ThemeCard({ def, active, onSelect }: ThemeCardProps): JSX.Element {
  return (
    <button
      type="button"
      className={`theme-card${active ? ' theme-card--active' : ''}`}
      onClick={() => onSelect(def.id)}
      aria-pressed={active}
      aria-label={`Tema ${def.name}`}
    >
      <div className="theme-card__swatches" aria-hidden="true">
        <span
          className="theme-card__swatch"
          style={{ background: def.preview.bg }}
        />
        <span
          className="theme-card__swatch"
          style={{ background: def.preview.accent }}
        />
        <span
          className="theme-card__swatch"
          style={{ background: def.preview.user }}
        />
      </div>
      <span className="theme-card__name">{def.name}</span>
      {active && (
        <span className="theme-card__check" aria-hidden="true">
          <CheckIcon size={14} />
        </span>
      )}
    </button>
  );
}
