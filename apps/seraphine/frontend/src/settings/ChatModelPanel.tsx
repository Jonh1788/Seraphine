/**
 * Chat-model picker — lets the user switch the MAIN chat between the default
 * cliproxy/Claude routing and a specific OpenRouter model.
 *
 * Displayed inside the SettingsDrawer. Loads once on mount:
 *   - getChatModel()  -> the currently selected chat model
 *   - listModels()    -> the OpenRouter catalogue (populated only when a key is saved)
 *   - getConfig()     -> whether an OpenRouter key is set (+ fanout/synth for PUT)
 */

import { useCallback, useEffect, useState } from 'react';
import { getChatModel, getConfig, listModels, putChatModel, putConfig } from '../research/api';
import type { DeepsearchConfig, ModelOption } from '../research/types';

const CLIPROXY_VALUE = 'cliproxy';

export function ChatModelPanel(): JSX.Element {
  const [chatModel, setChatModel] = useState<string>(CLIPROXY_VALUE);
  const [openrouterModels, setOpenrouterModels] = useState<ModelOption[]>([]);
  const [config, setConfig] = useState<DeepsearchConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline OpenRouter-key entry (only shown when no key is set yet).
  const [orKey, setOrKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cm, mdl, cfg] = await Promise.all([getChatModel(), listModels(), getConfig()]);
      setChatModel(cm.chat_model || CLIPROXY_VALUE);
      setOpenrouterModels(mdl.openrouter);
      setConfig(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = useCallback(async (value: string) => {
    setSaving(true);
    setError(null);
    setChatModel(value); // optimistic
    try {
      const saved = await putChatModel(value);
      setChatModel(saved.chat_model || value);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSaveKey = useCallback(async () => {
    if (!config || !orKey.trim()) return;
    setSavingKey(true);
    setError(null);
    try {
      const saved = await putConfig({
        fanout_model: config.fanout_model,
        synth_model: config.synth_model,
        openrouter_key: orKey.trim(),
      });
      setConfig(saved);
      setOrKey('');
      // With the key now saved, /models returns the OpenRouter catalogue.
      try {
        const mdl = await listModels();
        setOpenrouterModels(mdl.openrouter);
      } catch {
        /* keep current list */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingKey(false);
    }
  }, [config, orKey]);

  // If the saved chat_model is an openrouter id not present in the catalogue,
  // still render it so the <select> keeps it selected.
  const currentIsKnown =
    chatModel === CLIPROXY_VALUE ||
    openrouterModels.some((m) => `openrouter:${m.id}` === chatModel);

  const keySet = config?.openrouter_key_set ?? false;

  return (
    <section className="settings-drawer__section">
      <h3 className="settings-drawer__section-title">Modelo do chat</h3>

      <label className="settings-notif__row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className="settings-notif__label">Modelo</span>
        <select
          className="settings-notif__input"
          style={{ width: '100%' }}
          value={chatModel}
          onChange={(e) => void handleChange(e.target.value)}
          disabled={!loaded || saving}
        >
          <option value={CLIPROXY_VALUE}>Padrao &mdash; cliproxy / Claude</option>
          {openrouterModels.length > 0 && (
            <optgroup label="OpenRouter">
              {openrouterModels.map((m) => (
                <option key={m.id} value={`openrouter:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
          {!currentIsKnown && <option value={chatModel}>{chatModel}</option>}
        </select>
      </label>

      {saving && <p className="settings-drawer__status">Salvando...</p>}
      {savedFlash && !saving && (
        <p className="settings-drawer__status settings-drawer__status--ok">salvo</p>
      )}

      {/* OpenRouter key: inline entry when not set, subtle status when set. */}
      {loaded && !keySet && (
        <div className="settings-notif__row" style={{ alignItems: 'stretch' }}>
          <label className="settings-notif__label" style={{ width: '100%' }}>
            Chave OpenRouter (sk-or-...)
            <input
              type="password"
              className="settings-notif__input"
              style={{ width: '100%', marginTop: 6, display: 'block' }}
              value={orKey}
              onChange={(e) => setOrKey(e.target.value)}
              placeholder="sk-or-..."
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className="settings-drawer__action-btn"
            style={{ width: 'auto', alignSelf: 'flex-end' }}
            onClick={() => void handleSaveKey()}
            disabled={savingKey || !orKey.trim()}
          >
            {savingKey ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      )}
      {loaded && keySet && (
        <p className="settings-drawer__status settings-drawer__status--ok">
          OpenRouter: chave configurada
        </p>
      )}

      {error && <p className="settings-drawer__status settings-drawer__status--err">{error}</p>}

      <p className="settings-drawer__hint">
        Selecionar um modelo OpenRouter roteia o chat por ele (precisa de creditos na conta
        OpenRouter). Padrao usa o Claude via cliproxy.
      </p>
    </section>
  );
}
