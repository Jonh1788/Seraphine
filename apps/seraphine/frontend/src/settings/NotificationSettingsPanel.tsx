/**
 * 094 -- Notification Intelligence settings panel.
 *
 * Displayed inside the SettingsDrawer. Fetches / patches settings from
 * the backend and shows current DND status + priority weights.
 */

import { useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { BellIcon } from '../icons/Icons';

interface NotifSettings {
  quiet_hours_start: string;
  quiet_hours_end: string;
  dnd_apps: string[];
  batching_enabled: boolean;
  per_type_enabled: Record<string, boolean>;
}

const TYPE_LABELS: Record<string, string> = {
  water: 'Agua',
  reminder_timed: 'Lembretes',
  opener: 'Opener',
  insight: 'Insights',
  day_review: 'Revisao do dia',
  weekly_reflection: 'Reflexao semanal',
  task_deadline: 'Deadline de task',
  whatsapp_mention: 'WhatsApp mencao',
  stalled_task: 'Tarefa parada',
};

export function NotificationSettingsPanel(): JSX.Element {
  const [settings, setSettings] = useState<NotifSettings | null>(null);
  const [weights, setWeights] = useState<Record<string, number> | null>(null);
  const [dnd, setDnd] = useState<{ dnd: boolean; reasons: Record<string, boolean> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showWeights, setShowWeights] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sRes, wRes, dRes] = await Promise.all([
        fetch(`${API_BASE}/notifications/settings`),
        fetch(`${API_BASE}/notifications/priority-weights`),
        fetch(`${API_BASE}/notifications/dnd-status`),
      ]);
      if (sRes.ok) setSettings(await sRes.json());
      if (wRes.ok) {
        const data = await wRes.json();
        setWeights(data.weights || data);
      }
      if (dRes.ok) setDnd(await dRes.json());
    } catch {
      // silent — service might not be available
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (partial: Partial<NotifSettings>) => {
      setSaving(true);
      try {
        const res = await fetch(`${API_BASE}/notifications/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(partial),
        });
        if (res.ok) {
          setSettings(await res.json());
        }
      } catch {
        // silent
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  if (!settings) {
    return (
      <section className="settings-drawer__section">
        <h3 className="settings-drawer__section-title">Notificacoes</h3>
        <p className="settings-drawer__hint">Carregando...</p>
      </section>
    );
  }

  return (
    <section className="settings-drawer__section">
      <h3 className="settings-drawer__section-title">
        <BellIcon size={16} /> Notificacoes inteligentes
      </h3>

      {/* DND status */}
      {dnd && (
        <div
          className="settings-drawer__status"
          style={{ marginBottom: 8 }}
        >
          <span
            className={`settings-status-list__dot settings-status-list__dot--${dnd.dnd ? 'warn' : 'ok'}`}
          />
          {dnd.dnd
            ? `DND ativo (${Object.entries(dnd.reasons).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ')})`
            : 'DND inativo'}
        </div>
      )}

      {/* Quiet hours */}
      <div className="settings-notif__row">
        <label className="settings-notif__label">Silencio de</label>
        <input
          type="time"
          className="settings-notif__input"
          value={settings.quiet_hours_start}
          onChange={(e) =>
            void patch({ quiet_hours_start: e.target.value })
          }
          disabled={saving}
        />
        <span className="settings-notif__label">ate</span>
        <input
          type="time"
          className="settings-notif__input"
          value={settings.quiet_hours_end}
          onChange={(e) =>
            void patch({ quiet_hours_end: e.target.value })
          }
          disabled={saving}
        />
      </div>

      {/* Batching toggle */}
      <label className="settings-drawer__toggle">
        <span>Batching de notificacoes</span>
        <input
          type="checkbox"
          checked={settings.batching_enabled}
          onChange={(e) =>
            void patch({ batching_enabled: e.target.checked })
          }
          disabled={saving}
        />
      </label>
      <p className="settings-drawer__hint">
        Agrupa notificacoes de baixa prioridade e entrega em lote ao sair do DND.
      </p>

      {/* Per-type toggles */}
      <details className="settings-notif__details">
        <summary className="settings-notif__summary">Tipos de notificacao</summary>
        <div className="settings-notif__types">
          {Object.entries(settings.per_type_enabled).map(([key, enabled]) => (
            <label key={key} className="settings-drawer__toggle settings-notif__type-row">
              <span>{TYPE_LABELS[key] || key}</span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  const next = { ...settings.per_type_enabled, [key]: e.target.checked };
                  void patch({ per_type_enabled: next });
                }}
                disabled={saving}
              />
            </label>
          ))}
        </div>
      </details>

      {/* DND apps */}
      <details className="settings-notif__details">
        <summary className="settings-notif__summary">Apps que ativam DND</summary>
        <textarea
          className="settings-notif__textarea"
          rows={3}
          value={settings.dnd_apps.join('\n')}
          onChange={(e) => {
            const apps = e.target.value
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean);
            void patch({ dnd_apps: apps });
          }}
          disabled={saving}
          placeholder="Um app por linha (ex: zoom.us, FaceTime)"
        />
      </details>

      {/* Priority weights debug panel */}
      <button
        type="button"
        className="settings-notif__weights-btn"
        onClick={() => setShowWeights((v) => !v)}
      >
        {showWeights ? 'Esconder pesos' : 'Ver pesos de prioridade'}
      </button>
      {showWeights && weights && (
        <table className="settings-notif__weights-table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Prioridade</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(weights)
              .sort(([, a], [, b]) => b - a)
              .map(([type, score]) => (
                <tr key={type}>
                  <td>{TYPE_LABELS[type] || type}</td>
                  <td>{score}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
