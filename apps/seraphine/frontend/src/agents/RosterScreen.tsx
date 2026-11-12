/** "Agentes": roster on the left, detail / edit form on the right. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAgentsStore } from './store';
import { AgentTile, EmptyNote, Notice } from './components';
import { BridgePanel } from './BridgePanel';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { HistorySection } from './HistorySection';
import { LockIcon, PlusIcon } from '../icons/Icons';
import { ToolGroupIcon } from './icons';
import {
  AGENT_COLORS,
  DEFAULT_PROVIDER,
  EFFORT_OPTIONS,
  ROLE_PRESETS,
  RUNTIME_OPTIONS,
  TOOLS_FIXED_NOTE,
  agentStateLabel,
  canonRuntime,
  effectiveGrants,
  engineLabel,
  engineUsesTools,
  grantsSummary,
  groupLevelOptions,
  providerOptionLabel,
  providersForRuntime,
  safeColor,
  supportsEffort,
  targetLine,
  writeAccessLine,
} from './lib';
import { plainProjects } from './setup';
import { useConfirm } from '../ui';
import type {
  Agent,
  AgentInput,
  CommandPermission,
  EditPermission,
  GrantLevel,
  Grants,
  ProviderInfo,
  ReasoningEffort,
  ToolGroup,
} from './types';

interface Draft {
  name: string;
  role: string;
  description: string;
  suggestions: string[];
  instructions: string;
  engine: string;
  provider: string;
  model: string;
  reasoning_effort: '' | ReasoningEffort;
  fallback_engine: string;
  fallback_provider: string;
  fallback_model: string;
  color: string;
  perm_edit: EditPermission;
  perm_commands: CommandPermission;
  budget: string;
  enabled: boolean;
  project_ids: string[];
}

function blankDraft(colorIndex: number): Draft {
  return {
    name: '',
    role: '',
    description: '',
    suggestions: [],
    instructions: '',
    engine: 'codex',
    provider: DEFAULT_PROVIDER.codex,
    model: '',
    reasoning_effort: '',
    fallback_engine: '',
    fallback_provider: '',
    fallback_model: '',
    color: AGENT_COLORS[colorIndex % AGENT_COLORS.length],
    perm_edit: 'free',
    perm_commands: 'ask',
    budget: '',
    enabled: true,
    project_ids: [],
  };
}

function toDraft(a: Agent): Draft {
  return {
    name: a.name,
    role: a.role,
    description: a.description ?? '',
    suggestions: [...(a.suggestions ?? [])],
    instructions: a.instructions,
    engine: canonRuntime(a.engine),
    provider: a.provider ?? DEFAULT_PROVIDER[canonRuntime(a.engine)] ?? '',
    model: a.model ?? '',
    reasoning_effort: a.reasoning_effort ?? '',
    fallback_engine: canonRuntime(a.fallback_engine) || '',
    fallback_provider: a.fallback_provider ?? '',
    fallback_model: a.fallback_model ?? '',
    color: safeColor(a.color),
    perm_edit: a.perm_edit,
    perm_commands: a.perm_commands,
    budget: a.daily_budget_usd == null ? '' : String(a.daily_budget_usd),
    enabled: a.enabled,
    project_ids: [...a.project_ids],
  };
}

function parseBudget(raw: string): { value: number | null; ok: boolean } {
  const t = raw.trim().replace(',', '.');
  if (t === '') return { value: null, ok: true };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? { value: n, ok: true } : { value: null, ok: false };
}

function toInput(d: Draft, existing: boolean): AgentInput {
  return {
    name: d.name.trim(),
    role: d.role.trim(),
    // The phase-6a fields go on the wire when the agent exists already or when the owner filled them in.
    ...(existing || d.description.trim() ? { description: d.description.trim() } : {}),
    ...(existing || d.suggestions.length ? { suggestions: d.suggestions } : {}),
    instructions: d.instructions.trim(),
    engine: d.engine,
    provider: d.provider || null,
    model: d.model.trim() || null,
    reasoning_effort: supportsEffort(d.engine) && d.reasoning_effort ? d.reasoning_effort : null,
    fallback_engine: d.fallback_engine || null,
    fallback_provider: d.fallback_engine ? d.fallback_provider || null : null,
    fallback_model: d.fallback_engine ? d.fallback_model.trim() || null : null,
    color: d.color,
    perm_edit: d.perm_edit,
    perm_commands: d.perm_commands,
    daily_budget_usd: parseBudget(d.budget).value,
    enabled: d.enabled,
    project_ids: d.project_ids,
  };
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="a-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`a-seg__btn${value === o.value ? ' is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Access level of one group of tools: a radio group (arrows move, one stop in the Tab order, state read out by screen readers).
 * The options are the levels the group accepts (`ToolGroup.levels`): "Ler e escrever" has a button only where the group writes.
 */
