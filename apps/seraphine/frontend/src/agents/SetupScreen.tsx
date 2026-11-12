/**
 * "Primeiros passos" (phase 6a, contract 8.1): three steps with a rail on the left (what is left, progress, the steps),
 * the content in the centre and a preview on the right. The step comes from the real data (`setup.steps`), the owner can go back.
 */
import { useState } from 'react';
import { Notice } from './components';
import { EngineList } from './EngineRows';
import { TickIcon } from './icons';
import { engineLabel } from './lib';
import { SeraphineSays, TeamBuilder } from './TeamBuilder';
import {
  AREA_LABELS,
  GUIDE_SENTENCES,
  SCREEN_STEPS,
  SETUP_STEP_LABELS,
  buildEngineRows,
  currentSetupStep,
  defaultRowId,
  remainingLabel,
  screenStepsDone,
  stepDone,
} from './setup';
import type { EngineRow, ScreenStep } from './setup';
import { useAgentsStore } from './store';
import { SETUP_AREAS } from './types';

const WAITING_PREVIEW = 'Aqui vai aparecer a lista dos agentes que você vai ter. Ainda não escolhi nenhum.';

function AreasStep({ onNext }: { onNext: () => void }): JSX.Element {
  const setup = useAgentsStore((s) => s.setup);
  const saveSetup = useAgentsStore((s) => s.saveSetup);
  const [chosen, setChosen] = useState<string[]>(setup?.areas ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string): void => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const save = async (patch: { areas: string[] } | { areas_skipped: true }): Promise<void> => {
    setBusy(true);
    setError(null);
    const res = await saveSetup(patch);
    setBusy(false);
    if (res.ok) onNext();
    else setError(res.error ?? 'Não consegui guardar a sua escolha. Tente de novo.');
  };

  return (
    <div className="a-step-body">
      <p className="a-hint">Pode escolher mais de uma. Isso só ajuda a Seraphine a mostrar primeiro os times que combinam com você.</p>
      <div className="a-chips" role="group" aria-label="Áreas de ajuda">
        {SETUP_AREAS.map((id) => {
          const on = chosen.includes(id);
          return (
            <button key={id} type="button" className={`a-chip-btn${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(id)}>
              {on && <TickIcon size={14} />}
              {AREA_LABELS[id]}
            </button>
          );
        })}
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="a-actions">
        <button
          type="button"
          className="a-btn a-btn--primary"
          disabled={busy || chosen.length === 0}
          onClick={() => void save({ areas: SETUP_AREAS.filter((a) => chosen.includes(a)) })}
        >
          Continuar
        </button>
        <button type="button" className="a-btn a-btn--ghost" disabled={busy} onClick={() => void save({ areas_skipped: true })}>
          Pular esta etapa
        </button>
      </div>
    </div>
  );
}

function EngineStep({ onNext }: { onNext: () => void }): JSX.Element {
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const setup = useAgentsStore((s) => s.setup);
  const saveSetup = useAgentsStore((s) => s.saveSetup);
  const recheck = useAgentsStore((s) => s.recheckEngines);
  const rows = buildEngineRows(engines, providers);
  const [picked, setPicked] = useState<EngineRow['id'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = picked && rows.find((r) => r.id === picked)?.ready ? picked : defaultRowId(rows, setup?.default_engine);
  const row = rows.find((r) => r.id === chosen);

  const save = async (): Promise<void> => {
    if (!row) return;
    setBusy(true);
    setError(null);
    const res = await saveSetup({ default_engine: { engine: row.choice.engine, provider: row.choice.provider, model: null } });
    setBusy(false);
    if (res.ok) onNext();
    else setError(res.error ?? 'Não consegui guardar o motor. Tente de novo.');
  };

  return (
    <div className="a-step-body">
      <p className="a-hint">Os agentes precisam de um motor para pensar. Use o plano que você já tem; nada é cobrado por aqui.</p>
      <EngineList rows={rows} chosen={chosen} onPick={setPicked} />
      <p className="a-hint">Agentes que só conversam (modelos locais e chaves de API) não usam as ferramentas da Seraphine.</p>
      {error && <Notice>{error}</Notice>}
      <div className="a-actions">
        <button type="button" className="a-btn a-btn--primary" disabled={busy || !row} onClick={() => void save()}>
          Continuar
        </button>
        <button type="button" className="a-btn a-btn--ghost" disabled={busy} onClick={onNext}>
          Conectar depois
        </button>
        <button type="button" className="a-link" onClick={() => void recheck()}>
          Verificar de novo
        </button>
      </div>
      {!row && <p className="a-hint">Sem um motor pronto, os agentes são criados, mas só respondem depois que você conectar um.</p>}
    </div>
  );
}

/** What the right-hand side shows in steps 1 and 2: the space as it is going to be. */
function Preview(): JSX.Element {
  const setup = useAgentsStore((s) => s.setup);
  const areas = setup?.areas ?? [];
  return (
    <aside className="a-card a-preview" aria-label="Prévia do seu espaço">
      <p className="a-eyebrow">PRÉVIA DO SEU ESPAÇO</p>
      <h2 className="a-preview__title">Seus agentes</h2>
      <p className="a-empty">{WAITING_PREVIEW}</p>
      {areas.length > 0 && (
        <p className="a-hint">
          Áreas escolhidas: {areas.map((a) => AREA_LABELS[a] ?? a).join(', ')}.
        </p>
      )}
      {setup?.default_engine && <p className="a-hint">Motor padrão: {engineLabel(setup.default_engine.engine)}.</p>}
    </aside>
  );
}

export function SetupScreen(): JSX.Element {
  const setup = useAgentsStore((s) => s.setup);
  const agents = useAgentsStore((s) => s.agents);
  const navigate = useAgentsStore((s) => s.navigate);
  const saveSetup = useAgentsStore((s) => s.saveSetup);
  const openAgentConversation = useAgentsStore((s) => s.openAgentConversation);
  const [view, setView] = useState<ScreenStep | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);

  if (!setup) {
    return (
      <div className="a-page">
        <p className="a-empty" role="status">
          Carregando os primeiros passos…
        </p>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'home' })}>
          Voltar ao início
        </button>
      </div>
    );
  }

  const derived = currentSetupStep(setup.steps);
  const step = view ?? derived;
  const index = SCREEN_STEPS.indexOf(step);
  const doneCount = screenStepsDone(setup.steps);
  const remaining = SCREEN_STEPS.length - doneCount;
  const goNext = (): void => setView(SCREEN_STEPS[Math.min(index + 1, SCREEN_STEPS.length - 1)]);

  const dismiss = async (): Promise<void> => {
    setDismissError(null);
    const res = await saveSetup({ dismissed: true });
    if (res.ok) navigate({ screen: 'home' });
    else setDismissError(res.error ?? 'Não consegui guardar. Tente de novo.');
  };

  const firstAgent = agents[0];

  return (
    <div className="a-page a-setup">
      <header className="a-header">
        <div className="a-header__text">
          <h1>Primeiros passos</h1>
          <span>Três passos curtos para deixar o seu espaço de agentes pronto.</span>
        </div>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => void dismiss()}>
          Agora não
        </button>
      </header>
      {dismissError && <Notice>{dismissError}</Notice>}

      <div className={`a-setup__grid${step === 'agents' ? ' is-wide' : ''}`}>
        <nav className="a-setup__rail" aria-label="Etapas">
          <div className="a-setup__progress">
            <div className="a-setup__count">
              <strong>{remainingLabel(remaining)}</strong>
              <span>{`${doneCount} de 3`}</span>
            </div>
            <div
              className="a-bar"
              role="progressbar"
              aria-label="Progresso dos primeiros passos"
              aria-valuemin={0}
              aria-valuemax={3}
              aria-valuenow={doneCount}
              aria-valuetext={`${doneCount} de 3`}
            >
              <span className="a-bar__fill" style={{ width: `${Math.round((doneCount / 3) * 100)}%` }} />
            </div>
          </div>
          <ol className="a-setup__steps">
            {SCREEN_STEPS.map((id, i) => {
              const done = stepDone(setup.steps, id);
              const current = id === step;
              const reachable = done || current || i < index;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`a-setup__step${current ? ' is-current' : ''}${done ? ' is-done' : ''}`}
                    aria-current={current ? 'step' : undefined}
                    disabled={!reachable}
                    onClick={() => setView(id)}
                  >
                    <span className="a-setup__mark" aria-hidden="true">
                      {done ? <TickIcon size={14} /> : i + 1}
                    </span>
                    <span className="a-setup__label">
                      {SETUP_STEP_LABELS[id]}
                      <small>{done ? 'Feito' : current ? 'Agora' : 'Falta'}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <SeraphineSays>{GUIDE_SENTENCES[step]}</SeraphineSays>
        </nav>

        {step !== 'agents' ? (
          <>
            <section className="a-setup__main" aria-labelledby="setup-step-title">
              {index > 0 && (
                <button type="button" className="a-link" onClick={() => setView(SCREEN_STEPS[index - 1])}>
                  Voltar
                </button>
              )}
              <p className="a-eyebrow">
                PASSO {index + 1} DE 3
              </p>
              <h2 className="a-setup__title" id="setup-step-title">
                {SETUP_STEP_LABELS[step]}
              </h2>
              {step === 'areas' ? <AreasStep onNext={goNext} /> : <EngineStep onNext={goNext} />}
            </section>
            <Preview />
          </>
        ) : (
          <section className="a-setup__main a-setup__main--wide" aria-labelledby="setup-step-title">
            <button type="button" className="a-link" onClick={() => setView('engine')}>
              Voltar
            </button>
            <p className="a-eyebrow">PASSO 3 DE 3</p>
            <h2 className="a-setup__title" id="setup-step-title">
              {SETUP_STEP_LABELS.agents}
            </h2>
            {firstAgent && (
              <div className="a-card a-setup__next">
                <span>
                  Você já tem {agents.length === 1 ? 'um agente' : `${agents.length} agentes`}. Falta só a primeira conversa.
                </span>
                <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => void openAgentConversation(firstAgent.id)}>
                  Conversar com {firstAgent.name}
                </button>
              </div>
            )}
            <TeamBuilder variant="setup" onBlank={() => navigate({ screen: 'roster', newAgent: true })} />
          </section>
        )}
      </div>
    </div>
  );
}
