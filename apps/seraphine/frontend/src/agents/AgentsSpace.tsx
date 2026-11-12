/** Root of `activeView === 'agents'`: renders the screen picked by the store route. */
import './agents.css';
import { useEffect } from 'react';
import { useAgentsStore } from './store';
import { ConnectionBand } from './components';
import { GuideScreen } from './GuideScreen';
import { HomeScreen } from './HomeScreen';
import { ProjectScreen } from './ProjectScreen';
import { RosterScreen } from './RosterScreen';
import { RoutinesScreen } from './RoutinesScreen';
import { SettingsScreen } from './SettingsScreen';
import { SetupScreen } from './SetupScreen';
import { TaskScreen } from './TaskScreen';
import { TeamDialog } from './TeamBuilder';

export function DisabledPanel({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="a-state-panel">
      <h1>O harness de agentes está desligado</h1>
      <p>
        Para ligar, adicione <code>SERAPHINE_AGENTS_ENABLED=true</code> ao arquivo .env do backend e reinicie a
        Seraphine.
      </p>
      <button type="button" className="a-btn a-btn--primary" onClick={onRetry}>
        Tentar de novo
      </button>
    </div>
  );
}

export function AgentsSpace(): JSX.Element {
  const harnessState = useAgentsStore((s) => s.harnessState);
  const error = useAgentsStore((s) => s.error);
  const route = useAgentsStore((s) => s.route);
  const init = useAgentsStore((s) => s.init);
  const retry = useAgentsStore((s) => s.retry);
  const setup = useAgentsStore((s) => s.setup);
  const setupState = useAgentsStore((s) => s.setupState);
  const setupAutoOpened = useAgentsStore((s) => s.setupAutoOpened);
  const agentCount = useAgentsStore((s) => s.agents.length);
  const builderOpen = useAgentsStore((s) => s.builderOpen);
  const closeBuilder = useAgentsStore((s) => s.closeBuilder);
  const navigate = useAgentsStore((s) => s.navigate);

  useEffect(() => {
    void init();
  }, [init]);

  // First steps open by themselves, once: the harness is ready, there is no agent yet and the owner did not say "agora não".
  useEffect(() => {
    if (harnessState !== 'ready' || setupAutoOpened) return;
    if (setupState === 'unavailable') {
      useAgentsStore.getState().markSetupAutoOpened();
      return;
    }
    if (setupState !== 'ready' || !setup) return;
    useAgentsStore.getState().markSetupAutoOpened();
    if (agentCount === 0 && !setup.dismissed && useAgentsStore.getState().route.screen === 'home') navigate({ screen: 'setup' });
  }, [harnessState, setupState, setup, setupAutoOpened, agentCount, navigate]);

  let body: JSX.Element;
  if (harnessState === 'loading') {
    body = (
      <div className="a-state-panel" role="status">
        <p>Carregando os agentes…</p>
      </div>
    );
  } else if (harnessState === 'disabled') {
    body = <DisabledPanel onRetry={() => void retry()} />;
  } else if (harnessState === 'error') {
    body = (
      <div className="a-state-panel">
        <h1>Não consegui falar com os agentes</h1>
        <p>{error ?? 'Algo deu errado ao carregar.'}</p>
        <button type="button" className="a-btn a-btn--primary" onClick={() => void retry()}>
          Tentar de novo
        </button>
      </div>
    );
  } else if (route.screen === 'project' && route.projectId) {
    body = <ProjectScreen key={route.projectId} projectId={route.projectId} />;
  } else if (route.screen === 'task' && route.taskId) {
    body = <TaskScreen key={route.taskId} taskId={route.taskId} />;
  } else if (route.screen === 'setup') {
    body = <SetupScreen />;
  } else if (route.screen === 'settings') {
    body = <SettingsScreen />;
  } else if (route.screen === 'roster') {
    body = <RosterScreen />;
  } else if (route.screen === 'routines') {
    body = <RoutinesScreen />;
  } else if (route.screen === 'guide') {
    body = <GuideScreen />;
  } else {
    body = <HomeScreen />;
  }

  return (
    <div className="agents-space">
      {harnessState === 'ready' && <ConnectionBand />}
      {body}
      {harnessState === 'ready' && builderOpen && (
        <TeamDialog
          onClose={closeBuilder}
          onBlank={() => {
            closeBuilder();
            navigate({ screen: 'roster', newAgent: true });
          }}
        />
      )}
    </div>
  );
}
