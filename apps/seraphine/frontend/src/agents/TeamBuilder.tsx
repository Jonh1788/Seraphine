/**
 * "Seus agentes" (phase 6a, contract 8.2): ready teams on the left; on the right the chosen team (or the guide's
 * proposal) as editable cards, the folder line, the approval note, the engine and "Criar meus agentes".
 * `TeamBuilder` is the content (used embedded by the first-steps screen and inside `TeamDialog`).
 * Nothing is created until the owner clicks "Criar meus agentes".
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { AgentTile, Notice } from './components';
import { EngineChip } from './engineChip';
import { TeamUndo } from './TeamUndo';
import { ChevronRightSmallIcon, FolderIcon, ShieldCheckIcon } from './icons';
import { AGENT_COLORS, safeColor } from './lib';
import { SparkIcon } from './setupIcons';
import { LongText } from './guideBits';
import { agentsCountLabel, clampText, engineChoiceLabel, engineState, loweredLine, orderPacks, teamEngine } from './setup';
import { pluralRoutines, scheduleText } from './routines';
import { errorText, useAgentsStore } from './store';
import type { AgentDraft, Pack, RoutineDraft, TeamResult } from './types';
import { DRAFT_LIMITS, GUIDE_TEXT_MAX, TEAM_MAX } from './types';
import seraphineLogo from '../../src-tauri/icons/128x128.png';

const GUIDE_KEY = 'guide';
const NONE_PACK_LABEL = 'Nenhum desses: conte do que você precisa';

/** The Seraphine speaking: the brand mark and a sentence. */
export function SeraphineSays({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="a-says">
      <img src={seraphineLogo} alt="" aria-hidden="true" className="a-says__mark" />
      <p className="a-says__text">{children}</p>
    </div>
  );
}

/** Why a card cannot be created yet ('' when it can): an empty name, or a name already taken (by an agent or by another card). */
function nameProblem(drafts: AgentDraft[], index: number, existing: string[]): string {
  const key = drafts[index].name.trim().toLowerCase();
  if (!key) return 'O nome não pode ficar vazio.';
  if (existing.includes(key)) return 'Já existe um agente com esse nome. Troque o nome para criar.';
  if (drafts.some((d, i) => i !== index && d.name.trim().toLowerCase() === key)) return 'Dois agentes do time estão com o mesmo nome.';
  return '';
}

