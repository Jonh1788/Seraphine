/**
 * SDD 016-B — Onboarding: step 1 (Welcome).
 *
 * Intentionally light: no VrmAvatar import (avoid burning a WebGL context
 * during first boot). The avatar "presence" is suggested by a CSS gradient
 * orb + Seraphine wordmark.
 */

import { ChevronRightIcon } from '../icons/Icons';

interface Props {
  onNext: () => void;
}

export function WelcomeStep({ onNext }: Props): JSX.Element {
  return (
    <div className="onboarding-step onboarding-step--welcome">
      <div className="onboarding-avatar-frame" aria-hidden="true">
        <div className="onboarding-avatar-orb" />
      </div>
      <h1 className="onboarding-title">Ola! Eu sou a Seraphine.</h1>
      <p className="onboarding-subtitle">
        Sua assistente pessoal. Conversa, organiza tarefas, acompanha habitos e
        te ajuda a manter o foco.
      </p>
      <div className="onboarding-nav onboarding-nav--single">
        <button
          type="button"
          className="onboarding-btn onboarding-btn--primary"
          onClick={onNext}
          autoFocus
        >
          Comecar
          <ChevronRightIcon size={18} />
        </button>
      </div>
    </div>
  );
}
