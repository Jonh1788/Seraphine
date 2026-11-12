/**
 * Sidebar shell (desktop / tablet). Two spaces:
 *  - personal space: "Agentes e projetos" entry + the existing views in
 *    collapsible groups;
 *  - agents space (`activeView === 'agents'`): Início / Aprovações / Agentes,
 *    the project list and the agent roster.
 * The phone shell and the mobile drawer do not use it.
 */
import './sidebar.css';
import { useEffect, useMemo, useState } from 'react';
import seraphineLogo from '../../src-tauri/icons/128x128.png';
import { useUiStore } from '../stores/uiStore';
import { countPending, useAgentsStore } from '../agents/store';
import { agentStateLabel, isActiveRun, isWaitingForAnswer, isWaitingForLogin, safeColor } from '../agents/lib';
import { agentEngineState, plainProjects } from '../agents/setup';
import { activeRoutineCount } from '../agents/routines';
import { pendingProposalCount, pendingProposalsLine } from '../agents/guide';
import { WarningIcon } from '../agents/setupIcons';
import { AgentTile } from '../agents/components';
import {
  BotIcon,
  ChevronDownIcon,
  ClockIcon,
  ChevronRightSmallIcon,
  HomeIcon,
  PauseIcon,
  ShieldCheckIcon,
  UsersIcon,
} from '../agents/icons';
import { ArrowLeftIcon, PlusIcon, SearchIcon, SettingsIcon } from '../icons/Icons';
import { isTauriAvailable } from '../health/api';

export interface SidebarNavItem {
  id: string;
  icon: JSX.Element;
  label: string;
  group: string;
  onClick: () => void;
  active?: boolean;
  badge?: boolean;
  badgeCount?: number;
}

interface SidebarProps {
  navItems: SidebarNavItem[];
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

export const GROUPS_STORAGE_KEY = 'seraphine.sidebar.groups';
const DEFAULT_OPEN_GROUP = 'Núcleo';

function readGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeGroups(groups: Record<string, boolean>): void {
  try {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    /* storage unavailable: the choice just won't be remembered */
  }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function itemLabel(item: SidebarNavItem): string {
  if (item.badgeCount && item.badgeCount > 0) return `${item.label}, ${item.badgeCount} pendentes`;
  if (item.badge) return `${item.label}, com novidades`;
  return item.label;
}

function Brand({ subtitle, onClick }: { subtitle: string; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="shell-brand" onClick={onClick} aria-label="Seraphine, ir para o chat">
      <img src={seraphineLogo} alt="" aria-hidden="true" className="shell-brand__logo" />
      <span className="shell-brand__text">
        <span className="shell-brand__name">Seraphine</span>
        <span className="shell-brand__sub">{subtitle}</span>
      </span>
    </button>
  );
}

function CountBadge({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span className="shell-badge" aria-hidden="true">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function PersonalNav({ navItems }: { navItems: SidebarNavItem[] }): JSX.Element {
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, SidebarNavItem[]>();
    for (const item of navItems) {
      if (!byGroup.has(item.group)) {
        byGroup.set(item.group, []);
        order.push(item.group);
      }
      byGroup.get(item.group)!.push(item);
    }
    return order.map((name) => ({ name, items: byGroup.get(name)! }));
  }, [navItems]);

  const activeGroup = groups.find((g) => g.items.some((i) => i.active))?.name ?? null;

  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const stored = readGroups();
    const initial = { ...stored };
    if (!(DEFAULT_OPEN_GROUP in initial)) initial[DEFAULT_OPEN_GROUP] = true;
    if (activeGroup) initial[activeGroup] = true;
    return initial;
  });

  // Moving to a view (palette, dashboard shortcut, deep link) opens its group.
  useEffect(() => {
    if (!activeGroup) return;
    setOpen((prev) => {
      if (prev[activeGroup]) return prev;
      const next = { ...prev, [activeGroup]: true };
      writeGroups(next);
      return next;
    });
  }, [activeGroup]);

  const toggle = (name: string): void => {
    setOpen((prev) => {
      const next = { ...prev, [name]: !prev[name] };
      writeGroups(next);
      return next;
    });
  };

