/**
 * "Ajustes" of the agents space (phase 6c part 2, contract 5.4): three tabs. "IA e uso" (engines and usage), "Ferramentas e acesso"
 * (who may use what) and "Espaço" (the folder, the first steps, the conversation with the Seraphine).
 */
import { useEffect, useState } from 'react';
import { AccessTable } from './AccessTable';
import { Notice, SectionTitle } from './components';
import { EngineList } from './EngineRows';
import { UsagePanel } from './UsagePanel';
import { buildEngineRows, defaultRowId, engineChoiceLabel } from './setup';
import type { EngineRow } from './setup';
import { useAgentsStore } from './store';
import type { SettingsTab } from './store';
import { FolderIcon } from './icons';
import { useConfirm } from '../ui';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'ai', label: 'IA e uso' },
  { id: 'access', label: 'Ferramentas e acesso' },
  { id: 'space', label: 'Espaço' },
];

function EnginesSection(): JSX.Element {
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const setup = useAgentsStore((s) => s.setup);
  const setupState = useAgentsStore((s) => s.setupState);
  const saveSetup = useAgentsStore((s) => s.saveSetup);
  const recheck = useAgentsStore((s) => s.recheckEngines);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = buildEngineRows(engines, providers);
  const chosen = defaultRowId(rows, setup?.default_engine);
  // A backend without the first-steps route cannot keep a default: the rows then have no choice.
  const canPick = setupState !== 'unavailable';

  const pick = async (id: EngineRow['id']): Promise<void> => {
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    setError(null);
    setSaved(null);
    const res = await saveSetup({ default_engine: { engine: row.choice.engine, provider: row.choice.provider, model: null } });
    if (res.ok) setSaved(`Motor padrão: ${engineChoiceLabel(row.choice.engine, row.choice.provider, providers)}.`);
    else setError(res.error ?? 'Não consegui guardar o motor. Tente de novo.');
  };

  return (
    <section className="a-section" aria-labelledby="engines-title">
      <SectionTitle id="engines-title">MOTORES</SectionTitle>
      <p className="a-hint">Os agentes precisam de um motor para pensar. Use o plano que você já tem; nada é cobrado por aqui.</p>
      <EngineList rows={rows} chosen={chosen} onPick={canPick ? (id) => void pick(id) : undefined} />
      <p className="a-hint">Agentes que só conversam (modelos locais e chaves de API) não usam as ferramentas da Seraphine.</p>
      {error && <Notice>{error}</Notice>}
      {saved && <Notice tone="info">{saved}</Notice>}
      <div className="a-actions">
        <button type="button" className="a-link" onClick={() => void recheck()}>
          Verificar de novo
        </button>
      </div>
    </section>
  );
}

function SpaceSection(): JSX.Element {
  const setup = useAgentsStore((s) => s.setup);
  const setupState = useAgentsStore((s) => s.setupState);
  const guideAvailable = useAgentsStore((s) => s.guideState !== 'unavailable');
  const clearGuide = useAgentsStore((s) => s.clearGuide);
  const navigate = useAgentsStore((s) => s.navigate);
  const confirm = useConfirm();
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  const clear = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Limpar a conversa',
      message: 'Apagar as mensagens e as propostas que ainda não foram aplicadas? O que já foi aplicado continua no histórico dos agentes.',
      confirmLabel: 'Limpar conversa',
      variant: 'danger',
    });
    if (!ok) return;
    setMessage(null);
    const res = await clearGuide();
    setMessage(res.ok ? { tone: 'info', text: 'A conversa com a Seraphine foi limpa.' } : { tone: 'error', text: res.error ?? 'Não consegui limpar a conversa agora. Tente de novo.' });
  };

  return (
    <div className="a-stack">
      <section className="a-card a-about__block" aria-labelledby="space-folder">
        <SectionTitle id="space-folder">PASTA DOS AGENTES</SectionTitle>
        {setup?.home_dir ? (
          <>
            <p className="a-path">
              <FolderIcon /> <code>{setup.home_dir}</code>
            </p>
            <p className="a-hint">Cada agente ganha uma pasta própria aqui dentro.</p>
          </>
        ) : (
          <p className="a-hint">Cada agente ganha uma pasta própria dentro da pasta de agentes da Seraphine.</p>
        )}
      </section>

      {setupState !== 'unavailable' && (
        <section className="a-card a-about__block" aria-labelledby="space-steps">
          <SectionTitle id="space-steps">PRIMEIROS PASSOS</SectionTitle>
          <p className="a-hint">Volte ao passo a passo para escolher áreas, conectar um motor ou montar um time.</p>
          <div className="a-actions">
            <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'setup' })}>
              Rever os primeiros passos
            </button>
          </div>
        </section>
      )}

      {guideAvailable && (
        <section className="a-card a-about__block" aria-labelledby="space-guide">
          <SectionTitle id="space-guide">CONVERSA COM A SERAPHINE</SectionTitle>
          <p className="a-hint">Apaga as mensagens e as propostas ainda não aplicadas. O que já foi aplicado continua no histórico dos agentes.</p>
          <div className="a-actions">
            <button type="button" className="a-btn a-btn--danger" onClick={() => void clear()}>
              Limpar a conversa com a Seraphine
            </button>
          </div>
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </section>
      )}
    </div>
  );
}

export function SettingsScreen(): JSX.Element {
  const routeTab = useAgentsStore((s) => s.route.settingsTab);
  const highlight = useAgentsStore((s) => s.route.agentId);
  const [tab, setTab] = useState<SettingsTab>(routeTab ?? 'ai');

  // A shortcut ("Mudar o acesso", "Conectar um motor") asks for a section while the screen is already open.
  useEffect(() => {
    if (routeTab) setTab(routeTab);
  }, [routeTab, highlight]);

  const onKey = (e: React.KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (at + step + TABS.length) % TABS.length;
    setTab(TABS[next].id);
    requestAnimationFrame(() => document.getElementById(`settings-tab-${TABS[next].id}`)?.focus());
  };

  return (
    <div className="a-page">
      <header className="a-header">
        <div className="a-header__text">
          <h1>Ajustes</h1>
          <span>Motores, uso, acesso às ferramentas e a pasta dos seus agentes.</span>
        </div>
        <div className="a-tabs" role="tablist" aria-label="Seções dos ajustes" onKeyDown={onKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`a-tab${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <section id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="a-settings">
        {tab === 'ai' && (
          <>
            <EnginesSection />
            <UsagePanel />
          </>
        )}
        {tab === 'access' && <AccessTable highlightAgentId={routeTab === 'access' ? highlight : undefined} />}
        {tab === 'space' && <SpaceSection />}
      </section>
    </div>
  );
}
