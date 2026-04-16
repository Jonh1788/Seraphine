/**
 * SDD 016-B — Onboarding: step 3 (Done).
 *
 * Final confirmation. "Comecar a conversar" triggers onComplete, which writes
 * seraphine.onboarded=true upstream and dismisses the overlay.
 */

import { CheckIcon } from '../icons/Icons';

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

export function DoneStep({ onComplete, onBack }: Props): JSX.Element {
  return (
    <div className="onboarding-step onboarding-step--done">
      <div className="onboarding-check" aria-hidden="true">
        <CheckIcon size={36} />
      </div>
      <h2 className="onboarding-title">Tudo certo!</h2>
      <p className="onboarding-subtitle">
        Me pergunte qualquer coisa. Posso criar tarefas, lembretes, anotar no
        diario ou so conversar.
      </p>
      <div className="onboarding-nav">
        <button
          type="button"
          className="onboarding-btn onboarding-btn--ghost"
          onClick={onBack}
        >
          Voltar
        </button>
        <button
          type="button"
          className="onboarding-btn onboarding-btn--primary"
          onClick={onComplete}
          autoFocus
        >
          Comecar a conversar
        </button>
      </div>
    </div>
  );
}
