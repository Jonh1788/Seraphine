import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { BellIcon, CheckIcon, MicIcon, RefreshIcon, XIcon } from '../icons/Icons';
import { useTheme } from '../theme';
import type { ThemeDef, ThemeId } from '../theme';

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

          <section className="settings-drawer__section">
            <h3 className="settings-drawer__section-title">Notificacoes</h3>
            <p className="settings-drawer__hint">
              Use o sino da barra superior para ativar Web Push neste dispositivo.
            </p>
            <div className="settings-drawer__status">
              <BellIcon size={16} />
              Proatividade e lembretes respeitam os limites configurados no backend.
            </div>
          </section>
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
