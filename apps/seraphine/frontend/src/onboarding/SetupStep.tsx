/**
 * SDD 016-B — Onboarding: step 2 (Setup).
 *
 * Collects:
 *   - user_name (free text, optional)
 *   - llm_backend ("ollama" | "claude") — FAKE selector. Writes to
 *     localStorage.seraphine.llm_backend but the backend does NOT currently
 *     read it. TODO: wire backend runtime switch (tracked for a follow-up).
 *   - Google OAuth connection — reuses /google/oauth/start; opens consent in
 *     a new window. User can click "Talvez depois" to advance without it.
 */

import { useState } from 'react';
import { startOAuth } from '../google/api';
import { ChevronLeftIcon, ChevronRightIcon, CheckIcon } from '../icons/Icons';

export type LlmBackend = 'ollama' | 'claude';

interface Props {
  name: string;
  onNameChange: (v: string) => void;
  llmBackend: LlmBackend;
  onLlmBackendChange: (v: LlmBackend) => void;
  onBack: () => void;
  onNext: () => void;
}

export function SetupStep({
  name,
  onNameChange,
  llmBackend,
  onLlmBackendChange,
  onBack,
  onNext,
}: Props): JSX.Element {
  const [googleStatus, setGoogleStatus] = useState<
    'idle' | 'opening' | 'opened' | 'error'
  >('idle');
  const [googleError, setGoogleError] = useState<string | null>(null);

  const handleConnectGoogle = async (): Promise<void> => {
    setGoogleStatus('opening');
    setGoogleError(null);
    try {
      const { consent_url } = await startOAuth();
      window.open(consent_url, '_blank', 'noopener,noreferrer');
      setGoogleStatus('opened');
    } catch (e) {
      setGoogleStatus('error');
      setGoogleError(String(e));
    }
  };

  return (
    <div className="onboarding-step onboarding-step--setup">
      <h2 className="onboarding-title">Vamos configurar</h2>
      <p className="onboarding-subtitle">
        Sao poucos detalhes. Voce pode mudar tudo depois em Configuracoes.
      </p>

      <div className="onboarding-field">
        <label className="onboarding-label" htmlFor="onb-name">
          Como quer ser chamado?
        </label>
        <input
          id="onb-name"
          className="onboarding-input"
          type="text"
          placeholder="Seu nome ou apelido"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </div>

      <div className="onboarding-field">
        <label className="onboarding-label">Cerebro da assistente</label>
        <div className="onboarding-backends">
          <button
            type="button"
            className={
              'onboarding-backend-card' +
              (llmBackend === 'ollama' ? ' is-selected' : '')
            }
            onClick={() => onLlmBackendChange('ollama')}
            aria-pressed={llmBackend === 'ollama'}
          >
            <div className="onboarding-backend-card__title">
              Ollama
              {llmBackend === 'ollama' && (
                <span className="onboarding-backend-card__check" aria-hidden="true">
                  <CheckIcon size={14} />
                </span>
              )}
            </div>
            <div className="onboarding-backend-card__desc">
              Local, privado, roda no seu computador.
            </div>
          </button>
          <button
            type="button"
            className={
              'onboarding-backend-card' +
              (llmBackend === 'claude' ? ' is-selected' : '')
            }
            onClick={() => onLlmBackendChange('claude')}
            aria-pressed={llmBackend === 'claude'}
          >
            <div className="onboarding-backend-card__title">
              Claude
              {llmBackend === 'claude' && (
                <span className="onboarding-backend-card__check" aria-hidden="true">
                  <CheckIcon size={14} />
                </span>
              )}
            </div>
            <div className="onboarding-backend-card__desc">
              Nuvem, mais capacidade, requer chave de API.
            </div>
          </button>
        </div>
      </div>

      <div className="onboarding-field">
        <label className="onboarding-label">Google (opcional)</label>
        <div className="onboarding-google">
          <button
            type="button"
            className="onboarding-btn onboarding-btn--ghost"
            onClick={() => void handleConnectGoogle()}
            disabled={googleStatus === 'opening'}
          >
            {googleStatus === 'opened'
              ? 'Janela de consentimento aberta'
              : googleStatus === 'opening'
              ? 'Abrindo...'
              : 'Conectar Google'}
          </button>
          {googleError && (
            <div className="onboarding-error" role="alert">
              {googleError}
            </div>
          )}
          <div className="onboarding-hint">
            Agenda e email ficam disponiveis apos autorizar. Voce pode pular e
            conectar depois.
          </div>
        </div>
      </div>

      <div className="onboarding-nav">
        <button
          type="button"
          className="onboarding-btn onboarding-btn--ghost"
          onClick={onBack}
        >
          <ChevronLeftIcon size={18} />
          Voltar
        </button>
        <button
          type="button"
          className="onboarding-btn onboarding-btn--primary"
          onClick={onNext}
        >
          Proximo
          <ChevronRightIcon size={18} />
        </button>
      </div>
    </div>
  );
}
