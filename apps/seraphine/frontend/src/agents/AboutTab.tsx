/**
 * The "Sobre" tab of an agent (phase 6c part 2, contract 5.1): what it does, its engine, its access in words, its folder, routines,
 * activity, version and the actions (adjust, ask the Seraphine, pause, archive, delete). Everything comes from the page route.
 */
import { useEffect, useState } from 'react';
import { Notice, SectionTitle } from './components';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { EngineChip } from './engineChip';
import { FolderIcon } from './icons';
import { aboutAgentPrefill } from './guide';
import { accessLine, archiveMessage, copyOkSentence, COPY_FALLBACK, formatCount, lastRunText } from './agentPage';
import { engineUsesTools } from './lib';
import { humanWhen } from './routines';
import { useAgentsStore } from './store';
import type { Agent } from './types';
import { useConfirm } from '../ui';

export function AboutTab({ agent, onOpenRoutines }: { agent: Agent; onOpenRoutines?: () => void }): JSX.Element {
  const page = useAgentsStore((s) => s.agentPages[agent.id]);
  const engines = useAgentsStore((s) => s.engines);
  const loadAgentPage = useAgentsStore((s) => s.loadAgentPage);
  const setAgentPaused = useAgentsStore((s) => s.setAgentPaused);
  const archiveAgent = useAgentsStore((s) => s.archiveAgent);
  const navigate = useAgentsStore((s) => s.navigate);
  const guideAvailable = useAgentsStore((s) => s.guideState !== 'unavailable');
  const versionsUnavailable = useAgentsStore((s) => s.versionsUnavailable);
  const confirm = useConfirm();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'pause' | 'archive' | null>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Loaded when the tab opens (it mounts only while it is the tab in view).
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    void loadAgentPage(agent.id).then((res) => {
      if (alive && !res.ok && res.error) setLoadError(res.error);
    });
    return () => {
      alive = false;
    };
  }, [agent.id, loadAgentPage]);

  const reload = (): void => {
    void loadAgentPage(agent.id);
  };

  const togglePause = async (): Promise<void> => {
    setBusy('pause');
    setActionError(null);
    const res = await setAgentPaused(agent.id, agent.enabled);
    setBusy(null);
    if (!res.ok) setActionError(res.error ?? 'Não consegui fazer isso agora. Tente de novo.');
    else reload();
  };

  const archive = async (): Promise<void> => {
    const ok = await confirm({
      title: `Arquivar ${agent.name}`,
      message: archiveMessage(agent.name),
      confirmLabel: 'Arquivar',
      variant: 'danger',
    });
    if (!ok) return;
    setBusy('archive');
    setActionError(null);
    const res = await archiveAgent(agent.id);
    setBusy(null);
    if (res.ok) navigate({ screen: 'home' });
    else setActionError(res.error ?? 'Não consegui arquivar agora. Tente de novo.');
  };

  const copyPath = async (path: string): Promise<void> => {
    setCopied(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(path);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  };

  if (!page) {
    return (
      <div className="a-about" id="about-body">
        {loadError ? <Notice>{loadError}</Notice> : <p className="a-empty" role="status">Carregando a página de {agent.name}…</p>}
        {loadError && (
          <button type="button" className="a-btn a-btn--ghost" onClick={reload}>
            Tentar de novo
          </button>
        )}
      </div>
    );
  }

  const def = page.def;
  const usesTools = engineUsesTools(def.engine, engines);
  const now = new Date();
  const path = page.home?.path ?? '';
  const routines = page.routines;
  const next = routines.next_run_at ? humanWhen(routines.next_run_at, now) : '';

  return (
    <div className="a-about">
      <section className="a-card a-about__block" aria-labelledby="about-what">
        <SectionTitle id="about-what">O QUE FAZ</SectionTitle>
        <p>{def.description || 'Ainda sem uma descrição.'}</p>
        <p className="a-hint">Papel: {def.role || 'não definido'}</p>
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-engine">
        <SectionTitle id="about-engine">MOTOR</SectionTitle>
        <p className="a-about__row">
          <strong>{page.engine.label}</strong>
          <EngineChip ready={page.engine.ready} word={page.engine.ready ? 'Pronto' : 'Sem motor'} how={page.engine.how} />
        </p>
        {!page.engine.ready && page.engine.how && <p className="a-hint">{page.engine.how}</p>}
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-access">
        <SectionTitle id="about-access">ACESSO ÀS FERRAMENTAS</SectionTitle>
        {!usesTools ? (
          <p>Só conversa: sem ferramentas da Seraphine.</p>
        ) : page.access.length === 0 ? (
          <p className="a-hint">Nenhum grupo de ferramentas para mostrar.</p>
        ) : (
          <ul className="a-bullets" aria-label="Acesso por grupo">
            {page.access.map((a) => (
              <li key={a.group}>{accessLine(a.label, a.level)}</li>
            ))}
          </ul>
        )}
        <div className="a-actions">
          <button type="button" className="a-link" onClick={() => navigate({ screen: 'settings', settingsTab: 'access', agentId: agent.id })}>
            Mudar o acesso
          </button>
        </div>
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-folder">
        <SectionTitle id="about-folder">PASTA</SectionTitle>
        {path ? (
          <>
            <p className="a-path">
              <FolderIcon /> <code>{path}</code>
            </p>
            <div className="a-actions">
              <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => void copyPath(path)}>
                Copiar
              </button>
              <span className="a-hint" role="status">
                {copied === 'ok' ? copyOkSentence() : copied === 'fail' ? COPY_FALLBACK : ''}
              </span>
            </div>
          </>
        ) : (
          <p className="a-hint">A pasta é criada na primeira conversa.</p>
        )}
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-routines">
        <SectionTitle id="about-routines">ROTINAS</SectionTitle>
        <p>
          {routines.total === 0
            ? 'Nenhuma rotina ainda.'
            : `${routines.total} ${routines.total === 1 ? 'rotina' : 'rotinas'}, ${routines.active} ${routines.active === 1 ? 'ativa' : 'ativas'}.`}
          {next ? ` Próxima: ${next}.` : ''}
        </p>
        {onOpenRoutines && (
          <div className="a-actions">
            <button type="button" className="a-link" onClick={onOpenRoutines}>
              Ver as rotinas
            </button>
          </div>
        )}
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-activity">
        <SectionTitle id="about-activity">ATIVIDADE</SectionTitle>
        <p>
          {page.activity.runs === 0
            ? 'Ainda sem execuções.'
            : `${formatCount(page.activity.runs)} ${page.activity.runs === 1 ? 'execução' : 'execuções'}. Última vez: ${lastRunText(page.activity.last_run_at)}.`}
        </p>
        <p className="a-hint">
          Tokens: {formatCount(page.activity.tokens_in)} de entrada e {formatCount(page.activity.tokens_out)} de saída.
        </p>
      </section>

      <section className="a-card a-about__block" aria-labelledby="about-version">
        <SectionTitle id="about-version">VERSÃO</SectionTitle>
        <p>{def.version > 0 ? `Versão ${def.version}` : 'Nenhuma alteração guardada ainda.'}</p>
        {!versionsUnavailable && (
          <div className="a-actions">
            <button type="button" className="a-link" onClick={() => navigate({ screen: 'roster', agentId: agent.id, section: 'history' })}>
              Ver o histórico
            </button>
          </div>
        )}
      </section>

      <section className="a-about__actions" aria-label={`Ações de ${agent.name}`}>
        {actionError && <Notice>{actionError}</Notice>}
        <div className="a-actions">
          <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'roster', agentId: agent.id })}>
            Ajustar
          </button>
          {guideAvailable && (
            <button
              type="button"
              className="a-btn a-btn--ghost"
              onClick={() => navigate({ screen: 'guide', about: { agent_id: agent.id }, prefill: aboutAgentPrefill(agent.name) })}
            >
              Pedir à Seraphine
            </button>
          )}
          <button type="button" className="a-btn a-btn--ghost" disabled={busy !== null} onClick={() => void togglePause()}>
            {agent.enabled ? 'Pausar' : 'Retomar'}
          </button>
          <button type="button" className="a-btn a-btn--ghost" disabled={busy !== null} onClick={() => void archive()}>
            Arquivar
          </button>
          <button type="button" className="a-btn a-btn--danger" disabled={busy !== null} onClick={() => setDeleting(true)}>
            Apagar
          </button>
        </div>
        {!agent.enabled && <p className="a-hint">{agent.name} está pausado: não responde e as rotinas dele são puladas até você retomar.</p>}
      </section>

      {deleting && (
        <DeleteAgentDialog
          agentId={agent.id}
          name={agent.name}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            setDeleting(false);
            navigate({ screen: 'home' });
          }}
        />
      )}
    </div>
  );
}
