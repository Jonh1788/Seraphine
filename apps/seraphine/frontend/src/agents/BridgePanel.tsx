/**
 * "Ferramentas da Seraphine nos agentes" (step 3c): whether the Seraphine's tools reach each engine, in words, and a test
 * button per engine. A test is a real, short turn of the engine, so the help text says it uses a little of the owner's plan.
 */
import { useEffect, useId } from 'react';
import { useAgentsStore } from './store';
import { SectionTitle } from './components';
import { bridgeStatusLine, bridgeTestHint, engineLabel } from './lib';
import type { BridgeEngineStatus } from './types';

function BridgeRow({ engine }: { engine: BridgeEngineStatus }): JSX.Element {
  const running = useAgentsStore((s) => s.bridgeRunning);
  const result = useAgentsStore((s) => s.bridgeResults[engine.engine]);
  const test = useAgentsStore((s) => s.testBridge);
  const hintId = useId();
  const name = engine.label.trim() || engineLabel(engine.engine);
  const mine = running === engine.engine;
  return (
    <li className="a-bridge__row">
      <div className="a-bridge__text">
        <strong>{name}</strong>
        <span className={`a-bridge__state a-bridge__state--${engine.state}`}>{bridgeStatusLine(engine)}</span>
        <span className="a-bridge__hint" id={hintId}>
          {bridgeTestHint(name)}
        </span>
        {mine && (
          <span className="a-bridge__result" role="status">
            Testando… pode levar até um minuto.
          </span>
        )}
        {!mine && result && (
          <span className={`a-bridge__result a-bridge__result--${result.ok ? 'ok' : 'fail'}`} role="status">
            {result.text}
          </span>
        )}
      </div>
      <button
        type="button"
        className={`a-btn a-btn--ghost${mine ? ' is-busy' : ''}`}
        disabled={running !== null}
        aria-describedby={hintId}
        aria-label={`Testar ${name}`}
        onClick={() => void test(engine.engine)}
      >
        {mine ? 'Testando…' : 'Testar'}
      </button>
    </li>
  );
}

export function BridgePanel(): JSX.Element | null {
  const bridge = useAgentsStore((s) => s.bridge);
  const load = useAgentsStore((s) => s.loadBridge);
  const titleId = useId();

  useEffect(() => {
    void load();
  }, [load]);

  // A backend from before this step has nothing to show.
  if (bridge.state === 'unavailable') return null;
  return (
    <section className="a-section a-bridge" aria-labelledby={titleId}>
      <SectionTitle id={titleId}>FERRAMENTAS DA SERAPHINE NOS AGENTES</SectionTitle>
      <p className="a-hint">Mostra se os agentes que agem no seu computador conseguem usar as suas notas, tarefas e lembretes.</p>
      {bridge.engines.length > 0 ? (
        <ul className="a-bridge__list">
          {bridge.engines.map((e) => (
            <BridgeRow key={e.engine} engine={e} />
          ))}
        </ul>
      ) : (
        <p className="a-hint">
          {bridge.state === 'error' ? (
            <>
              Não consegui ver o estado agora.{' '}
              <button type="button" className="a-link" onClick={() => void load()}>
                Tentar de novo
              </button>
            </>
          ) : (
            'Carregando…'
          )}
        </p>
      )}
    </section>
  );
}
