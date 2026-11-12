import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, GROUPS_STORAGE_KEY } from '../Sidebar';
import type { SidebarNavItem } from '../Sidebar';
import { useUiStore } from '../../stores/uiStore';
import { resetAgentsStore, useAgentsStore } from '../../agents/store';
import { makeAgent, makeApproval, makeParkedRun, makeProject, makeRun } from '../../agents/__tests__/fixtures';

function items(activeId: string, handlers: Record<string, () => void> = {}): SidebarNavItem[] {
  const def = (id: string, label: string, group: string, extra: Partial<SidebarNavItem> = {}): SidebarNavItem => ({
    id,
    label,
    group,
    icon: <svg data-testid={`icon-${id}`} />,
    onClick: handlers[id] ?? (() => undefined),
    active: activeId === id,
    ...extra,
  });
  return [
    def('chat', 'Chat', 'Núcleo'),
    def('dashboard', 'Dashboard', 'Núcleo'),
    def('tasks', 'Tarefas', 'Produtividade', { badgeCount: 3 }),
    def('habits', 'Hábitos', 'Produtividade'),
    def('notes', 'Notas', 'Conhecimento'),
    def('inbox', 'Inbox', 'Comunicação', { badge: true }),
    def('maestro', 'Maestro', 'Trabalho'),
    def('system', 'Sistema', 'Sistema'),
  ];
}

function renderSidebar(activeId = 'chat', over: { settings?: () => void; palette?: () => void; handlers?: Record<string, () => void> } = {}) {
  const props = {
    onOpenSettings: over.settings ?? vi.fn(),
    onOpenPalette: over.palette ?? vi.fn(),
  };
  const utils = render(<Sidebar navItems={items(activeId, over.handlers)} {...props} />);
  return {
    ...utils,
    props,
    rerenderWith: (id: string) => utils.rerender(<Sidebar navItems={items(id)} {...props} />),
  };
}

