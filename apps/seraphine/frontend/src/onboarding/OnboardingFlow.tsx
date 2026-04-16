/**
 * SDD 016-B — First-run onboarding controller.
 *
 * 3-step state machine: 'welcome' -> 'setup' -> 'done'.
 * Renders as a full-screen glass overlay above the app. The caller is
 * responsible for deciding when to mount/unmount this component (see
 * localStorage gate in App.tsx).
 *
 * LocalStorage writes:
 *   - seraphine.user_name    (on setup commit, if non-empty)
 *   - seraphine.llm_backend  (on setup commit) — FAKE selector; backend does
 *     not currently read this. TODO: wire backend runtime switch.
 *   - seraphine.onboarded    (written by App.onComplete, not here)
 */

import { useEffect, useState } from 'react';
import { WelcomeStep } from './WelcomeStep';
import { SetupStep, type LlmBackend } from './SetupStep';
import { DoneStep } from './DoneStep';

type Step = 'welcome' | 'setup' | 'done';

interface Props {
  onComplete: () => void;
}

const STEPS: readonly Step[] = ['welcome', 'setup', 'done'] as const;

function readInitialName(): string {
  try {
    return localStorage.getItem('seraphine.user_name') ?? '';
  } catch {
    return '';
  }
}

function readInitialBackend(): LlmBackend {
  try {
    const v = localStorage.getItem('seraphine.llm_backend');
    if (v === 'ollama' || v === 'claude') return v;
  } catch {
    // ignore
  }
  return 'ollama';
}

export function OnboardingFlow({ onComplete }: Props): JSX.Element {
  const [step, setStep] = useState<Step>('welcome');
  const [name, setName] = useState<string>(readInitialName);
  const [llmBackend, setLlmBackend] = useState<LlmBackend>(readInitialBackend);

  // Lock body scroll while the overlay is visible.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const commitSetup = (): void => {
    try {
      const trimmed = name.trim();
      if (trimmed) {
        localStorage.setItem('seraphine.user_name', trimmed);
      }
      // FAKE selector — see file header TODO.
      localStorage.setItem('seraphine.llm_backend', llmBackend);
    } catch {
      // localStorage unavailable — advance anyway; gate in App handles
      // permanent-skip so user isn't trapped.
    }
  };

  const handleComplete = (): void => {
    commitSetup();
    onComplete();
  };

  const stepIndex = STEPS.indexOf(step);

  return (
    <div
      className="onboarding-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="onboarding-card">
        {step === 'welcome' && (
          <WelcomeStep onNext={() => setStep('setup')} />
        )}
        {step === 'setup' && (
          <SetupStep
            name={name}
            onNameChange={setName}
            llmBackend={llmBackend}
            onLlmBackendChange={setLlmBackend}
            onBack={() => setStep('welcome')}
            onNext={() => {
              commitSetup();
              setStep('done');
            }}
          />
        )}
        {step === 'done' && (
          <DoneStep
            onBack={() => setStep('setup')}
            onComplete={handleComplete}
          />
        )}

        <div
          className="onboarding-indicator"
          role="tablist"
          aria-label="Progresso"
        >
          {STEPS.map((s, i) => (
            <span
              key={s}
              className={
                'onboarding-indicator__dot' +
                (i === stepIndex ? ' is-active' : '') +
                (i < stepIndex ? ' is-done' : '')
              }
              aria-current={i === stepIndex ? 'step' : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