/** The routines a card offers, each with its "Criar esta rotina" box (checked unless the owner unchecked it). */
export function DraftRoutines({
  routines,
  isOn,
  onToggle,
  readOnly = false,
}: {
  routines: RoutineDraft[];
  isOn?: (routineIndex: number) => boolean;
  onToggle?: (routineIndex: number) => void;
  /** A proposal card of the Seraphine: the lines only show, with no "Criar esta rotina" box. */
  readOnly?: boolean;
}): JSX.Element {
  const base = useId();
  return (
    <section className="a-draft__routines" aria-label="Rotinas deste agente">
      <p className="a-label-text">Rotinas</p>
      <ul className="a-stack">
        {routines.map((r, ri) => {
          const textId = `${base}-${ri}`;
          return (
            <li key={ri} className="a-draft__routine">
              {!readOnly && (
                <label className="a-check">
                  <input type="checkbox" checked={isOn?.(ri) ?? true} aria-describedby={textId} onChange={() => onToggle?.(ri)} />
                  <span>Criar esta rotina</span>
                </label>
              )}
              <span className="a-draft__routine-text" id={textId}>
                <strong>{r.title}</strong>
                <span>{r.schedule_text || scheduleText(r.schedule)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function DraftCard({
  draft,
  index,
  error = '',
  onChange,
  routineOn,
  onToggleRoutine,
  readOnly = false,
}: {
  draft: AgentDraft;
  index: number;
  error?: string;
  onChange?: (patch: Partial<AgentDraft>) => void;
  routineOn?: (routineIndex: number) => boolean;
  onToggleRoutine?: (routineIndex: number) => void;
  /** A proposal card of the Seraphine: name, role, what it does, instructions and routines only show. */
  readOnly?: boolean;
}): JSX.Element {
  const nameId = useId();
  const color = safeColor(draft.color, AGENT_COLORS[index % AGENT_COLORS.length]);
  if (readOnly) {
    return (
      <li className="a-card a-draft a-draft--readonly">
        <div className="a-draft__head">
          <AgentTile name={draft.name || '?'} color={color} />
          <div className="a-draft__who">
            <strong>{draft.name}</strong>
            {draft.role && <span className="a-hint">{draft.role}</span>}
          </div>
        </div>
        {draft.description && <p className="a-draft__about">{draft.description}</p>}
        {draft.instructions && (
          <div className="a-draft__instructions">
            <p className="a-label-text">Instruções</p>
            <LongText text={draft.instructions} />
          </div>
        )}
        {draft.routines && draft.routines.length > 0 && <DraftRoutines routines={draft.routines} readOnly />}
      </li>
    );
  }
  return (
    <li className="a-card a-draft">
      <div className="a-draft__head">
        <AgentTile name={draft.name || '?'} color={color} />
        <label className="a-field a-draft__name">
          <span>Nome</span>
          <input
            className="a-input"
            aria-label={`Nome do agente ${index + 1}`}
            aria-invalid={!!error}
            aria-describedby={error ? nameId : undefined}
            maxLength={DRAFT_LIMITS.name}
            value={draft.name}
            onChange={(e) => onChange?.({ name: clampText(e.target.value, DRAFT_LIMITS.name) })}
          />
        </label>
        <label className="a-field a-draft__role">
          <span>Papel</span>
          <input
            className="a-input"
            aria-label={`Papel do agente ${index + 1}`}
            maxLength={DRAFT_LIMITS.role}
            value={draft.role}
            onChange={(e) => onChange?.({ role: clampText(e.target.value, DRAFT_LIMITS.role) })}
          />
        </label>
      </div>
      {error && (
        <p className="a-field-error" id={nameId}>
          {error}
        </p>
      )}
      <label className="a-field">
        <span>O que ele faz</span>
        <textarea
          className="a-input"
          rows={2}
          aria-label={`Descrição do agente ${index + 1}`}
          maxLength={DRAFT_LIMITS.description}
          value={draft.description}
          onChange={(e) => onChange?.({ description: clampText(e.target.value, DRAFT_LIMITS.description) })}
        />
        <small className="a-draft__count">
          {draft.description.length} de {DRAFT_LIMITS.description} caracteres
        </small>
      </label>
      {draft.routines && draft.routines.length > 0 && <DraftRoutines routines={draft.routines} isOn={routineOn} onToggle={onToggleRoutine} />}
    </li>
  );
}

export function TeamBuilder({
  variant,
  onClose,
  onBlank,
}: {
  variant: 'dialog' | 'setup';
  /** Dialog: closes it ("Cancelar", and after a finished creation). */
  onClose?: () => void;
  /** "Criar um agente do zero": opens the blank form of the roster. */
  onBlank: () => void;
}): JSX.Element {
  const setup = useAgentsStore((s) => s.setup);
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const tools = useAgentsStore((s) => s.tools);
  const existingAgents = useAgentsStore((s) => s.agents);
  const createTeam = useAgentsStore((s) => s.createTeam);
  const navigate = useAgentsStore((s) => s.navigate);

  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'detail'>('list');
  /** Edited copies of the drafts, by team key (a pack id or `guide`). */
  const [edits, setEdits] = useState<Record<string, AgentDraft[]>>({});

  const [text, setText] = useState('');
  const [refine, setRefine] = useState('');
  const [pending, setPending] = useState(false);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const guideBusy = useRef(false);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [result, setResult] = useState<TeamResult | null>(null);
  const teamUndo = useAgentsStore((s) => s.teamUndo);
  /** The creation was undone from this panel: there is no conversation left to open. */
  const undone = !!result?.batch && teamUndo[result.batch.id]?.phase === 'done';
  /** Routines the owner unchecked, by `team:agent:routine` (everything is checked by default). */
  const [skipped, setSkipped] = useState<Record<string, true>>({});
  /** How many routines were sent in the last creation (the result panel compares it with what was created). */
  const [plannedRoutines, setPlannedRoutines] = useState(0);
  const createBusy = useRef(false);

  const areas = setup?.areas ?? null;
  const loadPacks = (): void => {
    setPacksError(null);
    api.getPacks().then(
      (list) => {
        setPacks(list);
      },
      (e: unknown) => setPacksError(errorText(e)),
    );
  };
  useEffect(() => {
    loadPacks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ordered = useMemo(() => orderPacks(packs ?? [], areas), [packs, areas]);
  // The team that opens first stays open even if the order changes later (the setup is re-read after a creation).
  useEffect(() => {
    if (selected === null && ordered[0]) setSelected(ordered[0].id);
  }, [selected, ordered]);
  // The first team (the ones of the chosen areas come first) is already open, so the right side is never empty.
  const current = selected ?? ordered[0]?.id ?? (packs && packs.length === 0 ? GUIDE_KEY : null);
  const isGuide = current === GUIDE_KEY;
  const pack = isGuide ? null : (ordered.find((p) => p.id === current) ?? null);
  const drafts: AgentDraft[] = isGuide ? (edits[GUIDE_KEY] ?? []) : (edits[current ?? ''] ?? pack?.agents ?? []);

  const pick = (key: string): void => {
    setSelected(key);
    setView('detail');
    setResult(null);
    setCreateError(null);
  };

  const routineKey = (agent: number, routine: number): string => `${current ?? ''}:${agent}:${routine}`;
  const routineOn = (agent: number, routine: number): boolean => !skipped[routineKey(agent, routine)];
  const toggleRoutine = (agent: number, routine: number): void => {
    const key = routineKey(agent, routine);
    setSkipped((all) => {
      if (all[key]) {
        const { [key]: _gone, ...rest } = all;
        return rest;
      }
      return { ...all, [key]: true };
    });
  };
  const routinesOffered = drafts.reduce((n, d) => n + (d.routines?.length ?? 0), 0);
  const routinesChosen = drafts.reduce((n, d, i) => n + (d.routines ?? []).filter((_, ri) => routineOn(i, ri)).length, 0);

  const changeDraft = (index: number, patch: Partial<AgentDraft>): void => {
    if (!current) return;
    setEdits((all) => ({ ...all, [current]: drafts.map((d, i) => (i === index ? { ...d, ...patch } : d)) }));
  };

  const engine = teamEngine(setup);
  const engineOk = engineState(engine.engine, engine.provider, engines, providers);
  const existingNames = useMemo(() => existingAgents.map((a) => a.name.trim().toLowerCase()), [existingAgents]);
  const problems = drafts.map((_, i) => nameProblem(drafts, i, existingNames));
  const canCreate = !!current && drafts.length > 0 && problems.every((p) => !p) && drafts.length <= TEAM_MAX && !creating && !pending && !result;

  const propose = async (body: string, previous: boolean): Promise<void> => {
    const message = body.trim();
    if (!message || guideBusy.current) return;
    guideBusy.current = true;
    setPending(true);
    setGuideError(null);
    try {
      const proposal = await api.proposeTeam({
        text: message,
        ...(previous && drafts.length ? { previous: { agents: drafts } } : {}),
        ...(areas && areas.length ? { areas } : {}),
      });
      setEdits((all) => ({ ...all, [GUIDE_KEY]: proposal.agents }));
      // A new proposal has other agents and routines: the old choices do not apply to it.
      setSkipped((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${GUIDE_KEY}:`))) as Record<string, true>);
      setSay(proposal.say);
      if (previous) setRefine('');
    } catch (e) {
      // The typed text stays where it is: only a sentence is shown.
      if (e instanceof ApiError && e.status === 409) {
        setGuideError('A Seraphine já está montando um time. Espere um instante e tente de novo.');
      } else if (e instanceof ApiError && e.status === 503) {
        setGuideError(e.detail || 'Não consegui montar o time agora. Escolha um time pronto ao lado.');
      } else {
        setGuideError(errorText(e));
      }
    } finally {
      guideBusy.current = false;
      setPending(false);
    }
  };

  const finish = (team: TeamResult): void => {
    const first = team.created[0]?.home.id;
    if (first) navigate({ screen: 'project', projectId: first });
    onClose?.();
  };

  const create = async (): Promise<void> => {
    if (!canCreate || createBusy.current || !current) return;
    createBusy.current = true;
    setCreating(true);
    setCreateError(null);
    const origin = isGuide ? 'guide' : `pack:${current}`;
    // Unchecked routines are left out of the request; what goes is the contract's draft shape (`schedule_text` stays here).
    const body = drafts.map((d, i) => {
      const trimmed = { ...d, name: d.name.trim(), role: d.role.trim(), description: d.description.trim() };
      if (!d.routines) return trimmed;
      return {
        ...trimmed,
        routines: d.routines
          .filter((_, ri) => routineOn(i, ri))
          .map((r) => ({ title: r.title, prompt: r.prompt, schedule: r.schedule, ...(r.report ? { report: r.report } : {}) })),
      };
    });
    setPlannedRoutines(routinesChosen);
    const res = await createTeam(origin, body);
    createBusy.current = false;
    setCreating(false);
    if (!res.ok || !res.result) {
      setCreateError(res.error ?? 'Não consegui criar os agentes. Tente de novo.');
      return;
    }
    // Routines are part of what the owner should hear about, so a creation that made some also shows the result.
    // A creation that can be undone also shows it: the panel is where "Desfazer a criação" lives.
    if (res.result.failed.length > 0 || res.result.lowered.length > 0 || res.result.routines.length > 0 || res.result.batch) setResult(res.result);
    else finish(res.result);
  };

  const listId = useId();
  const textId = useId();
  const refineId = useId();

  const cards = (
    <ul className="a-stack a-drafts" aria-label="Agentes do time">
      {drafts.map((d, i) => (
        <DraftCard
          key={i}
          draft={d}
          index={i}
          error={problems[i] ?? ''}
          onChange={(patch) => changeDraft(i, patch)}
          routineOn={(ri) => routineOn(i, ri)}
          onToggleRoutine={(ri) => toggleRoutine(i, ri)}
        />
      ))}
    </ul>
  );

  const footer = (
    <div className="a-build__foot">
      <p className="a-path">
        <FolderIcon />
        {setup?.home_dir ? (
          <span>
            Cada agente ganha uma pasta própria em <code>{setup.home_dir}</code>
          </span>
        ) : (
          <span>Cada agente ganha uma pasta própria dentro da pasta de agentes da Seraphine.</span>
        )}
      </p>
      <p className="a-hint a-build__approval">
        <ShieldCheckIcon size={14} /> Todo comando que um agente quiser rodar espera a sua aprovação.
      </p>
      <div className="a-build__engine">
        <span>
          Motor que eles vão usar: <strong>{engineChoiceLabel(engine.engine, engine.provider, providers)}</strong>
        </span>
        <EngineChip ready={engineOk.ready} how={engineOk.how} />
      </div>
      {!engineOk.ready && (
        <p className="a-hint">
          {engineOk.how} Os agentes são criados mesmo assim e passam a responder quando o motor estiver pronto.
        </p>
      )}
      {createError && <Notice>{createError}</Notice>}
      <div className="a-build__bar">
        <span className="a-hint" role="status">
          {agentsCountLabel(drafts.length)}
          {routinesOffered > 0 ? ` · ${pluralRoutines(routinesChosen)}` : ''}
        </span>
        <span className="a-spacer" />
        {variant === 'dialog' && (
          <button type="button" className="a-btn a-btn--ghost" onClick={onClose}>
            Cancelar
          </button>
        )}
        <button type="button" className="a-btn a-btn--primary" disabled={!canCreate} onClick={() => void create()}>
          {creating ? 'Criando…' : 'Criar meus agentes'}
        </button>
      </div>
    </div>
  );

  let right: JSX.Element;
  if (result) {
    right = (
      <div className="a-build__result" role="status">
        <h3 className="a-build__title">
          {undone ? 'Criação desfeita' : result.created.length === 0 ? 'Nenhum agente foi criado' : result.failed.length > 0 || result.lowered.length > 0 ? 'Pronto, mas com avisos' : 'Pronto'}
        </h3>
        {result.created.length > 0 && (
          <section aria-label="O que foi criado">
            <p className="a-eyebrow">CRIADOS</p>
            <ul className="a-bullets">
              {result.created.map((c) => (
                <li key={c.def.id}>{c.def.name}</li>
              ))}
            </ul>
          </section>
        )}
        {(result.routines.length > 0 || plannedRoutines > 0) && (
          <section aria-label="Rotinas criadas">
            <p className="a-eyebrow">ROTINAS</p>
            <p className="a-hint">
              {result.routines.length === 0
                ? 'Nenhuma rotina foi criada.'
                : `${pluralRoutines(result.routines.length)} ${result.routines.length === 1 ? 'criada e ligada' : 'criadas e ligadas'}.`}
            </p>
            {result.routines.length > 0 && (
              <ul className="a-bullets">
                {result.routines.map((r) => (
                  <li key={r.id}>
                    {r.title} · {r.schedule_text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {result.failed.length > 0 && (
          <section aria-label="O que não foi criado">
            <p className="a-eyebrow">NÃO FORAM CRIADOS</p>
            <ul className="a-bullets">
              {result.failed.map((f, i) => (
                <li key={i}>
                  <strong>{f.name}</strong>: {f.detail}
                </li>
              ))}
            </ul>
          </section>
        )}
        {result.lowered.length > 0 && (
          <section aria-label="Acessos reduzidos">
            <p className="a-eyebrow">ACESSOS REDUZIDOS</p>
            <p className="a-hint">Por segurança, nenhum agente criado aqui passa do limite de acesso da Seraphine.</p>
            <ul className="a-bullets">
              {result.lowered.map((l, i) => (
                <li key={i}>{loweredLine(l, tools)}</li>
              ))}
            </ul>
          </section>
        )}
        <TeamUndo batch={result.batch} />
        <div className="a-build__bar">
          <span className="a-spacer" />
          {(result.created.length === 0 || (undone && variant === 'setup')) && (
            <button type="button" className="a-btn a-btn--primary" onClick={() => setResult(null)}>
              Voltar e ajustar
            </button>
          )}
          {undone && variant === 'dialog' && (
            <button type="button" className="a-btn a-btn--primary" onClick={onClose}>
              Fechar
            </button>
          )}
          {/* Embedded in the first steps there is nothing to close: with nothing created, going back is the only way on. */}
          {result.created.length === 0 && !undone && variant === 'dialog' && (
            <button type="button" className="a-btn a-btn--ghost" onClick={() => finish(result)}>
              Fechar
            </button>
          )}
          {result.created.length > 0 && !undone && (
            <button type="button" className="a-btn a-btn--primary" onClick={() => finish(result)}>
              Abrir a conversa
            </button>
          )}
        </div>
      </div>
    );
  } else if (isGuide) {
    right = (
      <div className="a-build__guide">
        <h3 className="a-build__title">Conte do que você precisa</h3>
        <label className="a-field" htmlFor={textId}>
          <span>O que você precisa</span>
        </label>
        <textarea
          id={textId}
          className="a-input"
          rows={4}
          maxLength={GUIDE_TEXT_MAX}
          placeholder="Ex.: preciso de ajuda com as contas da casa e com meus estudos de inglês"
          value={text}
          onChange={(e) => setText(clampText(e.target.value, GUIDE_TEXT_MAX))}
        />
        <div className="a-actions">
          <button
            type="button"
            className="a-btn a-btn--primary"
            disabled={pending || !text.trim() || drafts.length > 0}
            onClick={() => void propose(text, false)}
          >
            <SparkIcon size={16} /> Montar meu time
          </button>
          {drafts.length > 0 && (
            <button
              type="button"
              className="a-btn a-btn--ghost"
              onClick={() => {
                setEdits((all) => ({ ...all, [GUIDE_KEY]: [] }));
                setSay(null);
              }}
            >
              Começar outro pedido
            </button>
          )}
        </div>
        <div aria-live="polite" role="status" className="a-build__live">
          {pending ? 'A Seraphine está montando…' : ''}
        </div>
        {guideError && <Notice>{guideError}</Notice>}
        {drafts.length > 0 && (
          <>
            {say && <SeraphineSays>{say}</SeraphineSays>}
            {cards}
            <div className="a-field">
              <label htmlFor={refineId}>
                <span className="a-label-text">Quer mudar algo?</span>
              </label>
              <textarea
                id={refineId}
                className="a-input"
                rows={2}
                maxLength={GUIDE_TEXT_MAX}
                placeholder="Ex.: troque o nome, junte os dois, quero mais um para pesquisa"
                value={refine}
                onChange={(e) => setRefine(clampText(e.target.value, GUIDE_TEXT_MAX))}
              />
              <div className="a-actions">
                <button
                  type="button"
                  className="a-btn a-btn--ghost"
                  disabled={pending || !refine.trim()}
                  onClick={() => void propose(refine, true)}
                >
                  Ajustar o time
                </button>
              </div>
            </div>
            {footer}
          </>
        )}
      </div>
    );
  } else if (pack) {
    right = (
      <div className="a-build__pack">
        <h3 className="a-build__title">{pack.label}</h3>
        <p className="a-hint">{pack.detail}</p>
        {cards}
        {footer}
      </div>
    );
  } else {
    right = <p className="a-empty">{packs === null && !packsError ? 'Carregando os times…' : 'Escolha um time ao lado.'}</p>;
  }

  return (
    <div className={`a-build a-build--${variant}`} data-view={view}>
      <div className="a-build__left">
        {packsError && (
          <Notice>
            Não consegui carregar os times prontos: {packsError}{' '}
            <button type="button" className="a-link" onClick={loadPacks}>
              Tentar de novo
            </button>
          </Notice>
        )}
        {packs === null && !packsError && <p className="a-empty">Carregando os times…</p>}
        <ul className="a-picks" aria-label="Times prontos" id={listId}>
          {ordered.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={`a-card a-pick${current === p.id ? ' is-active' : ''}`}
                aria-current={current === p.id ? 'true' : undefined}
                onClick={() => pick(p.id)}
              >
                <span className="a-pick__tiles" aria-hidden="true">
                  {p.agents.slice(0, 3).map((a, i) => (
                    <AgentTile key={i} name={a.name} color={safeColor(a.color, AGENT_COLORS[i % AGENT_COLORS.length])} size="sm" />
                  ))}
                </span>
                <span className="a-pick__text">
                  <strong>{p.label}</strong>
                  <small>{p.summary}</small>
                </span>
                <ChevronRightSmallIcon className="a-pick__go" />
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              className={`a-card a-pick${isGuide ? ' is-active' : ''}`}
              aria-current={isGuide ? 'true' : undefined}
              onClick={() => pick(GUIDE_KEY)}
            >
              <span className="a-pick__tiles" aria-hidden="true">
                <SparkIcon size={18} />
              </span>
              <span className="a-pick__text">
                <strong>{NONE_PACK_LABEL}</strong>
                <small>A Seraphine monta o time para você</small>
              </span>
              <ChevronRightSmallIcon className="a-pick__go" />
            </button>
          </li>
        </ul>
        <div className="a-build__links">
          <button type="button" className="a-link" onClick={onBlank}>
            Criar um agente do zero
          </button>
        </div>
      </div>

      <div className="a-build__right">
        <button type="button" className="a-link a-build__back" onClick={() => setView('list')}>
          Voltar aos times
        </button>
        {right}
      </div>
    </div>
  );
}

/** The dialog: overlay, labelled by its title, Esc closes, Tab stays inside, focus goes back to what opened it. */
export function TeamDialog({ onClose, onBlank }: { onClose: () => void; onBlank: () => void }): JSX.Element {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [
        ...panelRef.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])'),
      ].filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="a-dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="a-dialog__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panelRef}>
        <header className="a-dialog__head">
          <div>
            <h2 id={titleId}>Seus agentes</h2>
            <p className="a-hint">Times prontos para o que você quer de ajuda. Nada é criado antes do seu clique.</p>
          </div>
          <button type="button" className="a-btn a-btn--ghost a-btn--small" aria-label="Fechar" onClick={onClose}>
            Fechar
          </button>
        </header>
        <TeamBuilder variant="dialog" onClose={onClose} onBlank={onBlank} />
      </div>
    </div>
  );
}
