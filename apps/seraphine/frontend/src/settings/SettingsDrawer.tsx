import { useEffect } from 'react';
import { CheckIcon, XIcon } from '../icons/Icons';
import { useTheme } from '../theme';
import type { ThemeDef, ThemeId } from '../theme';

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps): JSX.Element {
  const { theme, setTheme, themes } = useTheme();

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
            <h3 className="settings-drawer__section-title">Mais opcoes</h3>
            <p className="settings-drawer__placeholder">Mais opcoes em breve.</p>
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