  return (
    <>
      {groups.map(({ name, items }) => {
        const isOpen = !!open[name];
        const listId = `shell-group-${name.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase()}`;
        const pending = items.reduce((n, i) => n + (i.badgeCount ?? (i.badge ? 1 : 0)), 0);
        return (
          <div className="shell-group" key={name}>
            <button
              type="button"
              className="shell-group__head"
              aria-expanded={isOpen}
              aria-controls={listId}
              onClick={() => toggle(name)}
            >
              <span className="shell-group__name">{name}</span>
              {!isOpen && pending > 0 && <span className="shell-group__dot" aria-label="com novidades" role="img" />}
              {isOpen ? <ChevronDownIcon /> : <ChevronRightSmallIcon />}
            </button>
            {isOpen && (
              <div className="shell-group__items" id={listId}>
                {items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`shell-item shell-item--nested${item.active ? ' is-active' : ''}`}
                    {...(item.active ? { 'aria-current': 'page' as const } : {})}
                    aria-label={itemLabel(item)}
                    onClick={item.onClick}
                  >
                    <span className="shell-item__icon">{item.icon}</span>
                    <span className="shell-item__label">{item.label}</span>
                    {item.badgeCount && item.badgeCount > 0 ? (
                      <CountBadge count={item.badgeCount} />
                    ) : item.badge ? (
                      <span className="shell-dot" aria-hidden="true" />
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function AgentsNav(): JSX.Element {
  const setActiveView = useUiStore((s) => s.setActiveView);
  const route = useAgentsStore((s) => s.route);
  const navigate = useAgentsStore((s) => s.navigate);
  const allProjects = useAgentsStore((s) => s.projects);
  const projects = useMemo(() => plainProjects(allProjects), [allProjects]);
  const agents = useAgentsStore((s) => s.agents);
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const homeError = useAgentsStore((s) => s.homeError);
  const openBuilder = useAgentsStore((s) => s.openBuilder);
  const openAgentConversation = useAgentsStore((s) => s.openAgentConversation);
  const runs = useAgentsStore((s) => s.runs);
  const approvals = useAgentsStore((s) => s.approvals);
  const pendingCount = useAgentsStore((s) => countPending(s.approvals));
  const ready = useAgentsStore((s) => s.harnessState === 'ready');
  const routinesAvailable = useAgentsStore((s) => s.routinesState !== 'unavailable');
  const routinesActive = useAgentsStore((s) => activeRoutineCount(Object.values(s.routines)));
  const guideAvailable = useAgentsStore((s) => s.guideState !== 'unavailable');
  const guideProposals = useAgentsStore((s) => s.guideProposals);
  const guideWaiting = useMemo(() => pendingProposalCount(guideProposals), [guideProposals]);

  const runList = useMemo(() => Object.values(runs), [runs]);
  const projectActivity = useMemo(() => {
    const out = new Map<string, { waiting: number; working: number; logins: number }>();
    for (const a of Object.values(approvals)) {
      if (a.status !== 'pending') continue;
      const cur = out.get(a.project_id) ?? { waiting: 0, working: 0, logins: 0 };
      cur.waiting += 1;
      out.set(a.project_id, cur);
    }
    for (const r of runList) {
      if (!isActiveRun(r)) continue;
      const cur = out.get(r.project_id) ?? { waiting: 0, working: 0, logins: 0 };
      cur.working += 1;
      // A run parked for a missing login or credential, or for the answer to its question, waits on the owner too.
      if (isWaitingForLogin(r) || isWaitingForAnswer(r)) {
        cur.waiting += 1;
        cur.logins += 1;
      }
      out.set(r.project_id, cur);
    }
    return out;
  }, [approvals, runList]);

  const goApprovals = (): void => {
    navigate({ screen: 'home' });
    requestAnimationFrame(() => {
      document.getElementById('agents-waiting')?.scrollIntoView?.({ block: 'start' });
    });
  };

  return (
    <>
      <button type="button" className="shell-item shell-item--row" onClick={() => setActiveView('chat')}>
        <span className="shell-item__icon">
          <ArrowLeftIcon size={18} />
        </span>
        <span className="shell-item__label">Vida pessoal</span>
        <span className="shell-item__hint">hábitos, finanças, notas</span>
      </button>

      <div className="shell-group__items shell-group__items--flat">
        <button
          type="button"
          className={`shell-item${route.screen === 'home' ? ' is-active' : ''}`}
          {...(route.screen === 'home' ? { 'aria-current': 'page' as const } : {})}
          onClick={() => navigate({ screen: 'home' })}
        >
          <span className="shell-item__icon"><HomeIcon /></span>
          <span className="shell-item__label">Início</span>
        </button>
        <button
          type="button"
          className="shell-item"
          aria-label={ready && pendingCount > 0 ? `Aprovações, ${pendingCount} pendentes` : 'Aprovações'}
          onClick={goApprovals}
        >
          <span className="shell-item__icon"><ShieldCheckIcon /></span>
          <span className="shell-item__label">Aprovações</span>
          {ready && <span className="shell-amber"><CountBadge count={pendingCount} /></span>}
        </button>
        <button
          type="button"
          className={`shell-item${route.screen === 'roster' ? ' is-active' : ''}`}
          {...(route.screen === 'roster' ? { 'aria-current': 'page' as const } : {})}
          onClick={() => navigate({ screen: 'roster' })}
        >
          <span className="shell-item__icon"><UsersIcon /></span>
          <span className="shell-item__label">Agentes</span>
        </button>
        {routinesAvailable && (
          <button
            type="button"
            className={`shell-item${route.screen === 'routines' ? ' is-active' : ''}`}
            {...(route.screen === 'routines' ? { 'aria-current': 'page' as const } : {})}
            aria-label={routinesActive > 0 ? `Rotinas, ${routinesActive} ${routinesActive === 1 ? 'ativa' : 'ativas'}` : 'Rotinas'}
            onClick={() => navigate({ screen: 'routines' })}
          >
            <span className="shell-item__icon"><ClockIcon /></span>
            <span className="shell-item__label">Rotinas</span>
            {routinesActive > 0 && (
              <span className="shell-count" aria-hidden="true">
                {routinesActive > 99 ? '99+' : routinesActive}
              </span>
            )}
          </button>
        )}
      </div>

      <div className="shell-group">
        <span className="shell-eyebrow" id="shell-projects-title">PROJETOS</span>
        <div className="shell-group__items shell-group__items--flat" role="group" aria-labelledby="shell-projects-title">
          {projects.length === 0 && <span className="shell-empty">Nenhum projeto ainda</span>}
          {projects.map((p) => {
            const act = projectActivity.get(p.id);
            const current = route.screen === 'project' && route.projectId === p.id;
            const dotLabel = act?.waiting
              ? act.logins
                ? `${plural(act.waiting, 'item espera', 'itens esperam')} você`
                : `${plural(act.waiting, 'pedido espera', 'pedidos esperam')} você`
              : act?.working
                ? plural(act.working, 'agente trabalhando', 'agentes trabalhando')
                : null;
            return (
              <button
                key={p.id}
                type="button"
                className={`shell-item shell-item--project${current ? ' is-active' : ''}`}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                onClick={() => navigate({ screen: 'project', projectId: p.id })}
              >
                <span className="shell-hash" aria-hidden="true">#</span>
                <span className="shell-item__label" title={p.name}>{p.name}</span>
                {dotLabel && <span className="shell-dot" role="img" aria-label={dotLabel} />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="shell-group">
        <span className="shell-eyebrow" id="shell-agents-title">AGENTES</span>
        <div className="shell-group__items shell-group__items--flat" role="group" aria-labelledby="shell-agents-title">
          {guideAvailable && (
            <button
              type="button"
              className={`shell-item shell-item--agent${route.screen === 'guide' ? ' is-active' : ''}`}
              {...(route.screen === 'guide' ? { 'aria-current': 'page' as const } : {})}
              onClick={() => navigate({ screen: 'guide' })}
            >
              <img src={seraphineLogo} alt="" aria-hidden="true" className="shell-guide__mark" />
              <span className="shell-agent">
                <span className="shell-agent__name">Seraphine</span>
                <small>monta e ajusta os seus agentes</small>
              </span>
              {guideWaiting > 0 && <span className="shell-dot" role="img" aria-label={pendingProposalsLine(guideWaiting)} />}
            </button>
          )}
          {agents.length === 0 && <span className="shell-empty">Nenhum agente ainda</span>}
          {agents.map((a) => {
            const st = agentStateLabel(a, runList);
            const color = safeColor(a.color);
            const engine = agentEngineState(a, engines, providers);
            const current = route.screen === 'project' && !!a.home_project_id && route.projectId === a.home_project_id;
            return (
              <button
                key={a.id}
                type="button"
                className={`shell-item shell-item--agent${current ? ' is-active' : ''}`}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                aria-describedby={engine.ready || !engine.how ? undefined : `shell-agent-how-${a.id}`}
                onClick={() => void openAgentConversation(a.id)}
              >
                <AgentTile name={a.name} color={color} size="sm" />
                <span className="shell-agent">
                  <span className="shell-agent__name" title={a.name}>
                    {a.name}
                    {!engine.ready && (
                      <span className="shell-chip" title={engine.how || undefined}>
                        <WarningIcon size={11} />
                        Sem motor
                      </span>
                    )}
                    {!a.enabled && (
                      <span className="shell-chip">
                        <PauseIcon size={11} />
                        Pausado
                      </span>
                    )}
                  </span>
                  {!engine.ready && engine.how && (
                    <span className="shell-sr-only" id={`shell-agent-how-${a.id}`}>
                      {engine.how}
                    </span>
                  )}
                  <small className={st.waiting ? 'is-waiting' : st.busy ? 'is-busy' : ''}>
                    {[a.role, a.enabled ? st.label : ''].filter(Boolean).join(' · ')}
                  </small>
                </span>
              </button>
            );
          })}
          {homeError && (
            <span className="shell-empty" role="alert">
              {homeError}
            </span>
          )}
          <button type="button" className="shell-item shell-item--muted" onClick={openBuilder}>
            <span className="shell-item__icon"><PlusIcon size={16} /></span>
            <span className="shell-item__label">Criar agente</span>
          </button>
        </div>
      </div>

      <div className="shell-group__items shell-group__items--flat">
        <button
          type="button"
          className={`shell-item${route.screen === 'settings' ? ' is-active' : ''}`}
          {...(route.screen === 'settings' ? { 'aria-current': 'page' as const } : {})}
          onClick={() => navigate({ screen: 'settings' })}
        >
          <span className="shell-item__icon"><SettingsIcon size={18} /></span>
          <span className="shell-item__label">Ajustes</span>
        </button>
      </div>
    </>
  );
}

export function Sidebar({ navItems, onOpenSettings, onOpenPalette }: SidebarProps): JSX.Element {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const harnessReady = useAgentsStore((s) => s.harnessState === 'ready');
  const pendingCount = useAgentsStore((s) => countPending(s.approvals));
  const projectCount = useAgentsStore((s) => s.projects.filter((p) => p.kind !== 'home').length);
  const agentCount = useAgentsStore((s) => s.agents.length);
  const inAgents = activeView === 'agents';

  // The old Maestro UI drives Tauri-only commands; it has nothing to show in a browser.
  const visibleItems = useMemo(
    () => navItems.filter((i) => i.id !== 'maestro' || isTauriAvailable()),
    [navItems],
  );

  const subtitle = inAgents
    ? `${plural(projectCount, 'projeto', 'projetos')} · ${plural(agentCount, 'agente', 'agentes')}`
    : 'sua assistente';

  return (
    <nav className="shell-sidebar" aria-label="Navegação principal">
      <Brand subtitle={subtitle} onClick={() => setActiveView('chat')} />

      <button type="button" className="shell-goto" onClick={onOpenPalette}>
        <SearchIcon size={16} />
        <span className="shell-goto__text">Ir para…</span>
        <kbd className="shell-kbd">Ctrl K</kbd>
      </button>

      <div className="shell-scroll">
        {inAgents ? (
          <AgentsNav />
        ) : (
          <>
            <button type="button" className="shell-item shell-item--row shell-item--bordered" onClick={() => setActiveView('agents')}>
              <span className="shell-item__icon"><BotIcon /></span>
              <span className="shell-item__label">Agentes e projetos</span>
              {harnessReady && pendingCount > 0 && (
                <span className="shell-amber" aria-label={`${pendingCount} aprovações esperando você`} role="img">
                  <CountBadge count={pendingCount} />
                </span>
              )}
            </button>
            <PersonalNav navItems={visibleItems} />
          </>
        )}
      </div>

      <button type="button" className="shell-item shell-item--settings" onClick={onOpenSettings}>
        <span className="shell-item__icon"><SettingsIcon size={18} /></span>
        <span className="shell-item__label">Configurações</span>
      </button>
    </nav>
  );
}
