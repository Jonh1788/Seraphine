/**
 * "Histórico" of an agent's form (phase 6c part 1, contract 4.2): the versions of the five texts, who changed them and when,
 * "Ver o que mudou" (before and after against the version below it in the list) and "Voltar para esta versão".
 * Collapsed, and loaded only when the owner opens it. A backend without the route hides the whole section.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Notice } from './components';
import { ChevronDownIcon } from './icons';
import { FieldDiff } from './guideBits';
import { changedByWords, changedFieldsLine, versionDiffRows } from './guide';
import { humanWhen } from './routines';
import { useAgentsStore } from './store';
import type { Agent, AgentVersion } from './types';
import { useConfirm } from '../ui';

function VersionRow({
  version,
  previous,
  current,
  busy,
  onRestore,
}: {
  version: AgentVersion;
  previous: AgentVersion | null;
  current: boolean;
  busy: boolean;
  onRestore: () => void;
}): JSX.Element {
  const [showDiff, setShowDiff] = useState(false);
  const diffId = useId();
  const titleId = useId();
  const rows = versionDiffRows(version, previous);
  const fields = changedFieldsLine(version.changed_fields);
  return (
    <li className="a-card a-version" aria-labelledby={titleId}>
      <header className="a-version__head">
        <strong id={titleId}>Versão {version.version}</strong>
        {current && <span className="a-chip a-prop-chip a-prop-chip--ok">Atual</span>}
      </header>
      <ul className="a-version__facts">
        <li>Quem mudou: {changedByWords(version.changed_by)}</li>
        <li>Quando: {humanWhen(version.created_at)}</li>
        {fields && <li>{fields}</li>}
        {version.note && <li>{version.note}</li>}
      </ul>
      <div className="a-actions">
        <button type="button" className="a-link" aria-expanded={showDiff} aria-controls={showDiff ? diffId : undefined} onClick={() => setShowDiff((v) => !v)}>
          Ver o que mudou
        </button>
        {!current && (
          <button type="button" className="a-btn a-btn--small a-btn--ghost" disabled={busy} onClick={onRestore}>
            Voltar para esta versão
          </button>
        )}
      </div>
      {showDiff && (
        <div className="a-diffs" id={diffId}>
          {!previous ? (
            <p className="a-hint">Esta é a primeira versão guardada: não há uma anterior para comparar.</p>
          ) : rows.length === 0 ? (
            <p className="a-hint">Nenhum dos textos mudou nesta versão.</p>
          ) : (
            rows.map((row) => <FieldDiff key={row.key} row={row} />)
          )}
        </div>
      )}
    </li>
  );
}

export function HistorySection({
  agent,
  unsaved,
  startOpen = false,
  onRestored,
}: {
  agent: Agent;
  /** The form has typed text that is not saved yet: a restore replaces it (the confirmation says so). */
  unsaved: boolean;
  startOpen?: boolean;
  /** The agent as the backend returned it after the restore: the form refills with its texts. */
  onRestored: (agent: Agent) => void;
}): JSX.Element | null {
  const unavailable = useAgentsStore((s) => s.versionsUnavailable);
  const loadVersions = useAgentsStore((s) => s.loadAgentVersions);
  const restore = useAgentsStore((s) => s.restoreAgentVersion);
  const confirm = useConfirm();
  const [open, setOpen] = useState(startOpen);
  const [versions, setVersions] = useState<AgentVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const inFlight = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const listId = useId();

  /** `keepError`: a refresh after a refusal, which must not wipe the sentence that explains the refusal. */
  const load = async (keepError = false): Promise<void> => {
    if (!keepError) setError(null);
    const res = await loadVersions(agent.id);
    if (res.ok && res.versions) setVersions(res.versions);
    else if (res.error) setError(res.error);
  };

  // Loaded only when the section is opened (and again when another agent's form takes this place).
  useEffect(() => {
    if (open && versions === null) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent.id]);

  useEffect(() => {
    if (startOpen) sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [startOpen]);

  if (unavailable) return null;

  const onRestore = async (v: AgentVersion): Promise<void> => {
    if (inFlight.current) return;
    const ok = await confirm({
      title: `Voltar para a versão ${v.version}`,
      message:
        `O nome, o papel, a descrição, as instruções e as sugestões de ${agent.name} voltam a ser como eram na versão ${v.version}. ` +
        `O texto de hoje continua no histórico.${unsaved ? ' O que você digitou nesses campos e ainda não salvou será trocado.' : ''}`,
      confirmLabel: 'Voltar para esta versão',
    });
    if (!ok) return;
    inFlight.current = true;
    setRestoring(v.version);
    setError(null);
    setNote(null);
    const res = await restore(agent.id, v.version);
    inFlight.current = false;
    setRestoring(null);
    if (!res.ok || !res.agent) {
      setError(res.error ?? 'Não consegui voltar para essa versão agora. Tente de novo.');
      // Already the current text (changed elsewhere): the list is out of date.
      if (res.code === 'version_current') void load(true);
      return;
    }
    setNote(`Voltei para a versão ${v.version}. O formulário já mostra o texto dela.`);
    onRestored(res.agent);
    void load();
  };

  return (
    <section className="a-history" ref={sectionRef} aria-label="Histórico do agente">
      <button type="button" className="a-history__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon className={`a-steps__chev${open ? ' is-open' : ''}`} /> Histórico
      </button>
      <div role="status" aria-live="polite" className="a-history__live">
        {note && <p className="a-notice a-notice--info">{note}</p>}
      </div>
      {open && (
        <div id={listId} className="a-history__body">
          <p className="a-hint">Cada vez que o nome, o papel, a descrição, as instruções ou as sugestões mudam, a versão fica guardada aqui.</p>
          {error && <Notice>{error}</Notice>}
          {versions === null && !error && <p className="a-hint">Carregando o histórico…</p>}
          {versions !== null && versions.length === 0 && <p className="a-hint">Ainda não há versões guardadas.</p>}
          {versions !== null && versions.length > 0 && (
            <ul className="a-list a-versions">
              {versions.map((v, i) => (
                <VersionRow
                  key={v.version}
                  version={v}
                  previous={versions[i + 1] ?? null}
                  current={i === 0}
                  busy={restoring !== null}
                  onRestore={() => void onRestore(v)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
