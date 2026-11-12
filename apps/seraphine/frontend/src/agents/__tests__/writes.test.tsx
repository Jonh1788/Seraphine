/** Step 3c (screen): the third access level "Ler e escrever" in "Ferramentas e acesso", its explanation and the new fixed sentence. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEngine, makeProject, makeProvider, makeToolGroups, makeWriteToolGroups } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    resetToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getAgentTools: vi.fn(),
    setAgentGrants: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    getBridgeStatus: vi.fn(),
  };
});

import * as api from '../api';
import { grantsSummary, groupLevelOptions, writeAccessLine, TOOLS_FIXED_NOTE } from '../lib';
import { RosterScreen } from '../RosterScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ConfirmProvider } from '../../ui';
import type { Agent } from '../types';

const mocked = vi.mocked(api);

const FIXED = 'Ler e escrever dependem da sua escolha em cada grupo. Nada aqui deixa um agente apagar, enviar algo para fora do seu computador ou gastar dinheiro.';
const OLD_FIXED = 'Nesta versão, os agentes só leem por estas ferramentas';
const NOTES_WRITE =
  'Aqui o agente poderá criar uma nota e alterar uma nota. Cada coisa que ele escrever aparece na conversa e você pode desfazer por alguns minutos.';
const TASKS_WRITE =
  'Aqui o agente poderá criar uma tarefa e alterar uma tarefa. Cada coisa que ele escrever aparece na conversa e você pode desfazer por alguns minutos.';
const REMINDERS_WRITE =
  'Aqui o agente poderá criar um lembrete. Cada coisa que ele escrever aparece na conversa e você pode desfazer por alguns minutos.';

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getBridgeStatus.mockResolvedValue([]);
  mocked.getAgentTools.mockResolvedValue(makeWriteToolGroups());
});
afterEach(() => cleanup());

function seed(over: Record<string, unknown> = {}): void {
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [],
    tools: makeWriteToolGroups(),
    toolsState: 'ready',
    engines: [makeEngine({ name: 'codex' }), makeEngine({ name: 'claude_code' }), makeEngine({ name: 'chat', can_act: false })],
    providers: [
      makeProvider(),
      makeProvider({ id: 'anthropic', label: 'Anthropic (login do Claude Code)', runtimes: ['claude_code'] }),
      makeProvider({ id: 'ollama', label: 'Ollama (local)', kind: 'local', runtimes: ['chat', 'codex'] }),
    ],
    ...over,
  });
}

const renderRoster = (): void => {
  render(
    <ConfirmProvider>
      <RosterScreen />
    </ConfirmProvider>,
  );
};
const group = (name: string): HTMLElement => screen.getByRole('radiogroup', { name });
const radio = (groupName: string, level: string): HTMLInputElement => within(group(groupName)).getByRole('radio', { name: level }) as HTMLInputElement;
const levelsOf = (name: string): (string | null | undefined)[] => within(group(name)).getAllByRole('radio').map((r) => r.closest('label')?.textContent);

function openExisting(agent: Agent = makeAgent()): void {
  seed({ agents: [agent] });
  renderRoster();
  fireEvent.click(screen.getByRole('button', { name: new RegExp(agent.name) }));
}

describe('the third level, only where the group writes', () => {
  it('offers "Ler e escrever" in the groups whose levels include write, and only there', () => {
    openExisting();
    expect(levelsOf('Notas')).toEqual(['Sem acesso', 'Ler', 'Ler e escrever']);
    expect(levelsOf('Tarefas do projeto')).toEqual(['Sem acesso', 'Ler', 'Ler e escrever']);
    expect(levelsOf('Lembretes')).toEqual(['Sem acesso', 'Ler', 'Ler e escrever']);
    expect(levelsOf('Wiki')).toEqual(['Sem acesso', 'Ler']);
    expect(levelsOf('Memória pessoal')).toEqual(['Sem acesso', 'Ler']);
  });

  it('a catalogue without levels (an older backend) offers no third level anywhere', () => {
    seed({ tools: makeToolGroups(), agents: [makeAgent()] });
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: /Forja/ }));
    expect(screen.queryByRole('radio', { name: 'Ler e escrever' })).toBeNull();
  });

  it('the reminders group starts at "Sem acesso" (the default comes from the catalogue)', () => {
    seed();
    renderRoster();
    fireEvent.click(screen.getByRole('button', { name: /Criar agente/ }));
    expect(radio('Lembretes', 'Sem acesso').checked).toBe(true);
    expect(radio('Notas', 'Ler').checked).toBe(true);
    expect(radio('Tarefas do projeto', 'Ler').checked).toBe(true);
    // a new agent never starts with a write level
    expect(screen.queryAllByRole('radio').filter((r) => (r as HTMLInputElement).checked && (r as HTMLInputElement).value === 'write')).toHaveLength(0);
  });

  it('shows an agent that already writes with that level selected', () => {
    openExisting(makeAgent({ grants: { notes: 'write', wiki: 'read', memory: 'none', project_tasks: 'none', reminders: 'write' } }));
    expect(radio('Notas', 'Ler e escrever').checked).toBe(true);
    expect(radio('Tarefas do projeto', 'Sem acesso').checked).toBe(true);
    expect(radio('Lembretes', 'Ler e escrever').checked).toBe(true);
  });
});

describe('what the agent will be able to do', () => {
  it('says it in plain words, built from the labels of that group\'s write tools, only under a group set to write', () => {
    openExisting();
    expect(screen.queryByText(NOTES_WRITE)).toBeNull();
    fireEvent.click(radio('Notas', 'Ler e escrever'));
    const line = screen.getByText(NOTES_WRITE);
    expect(line.closest('li')).toBe(group('Notas').closest('li'));
    expect(group('Notas').getAttribute('aria-describedby')).toContain(line.id);
    // the other groups say nothing
    expect(screen.queryByText(TASKS_WRITE)).toBeNull();
    expect(screen.queryByText(REMINDERS_WRITE)).toBeNull();
    fireEvent.click(radio('Lembretes', 'Ler e escrever'));
    expect(screen.getByText(REMINDERS_WRITE)).toBeTruthy();
    fireEvent.click(radio('Tarefas do projeto', 'Ler e escrever'));
    expect(screen.getByText(TASKS_WRITE)).toBeTruthy();
    // going back removes the line
    fireEvent.click(radio('Notas', 'Ler'));
    expect(screen.queryByText(NOTES_WRITE)).toBeNull();
  });

  it('never shows a raw tool name, and says nothing for a conversation-only agent whose controls are locked', () => {
    openExisting(makeAgent({ engine: 'chat', provider: 'ollama', grants: { notes: 'write' } }));
    expect(screen.queryByText(NOTES_WRITE)).toBeNull();
    cleanup();
    openExisting(makeAgent({ grants: { notes: 'write' } }));
    expect(document.body.textContent).not.toMatch(/create_note|update_note|create_reminder|project_task/);
  });

  it('writeAccessLine: one, two and three tools; null when the group writes nothing', () => {
    const [notes] = makeWriteToolGroups();
    expect(writeAccessLine(notes)).toBe(NOTES_WRITE);
    const tool = (label: string) => ({ name: 'x', label, description: '', read_only: false, level: 'write' as const });
    expect(writeAccessLine({ tools: [tool('Criar um lembrete')] })).toContain('poderá criar um lembrete.');
    expect(writeAccessLine({ tools: [tool('Criar'), tool('Alterar'), tool('Mover')] })).toContain('poderá criar, alterar e mover.');
    expect(writeAccessLine({ tools: makeToolGroups()[0].tools })).toBeNull();
  });

  it('groupLevelOptions keeps the order none, read, write and only what the group lists', () => {
    expect(groupLevelOptions({ levels: ['write', 'none', 'read'] }).map((o) => o.value)).toEqual(['none', 'read', 'write']);
    expect(groupLevelOptions({ levels: ['none', 'read'] }).map((o) => o.label)).toEqual(['Sem acesso', 'Ler']);
  });
});

describe('the sentence that closes the section', () => {
  it('is the new one: reading and writing are the owner\'s choice, and deleting, sending out and spending stay out', () => {
    openExisting();
    const section = screen.getByRole('group', { name: 'Ferramentas e acesso' });
    expect(within(section).getByText(FIXED)).toBeTruthy();
    expect(TOOLS_FIXED_NOTE).toBe(FIXED);
    expect(section.textContent).not.toContain(OLD_FIXED);
    expect(section.textContent).not.toMatch(/MCP|bridge|grant/i);
  });
});

describe('saving the write level', () => {
  it('sends the whole set with `write` where the owner chose it', async () => {
    mocked.setAgentGrants.mockResolvedValue({ notes: 'write', wiki: 'read', memory: 'none', project_tasks: 'read', reminders: 'none' });
    openExisting();
    fireEvent.click(radio('Notas', 'Ler e escrever'));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(mocked.setAgentGrants).toHaveBeenCalledWith('ag1', { notes: 'write', wiki: 'read', memory: 'none', project_tasks: 'read', reminders: 'none' }),
    );
    await waitFor(() => expect(useAgentsStore.getState().agents[0].grants.notes).toBe('write'));
    expect(mocked.updateAgent).not.toHaveBeenCalled();
  });

  it('the roster line names the groups an agent writes in', () => {
    const tools = makeWriteToolGroups();
    expect(grantsSummary({ engine: 'codex', grants: { notes: 'write', wiki: 'read', memory: 'none', project_tasks: 'read', reminders: 'write' } }, tools)).toBe(
      'Lê: wiki, tarefas do projeto · Lê e escreve: notas, lembretes',
    );
  });
});
