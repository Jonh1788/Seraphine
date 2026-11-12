/** Step 3c: the panel "Ferramentas da Seraphine nos agentes": the state of each engine in words, the test button and its result. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeBridgeStatus, makeEngine, makeProject, makeToolGroups } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    getBridgeStatus: vi.fn(),
    testBridge: vi.fn(),
  };
});

import * as api from '../api';
import { ApiError } from '../api';
import { BridgePanel } from '../BridgePanel';
import { bridgeStatusLine, bridgeTestHint, bridgeTestLine, tookLabel } from '../lib';
import { RosterScreen } from '../RosterScreen';
import { resetAgentsStore, useAgentsStore } from '../store';
import { ConfirmProvider } from '../../ui';
import type { BridgeEngineStatus, BridgeTestResult } from '../types';

const mocked = vi.mocked(api);
const store = () => useAgentsStore.getState();

const codex = (over: Partial<BridgeEngineStatus> = {}): BridgeEngineStatus => makeBridgeStatus(over);
const claude = (over: Partial<BridgeEngineStatus> = {}): BridgeEngineStatus =>
  makeBridgeStatus({ engine: 'claude_code', label: 'Claude Code', state: 'unknown', last_ok_at: null, ...over });

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getBridgeStatus.mockResolvedValue([codex(), claude()]);
});
afterEach(() => cleanup());

const row = (name: string): HTMLElement => screen.getByRole('button', { name: `Testar ${name}` }).closest('li') as HTMLElement;
const testButton = (name: string): HTMLButtonElement => screen.getByRole('button', { name: new RegExp(`^Testar ${name}$`) }) as HTMLButtonElement;

describe('the three states, in words', () => {
  it('working, failed with the reason and not used yet, each with the time of the last success', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    mocked.getBridgeStatus.mockResolvedValue([
      codex({ last_ok_at: recent }),
      claude({ state: 'failed', last_failure: 'O motor não avisou que as ferramentas estavam presentes.', last_failure_at: recent, last_ok_at: '2025-12-31T14:30:00Z' }),
      { engine: 'extra', label: 'Outro motor', state: 'unknown', last_ok_at: null, last_failure_at: null, last_failure: null },
    ]);
    render(<BridgePanel />);
    expect(await screen.findByText('FERRAMENTAS DA SERAPHINE NOS AGENTES')).toBeTruthy();
    await waitFor(() => expect(within(row('Codex')).getByText(/^Funcionando · último sucesso às \d{2}:\d{2}$/)).toBeTruthy());
    const failed = within(row('Claude Code')).getByText(/^Falhou: /);
    expect(failed.textContent).toMatch(/^Falhou: O motor não avisou que as ferramentas estavam presentes\. · último sucesso em 31\/12(\/\d{4})? \d{2}:\d{2}$/);
    expect(failed.className).toContain('a-bridge__state--failed');
    expect(within(row('Outro motor')).getByText('Ainda não usado desde que a Seraphine ligou')).toBeTruthy();
    // no engine names or codes of the plumbing reach the screen
    expect(document.body.textContent).not.toMatch(/MCP|bridge|grant|claude_code|test_running/i);
  });

  it('bridgeStatusLine: a failure without a reason and a working engine without a time', () => {
    expect(bridgeStatusLine({ state: 'failed', last_ok_at: null, last_failure: null })).toBe('Falhou na última vez');
    expect(bridgeStatusLine({ state: 'ok', last_ok_at: null, last_failure: null })).toBe('Funcionando');
    expect(bridgeStatusLine({ state: 'unknown', last_ok_at: null, last_failure: null })).toBe('Ainda não usado desde que a Seraphine ligou');
  });

  it('says it is loading, then offers a new try when the state could not be read', async () => {
    mocked.getBridgeStatus.mockRejectedValueOnce(new ApiError(500, 'x'));
    render(<BridgePanel />);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    expect(await screen.findByText(/Não consegui ver o estado agora\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Codex')).toBeTruthy();
  });

  it('is not there at all on a backend that has no such route', async () => {
    mocked.getBridgeStatus.mockRejectedValue(new ApiError(404, 'Not Found'));
    const { container } = render(<BridgePanel />);
    await waitFor(() => expect(store().bridge.state).toBe('unavailable'));
    expect(container.textContent).toBe('');
  });

  it('sits in the roster screen', async () => {
    useAgentsStore.setState({ harnessState: 'ready', projects: [makeProject()], agents: [makeAgent()], tools: makeToolGroups(), toolsState: 'ready', engines: [makeEngine()] });
    render(
      <ConfirmProvider>
        <RosterScreen />
      </ConfirmProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Testar Codex' })).toBeTruthy();
  });
});

describe('the test button', () => {
  it('says plainly, before running, that the test uses a little of the owner\'s plan for that engine', async () => {
    render(<BridgePanel />);
    await screen.findByText('Codex');
    const hint = within(row('Codex')).getByText('O teste usa um pouco do seu plano do Codex.');
    expect(testButton('Codex').getAttribute('aria-describedby')).toBe(hint.id);
    expect(within(row('Claude Code')).getByText('O teste usa um pouco do seu plano do Claude Code.')).toBeTruthy();
    expect(bridgeTestHint('Codex')).toBe('O teste usa um pouco do seu plano do Codex.');
    // nothing is tested until the owner asks
    expect(mocked.testBridge).not.toHaveBeenCalled();
  });

  it('shows progress while it runs and disables the other engine\'s button', async () => {
    let finish: (r: BridgeTestResult) => void = () => undefined;
    mocked.testBridge.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<BridgePanel />);
    await screen.findByText('Codex');
    fireEvent.click(testButton('Codex'));
    fireEvent.click(testButton('Codex'));
    expect(mocked.testBridge).toHaveBeenCalledTimes(1);
    expect(mocked.testBridge).toHaveBeenCalledWith('codex');
    const mine = screen.getByRole('button', { name: 'Testar Codex' }) as HTMLButtonElement;
    expect(mine.textContent).toBe('Testando…');
    expect(mine.disabled).toBe(true);
    expect(mine.className).toContain('is-busy');
    expect(testButton('Claude Code').disabled).toBe(true);
    expect(within(row('Codex')).getByText('Testando… pode levar até um minuto.')).toBeTruthy();
    await act(async () => finish({ ok: true, detail: 'Respondeu.', took_ms: 3200 }));
    await waitFor(() => expect(testButton('Claude Code').disabled).toBe(false));
  });

  it('a successful test shows how long it took in the row, and the status is read again', async () => {
    mocked.testBridge.mockResolvedValue({ ok: true, detail: 'A ferramenta respondeu.', took_ms: 3200 });
    render(<BridgePanel />);
    await screen.findByText('Codex');
    expect(mocked.getBridgeStatus).toHaveBeenCalledTimes(1);
    fireEvent.click(testButton('Codex'));
    const result = await within(row('Codex')).findByText('Funcionou em 3,2 s.');
    expect(result.className).toContain('a-bridge__result--ok');
    expect(within(row('Claude Code')).queryByText(/Funcionou em/)).toBeNull();
    await waitFor(() => expect(mocked.getBridgeStatus).toHaveBeenCalledTimes(2));
    expect(testButton('Codex').textContent).toBe('Testar');
  });

  it('a failed test shows the failure sentence in the row, in the owner\'s words', async () => {
    mocked.testBridge.mockResolvedValue({ ok: false, detail: 'O motor não chamou a ferramenta.', took_ms: 61000 });
    render(<BridgePanel />);
    await screen.findByText('Codex');
    fireEvent.click(testButton('Claude Code'));
    const result = await within(row('Claude Code')).findByText('Não funcionou: O motor não chamou a ferramenta.');
    expect(result.className).toContain('a-bridge__result--fail');
  });

  it('test_running (409) becomes a sentence', async () => {
    mocked.testBridge.mockRejectedValue(new ApiError(409, 'busy', 'test_running'));
    render(<BridgePanel />);
    await screen.findByText('Codex');
    fireEvent.click(testButton('Codex'));
    expect(await within(row('Codex')).findByText('Já tem um teste em andamento. Espere ele terminar.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('test_running');
  });

  it('any other failure says the test could not be done', async () => {
    mocked.testBridge.mockRejectedValue(new ApiError(500, 'Internal Server Error'));
    render(<BridgePanel />);
    await screen.findByText('Codex');
    fireEvent.click(testButton('Codex'));
    expect(await within(row('Codex')).findByText('Não consegui fazer o teste agora. Tente de novo em instantes.')).toBeTruthy();
    expect(screen.queryByText('Internal Server Error')).toBeNull();
    expect(testButton('Codex').disabled).toBe(false);
  });

  it('a new test clears the old sentence of that engine', async () => {
    mocked.testBridge.mockResolvedValueOnce({ ok: false, detail: 'Falhou.', took_ms: 100 });
    render(<BridgePanel />);
    await screen.findByText('Codex');
    fireEvent.click(testButton('Codex'));
    await within(row('Codex')).findByText('Não funcionou: Falhou.');
    let finish: (r: BridgeTestResult) => void = () => undefined;
    mocked.testBridge.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    fireEvent.click(testButton('Codex'));
    await waitFor(() => expect(within(row('Codex')).queryByText('Não funcionou: Falhou.')).toBeNull());
    await act(async () => finish({ ok: true, detail: '', took_ms: 1500 }));
    expect(await within(row('Codex')).findByText('Funcionou em 1,5 s.')).toBeTruthy();
  });

  it('helpers: the time in seconds with a comma, and the sentence of a failure without detail', () => {
    expect(tookLabel(3200)).toBe('3,2 s');
    expect(tookLabel(61000)).toBe('61,0 s');
    expect(bridgeTestLine({ ok: true, detail: 'x', took_ms: 800 })).toBe('Funcionou em 0,8 s.');
    expect(bridgeTestLine({ ok: false, detail: '  ', took_ms: 800 })).toBe('Não funcionou: sem detalhes');
  });

  it('the store allows one test at a time', async () => {
    let finish: (r: BridgeTestResult) => void = () => undefined;
    mocked.testBridge.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = store().testBridge('codex');
    expect(await store().testBridge('claude_code')).toEqual({ ok: false });
    expect(mocked.testBridge).toHaveBeenCalledTimes(1);
    expect(store().bridgeRunning).toBe('codex');
    finish({ ok: true, detail: '', took_ms: 1000 });
    await first;
    expect(store().bridgeRunning).toBeNull();
  });
});