function GrantControl({
  name,
  labelledBy,
  describedBy,
  options,
  value,
  disabled,
  onChange,
}: {
  name: string;
  labelledBy: string;
  describedBy: string;
  options: { value: GrantLevel; label: string }[];
  value: GrantLevel;
  disabled: boolean;
  onChange: (level: GrantLevel) => void;
}): JSX.Element {
  return (
    <div className="a-grant__control" role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy}>
      {options.map((o) => (
        <label key={o.value} className={`a-grant__opt${disabled ? ' is-disabled' : ''}`}>
          <input
            type="radio"
            className="a-grant__input"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span className="a-grant__face">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

function ToolsSection({
  groups,
  state,
  levels,
  disabled,
  fieldsetRef,
  onChange,
  onRetry,
}: {
  groups: ToolGroup[];
  state: 'loading' | 'ready' | 'error';
  levels: Grants;
  /** The agent's engine cannot use these tools: the controls stay, locked. */
  disabled: boolean;
  fieldsetRef: React.RefObject<HTMLFieldSetElement>;
  onChange: (groupId: string, level: GrantLevel) => void;
  onRetry: () => void;
}): JSX.Element {
  const uid = useId();
  return (
    <fieldset className="a-fieldset a-tools" ref={fieldsetRef} tabIndex={-1}>
      <legend>Ferramentas e acesso</legend>
      <p className="a-hint">Escolha o que este agente pode consultar, e onde pode também escrever, nas suas coisas na Seraphine.</p>
      {disabled && (
        <p className="a-hint a-tools__locked">
          Um agente que só conversa ainda não usa as ferramentas da Seraphine nesta versão, por isso as opções ficam travadas.
        </p>
      )}
      {groups.length === 0 ? (
        <p className="a-hint">
          {state === 'loading' ? 'Carregando as ferramentas…' : 'Não consegui carregar as ferramentas agora.'}{' '}
          {state === 'error' && (
            <button type="button" className="a-link" onClick={onRetry}>
              Tentar de novo
            </button>
          )}
        </p>
      ) : (
        <ul className="a-grants">
          {groups.map((g) => {
            const level = levels[g.id] ?? g.default;
            const labelId = `${uid}-${g.id}-label`;
            const descId = `${uid}-${g.id}-desc`;
            const warnId = `${uid}-${g.id}-warn`;
            const writeId = `${uid}-${g.id}-write`;
            const warn = g.sensitive && level !== 'none' && !disabled;
            const writes = level === 'write' && !disabled ? writeAccessLine(g) : null;
            const describedBy = [descId, warn ? warnId : '', writes ? writeId : ''].filter(Boolean).join(' ');
            return (
              <li key={g.id} className="a-grant">
                <div className="a-grant__row">
                  <ToolGroupIcon group={g.id} className="a-grant__icon" size={18} />
                  <div className="a-grant__text">
                    <strong id={labelId}>{g.label}</strong>
                    <span className="a-grant__desc" id={descId}>
                      {g.description}
                    </span>
                    {g.tools.length > 0 && (
                      <span className="a-grant__tools">Inclui: {g.tools.map((t) => t.label).join(' · ')}</span>
                    )}
                  </div>
                  <GrantControl
                    name={`${uid}-${g.id}`}
                    labelledBy={labelId}
                    describedBy={describedBy}
                    options={groupLevelOptions(g)}
                    value={level}
                    disabled={disabled}
                    onChange={(l) => onChange(g.id, l)}
                  />
                </div>
                {/* a region that is always there, so the screen reader announces the warning when it appears */}
                <div aria-live="polite">
                  {warn && (
                    <p className="a-grant__warn" id={warnId}>
                      Atenção: o que o agente ler aqui é enviado ao provedor de IA que ele usa.
                    </p>
                  )}
                  {writes && (
                    <p className="a-grant__write" id={writeId}>
                      {writes}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="a-hint a-tools__fixed">
        <LockIcon size={14} /> {TOOLS_FIXED_NOTE}
      </p>
    </fieldset>
  );
}

/** Provider select: those the runtime can use; the unusable ones are disabled and say why. */
function ProviderSelect({
  label,
  runtime,
  value,
  providers,
  onChange,
}: {
  label: string;
  runtime: string;
  value: string;
  providers: ProviderInfo[];
  onChange: (id: string) => void;
}): JSX.Element {
  const options = providersForRuntime(providers, runtime);
  const known = options.some((p) => p.id === value);
  return (
    <label className="a-field">
      <span>{label}</span>
      <select className="a-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {!known && value && <option value={value}>{value}</option>}
        {options.map((p) => (
          <option key={p.id} value={p.id} disabled={!p.configured && p.id !== value}>
            {providerOptionLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** First usable provider of a runtime (its default one when it is usable). */
function pickProvider(providers: ProviderInfo[], runtime: string): string {
  const fit = providersForRuntime(providers, runtime);
  const preferred = fit.find((p) => p.id === DEFAULT_PROVIDER[canonRuntime(runtime)] && p.configured);
  return (preferred ?? fit.find((p) => p.configured) ?? fit[0])?.id ?? DEFAULT_PROVIDER[canonRuntime(runtime)] ?? '';
}

function AgentForm({
  agent,
  colorIndex,
  focusTools,
  openHistory,
  onDone,
}: {
  agent: Agent | null;
  colorIndex: number;
  /** Open at the "Ferramentas e acesso" section (coming from a denied tool). */
  focusTools: boolean;
  /** Open with the "Histórico" section already open (coming from "Ver o histórico" on an applied proposal). */
  openHistory: boolean;
  onDone: (id: string | null) => void;
}): JSX.Element {
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const allProjects = useAgentsStore((s) => s.projects);
  const projects = useMemo(() => plainProjects(allProjects), [allProjects]);
  const agents = useAgentsStore((s) => s.agents);
  const tools = useAgentsStore((s) => s.tools);
  const toolsState = useAgentsStore((s) => s.toolsState);
  const loadTools = useAgentsStore((s) => s.loadTools);
  const saveAgent = useAgentsStore((s) => s.saveAgent);
  const saveGrants = useAgentsStore((s) => s.saveGrants);
  const deleteAgent = useAgentsStore((s) => s.deleteAgent);
  const navigate = useAgentsStore((s) => s.navigate);
  const confirm = useConfirm();

  // A new agent whose access could not be saved right after creation already exists: a retry must not create it twice.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const current = agent ?? (createdId ? (agents.find((a) => a.id === createdId) ?? null) : null);

  const original = useMemo(() => (current ? toDraft(current) : blankDraft(colorIndex)), [current, colorIndex]);
  const [draft, setDraft] = useState<Draft>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fallbackOpen, setFallbackOpen] = useState(!!original.fallback_engine);
  // Only the levels the owner touched; the rest follow the agent (or the catalogue's defaults for a new one), also when the catalogue arrives late.
  const [grantEdits, setGrantEdits] = useState<Grants>({});
  const toolsRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    if (!focusTools) return;
    toolsRef.current?.scrollIntoView?.({ block: 'start' });
    toolsRef.current?.focus();
  }, [focusTools]);

  const baseGrants = useMemo(() => effectiveGrants(current?.grants, tools), [current, tools]);
  const shownGrants: Grants = { ...baseGrants, ...grantEdits };
  const grantsDirty = tools.some((g) => shownGrants[g.id] !== baseGrants[g.id]);
  const toolsLocked = !engineUsesTools(draft.engine, engines);
  const changeGrant = (groupId: string, level: GrantLevel): void => {
    setSaved(false);
    setGrantEdits((e) => ({ ...e, [groupId]: level }));
  };

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const unavailable = engines.filter((e) => !e.available);
  const isUnavailable = (name: string): boolean => engines.some((e) => e.name === name && !e.available);
  const defaultModel = (id: string): string => providers.find((p) => p.id === id)?.default_model ?? '';
  const changeRuntime = (runtime: string): void => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      engine: runtime,
      provider: providersForRuntime(providers, runtime).some((p) => p.id === d.provider)
        ? d.provider
        : pickProvider(providers, runtime),
      reasoning_effort: supportsEffort(runtime) ? d.reasoning_effort : '',
    }));
  };
  const changeFallbackRuntime = (runtime: string): void => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      fallback_engine: runtime,
      fallback_provider: runtime ? pickProvider(providers, runtime) : '',
      fallback_model: runtime ? d.fallback_model : '',
    }));
  };

  const fieldsDirty = JSON.stringify(draft) !== JSON.stringify(original);
  const dirty = fieldsDirty || grantsDirty;
  const budget = parseBudget(draft.budget);
  const valid = !!draft.name.trim() && !!draft.instructions.trim() && budget.ok;

  const applyPreset = (id: string): void => {
    const p = ROLE_PRESETS.find((r) => r.id === id);
    if (p) setDraft((d) => ({ ...d, role: p.role, instructions: p.instructions }));
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    let id = current?.id ?? null;
    // 1) the agent itself (skipped when only the access changed: it is a second request, not a second Save)
    if (!current || fieldsDirty) {
      const res = await saveAgent(id, toInput(draft, !!current));
      if (!res.ok) {
        setBusy(false);
        setError(res.error ?? 'Não consegui salvar o agente.');
        return;
      }
      id = res.agent?.id ?? id;
      if (!current && id) setCreatedId(id);
    }
    // 2) what it may consult, right after (the agent already exists here); a failure keeps every edit on screen
    if (id && grantsDirty) {
      const res = await saveGrants(id, shownGrants);
      if (!res.ok) {
        setBusy(false);
        setError(res.error ?? 'Não consegui salvar o que este agente pode consultar.');
        return;
      }
      setGrantEdits({});
    }
    setBusy(false);
    setSaved(true);
    onDone(id);
  };

  const remove = async (): Promise<void> => {
    if (!current) return;
    const ok = await confirm({
      title: 'Apagar agente',
      message: `Apagar ${current.name}? Ele deixa de responder nos projetos. Essa ação não pode ser desfeita.`,
      confirmLabel: 'Apagar',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await deleteAgent(current.id);
    if (res.ok) onDone(null);
    else setError(res.error ?? 'Não consegui apagar o agente.');
  };

  return (
    <form className="a-card a-agent-form" onSubmit={(e) => void submit(e)} aria-label={agent ? `Editar ${agent.name}` : 'Novo agente'}>
      {!agent && (
        <div className="a-presets" role="group" aria-label="Começar por um papel">
          <span className="a-eyebrow">COMEÇAR POR UM PAPEL</span>
          <div className="a-presets__row">
            {ROLE_PRESETS.map((p) => (
              <button key={p.id} type="button" className="a-chip-btn" onClick={() => applyPreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="a-form-grid">
        <label className="a-field">
          <span>Nome</span>
          <input className="a-input" value={draft.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label className="a-field">
          <span>Papel</span>
          <input className="a-input" value={draft.role} placeholder="Ex.: código, infra, pesquisa" onChange={(e) => set('role', e.target.value)} />
        </label>
      </div>

      <label className="a-field">
        <span>O que ele faz (opcional)</span>
        <textarea
          className="a-input"
          rows={2}
          maxLength={300}
          value={draft.description}
          onChange={(e) => set('description', e.target.value.slice(0, 300))}
        />
        <small>Uma ou duas frases para você. Aparece na conversa dele.</small>
      </label>

      <label className="a-field">
        <span>Instruções</span>
        <textarea className="a-input" rows={5} value={draft.instructions} onChange={(e) => set('instructions', e.target.value)} />
      </label>

      <div className="a-form-grid">
        <label className="a-field">
          <span>Como ele trabalha</span>
          <select className="a-input" value={draft.engine} onChange={(e) => changeRuntime(e.target.value)}>
            {RUNTIME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} disabled={isUnavailable(o.value)}>
                {o.label}
                {isUnavailable(o.value) ? ' (indisponível)' : ''}
              </option>
            ))}
          </select>
        </label>
        <ProviderSelect
          label="Provedor"
          runtime={draft.engine}
          value={draft.provider}
          providers={providers}
          onChange={(id) => set('provider', id)}
        />
      </div>
      {unavailable.length > 0 && (
        <ul className="a-engine-notes">
          {unavailable.map((e) => (
            <li key={e.name}>
              {engineLabel(e.name)} indisponível{e.reason ? `: ${e.reason}` : ''}
            </li>
          ))}
        </ul>
      )}

      <div className="a-form-grid">
        <label className="a-field">
          <span>Modelo (opcional)</span>
          <input
            className="a-input a-input--mono"
            value={draft.model}
            placeholder={defaultModel(draft.provider) || 'Padrão do provedor'}
            onChange={(e) => set('model', e.target.value)}
          />
        </label>
        {supportsEffort(draft.engine) && (
          <label className="a-field">
            <span>Esforço de raciocínio</span>
            <select
              className="a-input"
              value={draft.reasoning_effort}
              onChange={(e) => set('reasoning_effort', e.target.value as '' | ReasoningEffort)}
            >
              {EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <details
        className="a-fallback"
        open={fallbackOpen}
        onToggle={(e) => setFallbackOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>Reserva, se o principal falhar</summary>
        <div className="a-fallback__body">
          <div className="a-form-grid">
            <label className="a-field">
              <span>Como a reserva trabalha</span>
              <select
                className="a-input"
                value={draft.fallback_engine}
                onChange={(e) => changeFallbackRuntime(e.target.value)}
              >
                <option value="">Nenhuma</option>
                {RUNTIME_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} disabled={isUnavailable(o.value)}>
                    {o.label}
                    {isUnavailable(o.value) ? ' (indisponível)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {draft.fallback_engine && (
              <ProviderSelect
                label="Provedor da reserva"
                runtime={draft.fallback_engine}
                value={draft.fallback_provider}
                providers={providers}
                onChange={(id) => set('fallback_provider', id)}
              />
            )}
          </div>
          {draft.fallback_engine && (
            <label className="a-field">
              <span>Modelo da reserva (opcional)</span>
              <input
                className="a-input a-input--mono"
                value={draft.fallback_model}
                placeholder={defaultModel(draft.fallback_provider) || 'Padrão do provedor'}
                onChange={(e) => set('fallback_model', e.target.value)}
              />
            </label>
          )}
        </div>
      </details>

      <fieldset className="a-fieldset">
        <legend>Projetos onde pode agir</legend>
        {projects.length === 0 ? (
          <p className="a-hint">
            Nenhum projeto ainda.{' '}
            <button type="button" className="a-link" onClick={() => navigate({ screen: 'home' })}>
              Adicionar projeto
            </button>
          </p>
        ) : (
          <div className="a-chips">
            {projects.map((p) => {
              const on = draft.project_ids.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`a-chip-btn${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() =>
                    set('project_ids', on ? draft.project_ids.filter((id) => id !== p.id) : [...draft.project_ids, p.id])
                  }
                >
                  <span aria-hidden="true">#</span>
                  {p.name}
                </button>
              );
            })}
          </div>
        )}
        <p className="a-hint">Fora dessas pastas ele não altera arquivos sem a sua aprovação.</p>
      </fieldset>

      <fieldset className="a-fieldset">
        <legend>Permissões</legend>
        <div className="a-perm">
          <span id="perm-edit-label">Editar arquivos na pasta</span>
          <Segmented
            label="Editar arquivos na pasta"
            value={draft.perm_edit}
            options={[
              { value: 'free', label: 'Livre' },
              { value: 'blocked', label: 'Bloqueado' },
            ]}
            onChange={(v) => set('perm_edit', v)}
          />
        </div>
        <div className="a-perm">
          <span>Outros comandos</span>
          <Segmented
            label="Outros comandos"
            value={draft.perm_commands}
            options={[
              { value: 'ask', label: 'Pergunta' },
              { value: 'blocked', label: 'Bloqueado' },
            ]}
            onChange={(v) => set('perm_commands', v)}
          />
        </div>
        <div className="a-perm a-perm--fixed">
          <span>
            <LockIcon size={14} /> Deploy, apagar, pagar, publicar: sempre pede aprovação
          </span>
        </div>
      </fieldset>

      <ToolsSection
        groups={tools}
        state={toolsState}
        levels={shownGrants}
        disabled={toolsLocked}
        fieldsetRef={toolsRef}
        onChange={changeGrant}
        onRetry={() => void loadTools()}
      />

      <div className="a-form-grid">
        <label className="a-field">
          <span>Limite por dia (US$)</span>
          <input
            className="a-input"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={draft.budget}
            placeholder="Sem limite"
            onChange={(e) => set('budget', e.target.value)}
          />
          <small>Ao atingir, o agente para e avisa.</small>
        </label>
        <div className="a-field">
          <span id="color-label">Cor</span>
          <div className="a-swatches" role="radiogroup" aria-labelledby="color-label">
            {AGENT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={draft.color === c}
                aria-label={`Cor ${c}`}
                className={`a-swatch${draft.color === c ? ' is-on' : ''}`}
                style={{ background: c }}
                onClick={() => set('color', c)}
              />
            ))}
          </div>
        </div>
      </div>

      <label className="a-switch">
        <input type="checkbox" role="switch" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        <span>Agente ligado (desligado, ele fica pausado)</span>
      </label>

      {current && (
        <HistorySection
          agent={current}
          unsaved={fieldsDirty}
          startOpen={openHistory}
          onRestored={(restored) => {
            // The five texts come back from the backend; whatever else the owner is editing stays as it is.
            setSaved(false);
            setError(null);
            setDraft((d) => ({
              ...d,
              name: restored.name,
              role: restored.role,
              description: restored.description,
              suggestions: [...restored.suggestions],
              instructions: restored.instructions,
            }));
          }}
        />
      )}

      {!budget.ok && <Notice>O limite por dia precisa ser um número, como 5 ou 2,50.</Notice>}
      {error && <Notice>{error}</Notice>}
      {saved && !dirty && <Notice tone="info">Salvo.</Notice>}

      <div className="a-actions a-actions--end">
        {current && (
          <button type="button" className="a-btn a-btn--danger" onClick={() => void remove()}>
            Apagar agente
          </button>
        )}
        <span className="a-spacer" />
        <button
          type="button"
          className="a-btn a-btn--ghost"
          disabled={busy || (!!current && !dirty)}
          onClick={() => {
            setError(null);
            if (current) {
              setDraft(original);
              setGrantEdits({});
            } else onDone(null);
          }}
        >
          Descartar
        </button>
        <button type="submit" className="a-btn a-btn--primary" disabled={busy || !valid || (!!current && !dirty)}>
          Salvar
        </button>
      </div>
    </form>
  );
}

/** The archived agents (the "Mostrar arquivados" filter): each one can come back or be deleted for good. */
function ArchivedList(): JSX.Element {
  const archived = useAgentsStore((s) => s.archivedAgents);
  const state = useAgentsStore((s) => s.archivedState);
  const restoreAgent = useAgentsStore((s) => s.restoreAgent);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);

  const restore = async (a: Agent): Promise<void> => {
    setBusyId(a.id);
    setError(null);
    const res = await restoreAgent(a.id);
    setBusyId(null);
    if (!res.ok) setError(res.error ?? `Não consegui restaurar ${a.name}. Tente de novo.`);
  };

  return (
    <section className="a-section" aria-labelledby="roster-archived-title">
      <h2 className="a-eyebrow" id="roster-archived-title">
        ARQUIVADOS
      </h2>
      {state === 'loading' && archived.length === 0 && (
        <p className="a-empty" role="status">
          Carregando os arquivados…
        </p>
      )}
      {state === 'error' && <Notice>Não consegui carregar os agentes arquivados agora.</Notice>}
      {state !== 'loading' && state !== 'error' && archived.length === 0 && <EmptyNote>Nenhum agente arquivado.</EmptyNote>}
      {error && <Notice>{error}</Notice>}
      <ul className="a-list">
        {archived.map((a) => (
          <li key={a.id} className="a-card a-roster__archived">
            <AgentTile name={a.name} color={safeColor(a.color)} />
            <span className="a-roster__text">
              <strong>{a.name}</strong>
              <small>{a.role}</small>
            </span>
            <span className="a-chip a-chip--engine a-chip--todo">Arquivado</span>
            <span className="a-actions">
              <button type="button" className="a-btn a-btn--ghost a-btn--small" aria-label={`Restaurar ${a.name}`} disabled={busyId === a.id} onClick={() => void restore(a)}>
                Restaurar
              </button>
              <button type="button" className="a-btn a-btn--danger a-btn--small" aria-label={`Apagar ${a.name}`} onClick={() => setDeleting(a)}>
                Apagar
              </button>
            </span>
          </li>
        ))}
      </ul>
      {deleting && <DeleteAgentDialog agentId={deleting.id} name={deleting.name} onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)} />}
    </section>
  );
}

export function RosterScreen(): JSX.Element {
  const agents = useAgentsStore((s) => s.agents);
  const loadArchivedAgents = useAgentsStore((s) => s.loadArchivedAgents);
  const [showArchived, setShowArchived] = useState(false);
  const runs = useAgentsStore((s) => s.runs);
  const routeAgentId = useAgentsStore((s) => s.route.agentId);
  const routeSection = useAgentsStore((s) => s.route.section);
  const routeNew = useAgentsStore((s) => s.route.newAgent);
  const openBuilder = useAgentsStore((s) => s.openBuilder);
  const navigate = useAgentsStore((s) => s.navigate);
  const providers = useAgentsStore((s) => s.providers);
  const engines = useAgentsStore((s) => s.engines);
  const tools = useAgentsStore((s) => s.tools);
  const runList = useMemo(() => Object.values(runs), [runs]);
  const [selected, setSelected] = useState<string | 'new' | null>(routeAgentId ?? (routeNew ? 'new' : null));

  useEffect(() => {
    if (routeAgentId) setSelected(routeAgentId);
  }, [routeAgentId]);
  useEffect(() => {
    if (routeNew && !routeAgentId) setSelected('new');
  }, [routeNew, routeAgentId]);

  useEffect(() => {
    if (showArchived) void loadArchivedAgents();
  }, [showArchived, loadArchivedAgents]);

  const current = selected && selected !== 'new' ? (agents.find((a) => a.id === selected) ?? null) : null;
  const showForm = selected === 'new' || current !== null;

  const pick = (id: string | 'new' | null): void => {
    setSelected(id);
    navigate({ screen: 'roster', agentId: id && id !== 'new' ? id : undefined });
  };

  return (
    <div className="a-page">
      <header className="a-header">
        <div className="a-header__text">
          <h1>Agentes</h1>
          <span>Cada agente tem um papel, um provedor de IA e as pastas onde pode agir.</span>
        </div>
        <button type="button" className="a-btn a-btn--primary" onClick={openBuilder}>
          <PlusIcon size={16} /> Novo agente
        </button>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => pick('new')}>
          Criar agente
        </button>
      </header>

      <div className="a-roster">
        <nav className="a-roster__list" aria-label="Lista de agentes">
          <label className="a-switch a-roster__filter">
            <input type="checkbox" role="switch" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            <span>Mostrar arquivados</span>
          </label>
          {agents.length === 0 ? (
            <EmptyNote>Nenhum agente ainda. Crie o primeiro: nada é criado sozinho.</EmptyNote>
          ) : (
            <ul className="a-list">
              {agents.map((a) => {
                const st = agentStateLabel(a, runList);
                const access = grantsSummary(a, tools, engines);
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      className={`a-card a-roster__item${current?.id === a.id ? ' is-active' : ''}`}
                      aria-current={current?.id === a.id ? 'true' : undefined}
                      onClick={() => pick(a.id)}
                    >
                      <AgentTile name={a.name} color={safeColor(a.color)} />
                      <span className="a-roster__text">
                        <strong>{a.name}</strong>
                        <small>
                          {[a.role, targetLine(a, providers)].filter(Boolean).join(' · ')}
                        </small>
                        {access && <small className="a-roster__access">{access}</small>}
                      </span>
                      <span className={`a-state${st.waiting ? ' is-waiting' : st.busy ? ' is-busy' : ''}`}>{st.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {showArchived && <ArchivedList />}
        </nav>

        <div className="a-roster__detail">
          {showForm ? (
            <AgentForm
              key={selected ?? 'none'}
              agent={current}
              colorIndex={agents.length}
              focusTools={routeSection === 'tools' && !!current && current.id === routeAgentId}
              openHistory={routeSection === 'history' && !!current && current.id === routeAgentId}
              onDone={(id) => pick(id)}
            />
          ) : (
            <EmptyNote>Escolha um agente na lista ou crie um novo.</EmptyNote>
          )}
        </div>
      </div>

      <BridgePanel />
    </div>
  );
}
