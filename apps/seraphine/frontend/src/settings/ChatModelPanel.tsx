/**
 * Chat-model picker — lets the user switch the MAIN chat between the default
 * cliproxy/Claude routing and a specific OpenRouter model.
 *
 * Displayed inside the SettingsDrawer. Loads once on mount:
 *   - getChatModel()  -> the currently selected chat model
 *   - listModels()    -> the OpenRouter catalogue (populated only when a key is saved)
 *   - getConfig()     -> whether an OpenRouter key is set (+ fanout/synth for PUT)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getChatEffort,
  getChatModel,
  getConfig,
  listModels,
  putChatEffort,
  putChatModel,
  putConfig,
} from '../research/api';
import type { DeepsearchConfig, Effort, ModelOption } from '../research/types';
import { EffortPicker, ModelPicker } from '../ui';
import type { ModelPickerGroup } from '../ui';

const CLIPROXY_VALUE = 'cliproxy';
const CLIPROXY_LABEL = 'Padrão — cliproxy / Claude';

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

  // Esforço de raciocínio (kv separado do modelo, mesma tela).
  const [effort, setEffort] = useState<string>('');
  const [savingEffort, setSavingEffort] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cm, mdl, cfg, ef] = await Promise.all([
        getChatModel(),
        listModels(),
        getConfig(),
        // Secundário: se só o esforço falhar, a tela continua servindo o
        // seletor de modelo em vez de virar um erro inteiro.
        getChatEffort().catch(() => ({ effort: '' })),
      ]);
      setChatModel(cm.chat_model || CLIPROXY_VALUE);
      setOpenrouterModels(mdl.openrouter);
      setConfig(cfg);
      setEffort(ef.effort || '');
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

  // `m.id` JÁ vem prefixado de /deepsearch/models ("openrouter:<id>"), e é ele
  // que vai para o ModelPicker e volta VERBATIM no onChange. Prefixar de novo
  // gravava "openrouter:openrouter:<id>" e a OpenRouter devolvia 400 "is not a
  // valid model ID" — em toda conversa, não só nesta tela.
  const grupos = useMemo<ModelPickerGroup[]>(
    () => [
      { label: 'Padrão', options: [{ id: CLIPROXY_VALUE, name: CLIPROXY_LABEL }] },
      { label: 'OpenRouter', options: openrouterModels },
    ],
    [openrouterModels],
  );

  const keySet = config?.openrouter_key_set ?? false;

  /* Esforço só faz efeito em modelo do OpenRouter que anuncia `reasoning`. O
     Padrão (cliproxy) roteia por outro caminho, que não passa por este ajuste
     — dizer isso é melhor que deixar o controle ligado sem efeito. */
  const modeloAtual = openrouterModels.find((m) => m.id === chatModel);
  const suportaEsforco = Boolean(modeloAtual?.reasoning);
  const motivoNaoSuportado =
    chatModel === CLIPROXY_VALUE
      ? 'O Padrão (cliproxy / Claude) não passa por este ajuste. Escolha um modelo OpenRouter que aceite raciocínio.'
      : modeloAtual
        ? `${modeloAtual.name} não aceita esforço de raciocínio, então o ajuste não teria efeito.`
        : 'Não sei se este modelo aceita raciocínio — ele não está no catálogo que a OpenRouter devolveu agora.';

  const handleEffort = useCallback(async (value: Effort) => {
    setSavingEffort(true);
    setError(null);
    const anterior = effort;
    setEffort(value); // otimista
    try {
      const saved = await putChatEffort(value);
      setEffort(saved.effort ?? value);
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1800);
    } catch (err) {
      // Devolve: deixar o otimismo de pé faria a tela afirmar um esforço que
      // o backend não tem gravado — e é ele que monta a requisição.
      setEffort(anterior);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEffort(false);
    }
  }, [effort]);

  return (
    <section className="settings-drawer__section">
      <h3 className="settings-drawer__section-title">Modelo do chat</h3>

      <div className="settings-notif__row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <span className="settings-notif__label">Modelo</span>
        <ModelPicker
          label="Modelo do chat"
          value={chatModel}
          groups={grupos}
          disabled={!loaded || saving}
          onChange={(id) => void handleChange(id)}
        />
      </div>

      <div
        className="settings-notif__row"
        style={{ flexDirection: 'column', alignItems: 'stretch', marginTop: 10 }}
      >
        <span className="settings-notif__label">Esforço de raciocínio</span>
        <EffortPicker
          value={effort}
          onChange={(e) => void handleEffort(e)}
          suportado={suportaEsforco}
          disabled={!loaded || savingEffort}
          motivoNaoSuportado={motivoNaoSuportado}
        />
      </div>

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
        A lista traz o catalogo inteiro da OpenRouter &mdash; digite no campo para filtrar por nome
        ou id. Selecionar um modelo OpenRouter roteia o chat por ele (precisa de creditos na conta
        OpenRouter). Padrao usa o Claude via cliproxy.
      </p>
    </section>
  );
}