beforeEach(() => {
  localStorage.clear();
  resetAgentsStore();
  useUiStore.setState({ activeView: 'chat' });
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
afterEach(() => cleanup());

describe('Sidebar personal space', () => {
  it('renders collapsible groups; only the active group (and Núcleo) start open', () => {
    renderSidebar('chat');
    expect(screen.getByRole('button', { name: /Núcleo/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Produtividade/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('button', { name: /Hábitos/ })).toBeNull();
  });

  it('expands and collapses a group and remembers it in localStorage', () => {
    renderSidebar('chat');
    const head = screen.getByRole('button', { name: /Produtividade/ });
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Hábitos' })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) ?? '{}').Produtividade).toBe(true);

    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) ?? '{}').Produtividade).toBe(false);
  });

  it('restores remembered groups and survives unreadable storage', () => {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify({ Produtividade: true, Núcleo: false }));
    const first = renderSidebar('notes');
    expect(screen.getByRole('button', { name: /Produtividade/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Núcleo/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /Conhecimento/ }).getAttribute('aria-expanded')).toBe('true');
    first.unmount();

    localStorage.setItem(GROUPS_STORAGE_KEY, '{not json');
    renderSidebar('chat');
    expect(screen.getByRole('button', { name: /Núcleo/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('opens the group that contains the active view, at mount and when it changes', () => {
    const view = renderSidebar('tasks');
    expect(screen.getByRole('button', { name: /Produtividade/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Conhecimento/ }).getAttribute('aria-expanded')).toBe('false');
    view.rerenderWith('notes');
    expect(screen.getByRole('button', { name: /Conhecimento/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Notas' }).getAttribute('aria-current')).toBe('page');
  });

  it('keeps item click handlers and badges', () => {
    const onTasks = vi.fn();
    renderSidebar('tasks', { handlers: { tasks: onTasks } });
    const tasks = screen.getByRole('button', { name: 'Tarefas, 3 pendentes' });
    fireEvent.click(tasks);
    expect(onTasks).toHaveBeenCalledTimes(1);
    expect(within(tasks).getByText('3')).toBeTruthy();
  });

  it('flags a closed group that has news', () => {
    renderSidebar('chat');
    expect(within(screen.getByRole('button', { name: /Comunicação/ })).getByRole('img', { name: 'com novidades' })).toBeTruthy();
  });

  it('hides Maestro outside Tauri and shows it inside', () => {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify({ Trabalho: true }));
    const outside = renderSidebar('chat');
    expect(screen.queryByRole('button', { name: 'Maestro' })).toBeNull();
    outside.unmount();

    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderSidebar('chat');
    expect(screen.getByRole('button', { name: 'Maestro' })).toBeTruthy();
  });

  it('opens the palette and the settings', () => {
    const { props } = renderSidebar('chat');
    fireEvent.click(screen.getByRole('button', { name: /Ir para/ }));
    expect(props.onOpenPalette).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Ctrl K')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Configurações' }));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar agents badge and space switch', () => {
  it('shows the amber pending count only when the harness is ready and something waits', () => {
    useAgentsStore.setState({ harnessState: 'ready', approvals: { a: makeApproval({ id: 'a' }), b: makeApproval({ id: 'b' }) } });
    const view = renderSidebar('chat');
    const row = screen.getByRole('button', { name: /Agentes e projetos/ });
    expect(within(row).getByRole('img', { name: '2 aprovações esperando você' })).toBeTruthy();
    view.unmount();

    useAgentsStore.setState({ approvals: { a: makeApproval({ id: 'a', status: 'approved' }) } });
    renderSidebar('chat');
    expect(screen.queryByRole('img', { name: /aprovações esperando você/ })).toBeNull();
  });

  it('hides the badge when the harness is not ready', () => {
    useAgentsStore.setState({ harnessState: 'disabled', approvals: { a: makeApproval({ id: 'a' }) } });
    renderSidebar('chat');
    expect(screen.queryByRole('img', { name: /aprovações esperando você/ })).toBeNull();
  });

  it('counts runs parked for a missing login as waiting on the owner, per project', () => {
    useUiStore.setState({ activeView: 'agents' });
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject(), makeProject({ id: 'p2', name: 'site' })],
      agents: [makeAgent()],
      approvals: { ap1: makeApproval() },
      runs: {
        r1: makeParkedRun('auth'),
        r2: makeParkedRun('auth', { id: 'r2', project_id: 'p2' }),
        r3: makeParkedRun('outage', { id: 'r3', project_id: 'p2' }),
      },
    });
    renderSidebar('chat');
    // p1: one approval + one login wait; p2: one login wait (the outage does not wait on the owner)
    expect(within(screen.getByRole('button', { name: /loja/ })).getByRole('img', { name: '2 itens esperam você' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /site/ })).getByRole('img', { name: '1 item espera você' })).toBeTruthy();
    // the approvals badge still counts approvals only
    expect(screen.getByRole('button', { name: 'Aprovações, 1 pendentes' })).toBeTruthy();
  });

  it('a parked outage alone only shows the project as working', () => {
    useUiStore.setState({ activeView: 'agents' });
    useAgentsStore.setState({ harnessState: 'ready', projects: [makeProject()], agents: [makeAgent()], runs: { r1: makeParkedRun('outage') } });
    renderSidebar('chat');
    expect(within(screen.getByRole('button', { name: /loja/ })).getByRole('img', { name: '1 agente trabalhando' })).toBeTruthy();
  });

  it('switches to the agents space and back to personal life', () => {
    renderSidebar('chat');
    fireEvent.click(screen.getByRole('button', { name: /Agentes e projetos/ }));
    expect(useUiStore.getState().activeView).toBe('agents');
  });

  it('shows the agents navigation, projects with activity and agents with their state', () => {
    useUiStore.setState({ activeView: 'agents' });
    useAgentsStore.setState({
      harnessState: 'ready',
      projects: [makeProject(), makeProject({ id: 'p2', name: 'site' })],
      agents: [makeAgent(), makeAgent({ id: 'ag2', name: 'Vigia', role: 'infra', color: '#7fb2ff' })],
      approvals: { ap1: makeApproval() },
      runs: { r1: makeRun({ status: 'waiting_approval' }) },
    });
    renderSidebar('chat');

    expect(screen.getByRole('button', { name: /Vida pessoal/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Início' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'Aprovações, 1 pendentes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Núcleo/ })).toBeNull();
    expect(screen.getByText('2 projetos · 2 agentes')).toBeTruthy();

    const loja = screen.getByRole('button', { name: /loja/ });
    expect(within(loja).getByRole('img', { name: '1 pedido espera você' })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /site/ })).queryByRole('img')).toBeNull();
    expect(screen.getByText('código · espera você')).toBeTruthy();
    expect(screen.getByText('infra · livre')).toBeTruthy();

    fireEvent.click(loja);
    expect(useAgentsStore.getState().route).toEqual({ screen: 'project', projectId: 'p1' });
    // (clicking an agent opens its own conversation: see agents/__tests__/agent-home.test.tsx)
    fireEvent.click(screen.getByRole('button', { name: 'Início' }));
    expect(useAgentsStore.getState().route.screen).toBe('home');

    fireEvent.click(screen.getByRole('button', { name: /Vida pessoal/ }));
    expect(useUiStore.getState().activeView).toBe('chat');
  });
});
