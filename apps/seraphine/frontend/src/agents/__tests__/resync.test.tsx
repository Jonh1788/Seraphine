/**
 * Step 1d (reconnection): the store's resync (what it fetches, how it merges, coalescing, what it keeps on screen), its triggers
 * (gap, new boot, reconnection after a drop) and the calm reconnection band.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeEvent, makeMessage, makeProject, makeRun, makeTask } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    resetToken: vi.fn(),
    getOverview: vi.fn(),
    listProjects: vi.fn(),
    listAgents: vi.fn(),
    getEngines: vi.fn(),
    getProviders: vi.fn(),
    getAgentTools: vi.fn(),
    openGlobalSocket: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    listMessages: vi.fn(),
    listTaskMessages: vi.fn(),
    listRunEvents: vi.fn(),
  };
});

import * as api from '../api';
import type { StreamOptions } from '../api';
import { AgentsSpace } from '../AgentsSpace';
import { ConfirmProvider } from '../../ui';
import { CONNECTION_BAND_DELAY_MS, CONNECTION_BAND_DONE_MS, ConnectionBand } from '../components';
import { resetAgentsStore, useAgentsStore } from '../store';
import type { HarnessEvent } from '../types';

const mocked = vi.mocked(api);

const emptyOverview = { pending_approvals: [], active_runs: [], spend_today: [] };
const ev = (id: number, runId = 'r1'): HarnessEvent =>
  makeEvent({ id, run_id: runId, payload: { type: 'reasoning', text: `passo ${id}` } });

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
  mocked.ensureToken.mockResolvedValue('tok');
  mocked.getEngines.mockResolvedValue([]);
  mocked.getProviders.mockResolvedValue([]);
  mocked.getAgentTools.mockResolvedValue([]);
  mocked.listProjects.mockResolvedValue([makeProject()]);
  mocked.listAgents.mockResolvedValue([makeAgent()]);
  mocked.getOverview.mockResolvedValue(emptyOverview);
  mocked.openGlobalSocket.mockReturnValue(() => undefined);
  mocked.getRun.mockResolvedValue(makeRun({ status: 'done' }));
  mocked.listRuns.mockResolvedValue([]);
  mocked.listMessages.mockResolvedValue([]);
  mocked.listTaskMessages.mockResolvedValue([]);
  mocked.listRunEvents.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const store = () => useAgentsStore.getState();

describe('resync', () => {
  it('reads the events after the last known id of every run whose events are loaded, merged without duplicates or reordering', async () => {
    // r2 is known, but its events are not open
    useAgentsStore.setState({ runs: { r1: makeRun({ id: 'r1' }), r2: makeRun({ id: 'r2' }) }, eventsByRun: { r1: [ev(1), ev(2)] } });
    // the answer overlaps what is known (2) and arrives out of order
    mocked.listRunEvents.mockResolvedValue([ev(4), ev(2), ev(3)]);
    await store().resync();
    expect(mocked.listRunEvents).toHaveBeenCalledTimes(1);
    expect(mocked.listRunEvents).toHaveBeenCalledWith('r1', 2);
    expect(store().eventsByRun.r1.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(store().eventsByRun.r2).toBeUndefined();
  });

  it('a status event found while resyncing moves the run through the normal reducer', async () => {
    useAgentsStore.setState({ runs: { r1: makeRun({ id: 'r1', status: 'running' }) }, eventsByRun: { r1: [ev(1)] } });
    mocked.listRunEvents.mockResolvedValue([makeEvent({ id: 2, kind: 'status', payload: { status: 'failed', error: 'step_limit' } })]);
    mocked.getRun.mockResolvedValue(makeRun({ id: 'r1', status: 'failed', error: 'step_limit', can_continue: true }));
    await store().resync();
    expect(store().runs.r1).toMatchObject({ status: 'failed', error: 'step_limit' });
    expect(store().eventsByRun.r1.map((e) => e.id)).toEqual([1, 2]);
  });

  it('asks for every event when the loaded list is empty, and a full page triggers the next one', async () => {
    useAgentsStore.setState({ runs: { r1: makeRun({ id: 'r1' }) }, eventsByRun: { r1: [] } });
    const page = Array.from({ length: 500 }, (_, i) => ev(i + 1));
    mocked.listRunEvents.mockResolvedValueOnce(page).mockResolvedValueOnce([ev(501)]);
    await store().resync();
    expect(mocked.listRunEvents.mock.calls).toEqual([
      ['r1', undefined],
      ['r1', 500],
    ]);
    expect(store().eventsByRun.r1).toHaveLength(501);
  });

  it('refreshes the overview and the runs of the open projects, never regressing a finished run to an active one', async () => {
    useAgentsStore.setState({
      messagesByProject: { p1: [] },
      runs: { r1: makeRun({ id: 'r1', status: 'running' }), r3: makeRun({ id: 'r3', status: 'done', finished_at: '2026-01-01T10:09:00Z' }) },
    });
    mocked.listRuns.mockResolvedValue([
      makeRun({ id: 'r1', status: 'done', finished_at: '2026-01-01T10:08:00Z' }),
      makeRun({ id: 'r3', status: 'running' }), // older snapshot of a run that already finished here
      makeRun({ id: 'r9', status: 'queued' }),
    ]);
    await store().resync();
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
    expect(mocked.listRuns).toHaveBeenCalledWith({ project_id: 'p1', limit: 50 });
    expect(store().runs.r1.status).toBe('done');
    expect(store().runs.r3.status).toBe('done');
    expect(store().runs.r9.status).toBe('queued');
  });

  it('refreshes the loaded project and task message lists in place (new rows in order, receipts updated) and skips the others', async () => {
    const m = (id: string, at: string, over = {}) => makeMessage({ id, created_at: at, ...over });
    useAgentsStore.setState({
      messagesByProject: { p1: [m('a', '2026-01-01T10:00:00Z', { delivery: 'pending' }), m('c', '2026-01-01T10:02:00Z')] },
      messagesByTask: { t1: [m('x', '2026-01-01T10:00:00Z', { task_id: 't1' })] },
      tasksById: { t1: makeTask({ id: 't1', project_id: 'p1' }) },
    });
    mocked.listMessages.mockResolvedValue([
      m('a', '2026-01-01T10:00:00Z', { delivery: 'delivered' }), // the message_update was lost
      m('b', '2026-01-01T10:01:00Z'), // a message that was lost
      m('c', '2026-01-01T10:02:00Z'),
    ]);
    mocked.listTaskMessages.mockResolvedValue([m('x', '2026-01-01T10:00:00Z', { task_id: 't1' }), m('y', '2026-01-01T10:03:00Z', { task_id: 't1' })]);
    await store().resync();
    const proj = store().messagesByProject.p1;
    expect(proj.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(proj[0].delivery).toBe('delivered');
    expect(store().messagesByTask.t1.map((x) => x.id)).toEqual(['x', 'y']);
    expect(mocked.listMessages).toHaveBeenCalledTimes(1);
    expect(mocked.listMessages).toHaveBeenCalledWith('p1', { limit: 200 });
    expect(mocked.listTaskMessages).toHaveBeenCalledWith('t1');
    expect(store().messagesByProject.p2).toBeUndefined();
  });

  it('coalesces calls made while one is in flight into a single round of requests', async () => {
    useAgentsStore.setState({ messagesByProject: { p1: [] }, eventsByRun: { r1: [ev(1)] }, runs: { r1: makeRun({ id: 'r1' }) } });
    const gate = deferred<typeof emptyOverview>();
    mocked.getOverview.mockReturnValueOnce(gate.promise);
    const first = store().resync();
    const second = store().resync();
    const third = store().resync();
    expect(second).toBe(first);
    expect(third).toBe(first);
    gate.resolve(emptyOverview);
    await first;
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
    expect(mocked.listMessages).toHaveBeenCalledTimes(1);
    expect(mocked.listRunEvents).toHaveBeenCalledTimes(1);
    // and it is free again afterwards
    await store().resync();
    expect(mocked.getOverview).toHaveBeenCalledTimes(2);
  });

  it('keeps everything on screen while it is in flight, and flags itself as resyncing until it ends', async () => {
    const message = makeMessage({ id: 'a' });
    useAgentsStore.setState({
      messagesByProject: { p1: [message] },
      eventsByRun: { r1: [ev(1)] },
      runs: { r1: makeRun({ id: 'r1', status: 'running' }) },
    });
    mocked.getOverview.mockResolvedValue({ ...emptyOverview, active_runs: [makeRun({ id: 'r1', status: 'running' })] });
    const msgs = deferred<ReturnType<typeof makeMessage>[]>();
    const events = deferred<HarnessEvent[]>();
    mocked.listMessages.mockReturnValue(msgs.promise);
    mocked.listRunEvents.mockReturnValue(events.promise);
    const run = store().resync();
    expect(store().resyncing).toBe(true);
    await Promise.resolve();
    expect(store().messagesByProject.p1).toEqual([message]);
    expect(store().eventsByRun.r1.map((e) => e.id)).toEqual([1]);
    expect(store().runs.r1.status).toBe('running');
    msgs.resolve([message, makeMessage({ id: 'b', created_at: '2026-01-01T11:00:00Z' })]);
    events.resolve([ev(2)]);
    await run;
    expect(store().resyncing).toBe(false);
    expect(store().messagesByProject.p1.map((x) => x.id)).toEqual(['a', 'b']);
    expect(store().eventsByRun.r1.map((e) => e.id)).toEqual([1, 2]);
  });

  it('a request that fails changes nothing for that list and does not stop the others', async () => {
    useAgentsStore.setState({
      messagesByProject: { p1: [makeMessage({ id: 'a' })] },
      messagesByTask: { t1: [makeMessage({ id: 'x', task_id: 't1' })] },
      eventsByRun: { r1: [ev(1)] },
      runs: { r1: makeRun({ id: 'r1' }) },
      tasksById: { t1: makeTask({ id: 't1', project_id: 'p1' }) },
    });
    mocked.listMessages.mockRejectedValue(new Error('sem rede'));
    mocked.listRunEvents.mockRejectedValue(new Error('sem rede'));
    mocked.getOverview.mockRejectedValue(new Error('sem rede'));
    mocked.listTaskMessages.mockResolvedValue([makeMessage({ id: 'x', task_id: 't1' }), makeMessage({ id: 'y', task_id: 't1', created_at: '2026-01-01T12:00:00Z' })]);
    await expect(store().resync()).resolves.toBeUndefined();
    expect(store().messagesByProject.p1.map((x) => x.id)).toEqual(['a']);
    expect(store().eventsByRun.r1.map((e) => e.id)).toEqual([1]);
    expect(store().messagesByTask.t1.map((x) => x.id)).toEqual(['x', 'y']);
    expect(store().resyncing).toBe(false);
  });
});

describe('what triggers a resync', () => {
  async function opts(): Promise<StreamOptions> {
    await store().init();
    return mocked.openGlobalSocket.mock.calls[0][1] as StreamOptions;
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  };

  it('a drop followed by a reconnection triggers exactly one resync; a first connection triggers none', async () => {
    const o = await opts();
    mocked.getOverview.mockClear();
    o.onStatus?.(true); // the first connection
    await settle();
    expect(mocked.getOverview).not.toHaveBeenCalled();
    o.onStatus?.(false);
    await settle();
    expect(mocked.getOverview).not.toHaveBeenCalled(); // nothing to ask while offline
    o.onStatus?.(true);
    await settle();
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
    o.onStatus?.(true);
    await settle();
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
  });

  it('a gap and a new boot each resync, and they coalesce with a reconnection that happens at the same time', async () => {
    const o = await opts();
    mocked.getOverview.mockClear();
    o.onGap?.();
    await settle();
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
    o.onBootChange?.();
    await settle();
    expect(mocked.getOverview).toHaveBeenCalledTimes(2);

    mocked.getOverview.mockClear();
    o.onStatus?.(false);
    o.onBootChange?.(); // a restarted backend: the new boot is seen on the ready frame, before the status flips...
    o.onStatus?.(true); // ...and the reconnection asks for the same resync
    await settle();
    expect(mocked.getOverview).toHaveBeenCalledTimes(1);
  });

  it('the status is flipped to connected only after the resync has started', async () => {
    const o = await opts();
    o.onStatus?.(false);
    const seen: boolean[] = [];
    const unsubscribe = useAgentsStore.subscribe((s) => seen.push(s.streamConnected && !s.resyncing));
    o.onStatus?.(true);
    unsubscribe();
    expect(seen).not.toContain(true);
  });
});

// ---------- the band ----------

describe('reconnection band', () => {
  beforeEach(() => vi.useFakeTimers());

  const tick = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };
  const band = (): HTMLElement => screen.getByRole('status');
  const down = /Sem conexão ao vivo/;

  it('is a polite live region that is there from the start and empty while all is well', () => {
    useAgentsStore.setState({ streamConnected: true });
    render(<ConnectionBand />);
    expect(band().getAttribute('aria-live')).toBe('polite');
    expect(band().textContent).toBe('');
  });

  it('says nothing for the first 1,2 s of a drop, then appears with an icon and words', () => {
    useAgentsStore.setState({ streamConnected: true });
    render(<ConnectionBand />);
    act(() => useAgentsStore.setState({ streamConnected: false }));
    tick(CONNECTION_BAND_DELAY_MS - 1);
    expect(band().textContent).toBe('');
    tick(1);
    expect(band().textContent).toMatch(down);
    expect(band().querySelector('svg')).toBeTruthy();
    expect(band().querySelector('.a-conn__band--down')).toBeTruthy();
    expect(screen.getByRole('status')).toBe(band()); // the same region, announced politely
  });

  it('a reconnection inside 1,2 s says nothing at all, not even a confirmation', () => {
    useAgentsStore.setState({ streamConnected: true });
    render(<ConnectionBand />);
    act(() => useAgentsStore.setState({ streamConnected: false }));
    tick(800);
    act(() => useAgentsStore.setState({ streamConnected: true, resyncing: true }));
    act(() => useAgentsStore.setState({ resyncing: false }));
    tick(5000);
    expect(band().textContent).toBe('');
  });

  it('after the channel is back and the resync is done: a brief confirmation for about 1,6 s, then nothing', () => {
    useAgentsStore.setState({ streamConnected: true });
    render(<ConnectionBand />);
    act(() => useAgentsStore.setState({ streamConnected: false }));
    tick(CONNECTION_BAND_DELAY_MS);
    expect(band().textContent).toMatch(down);

    // back, but the resync is still reading: not "all good" yet
    act(() => useAgentsStore.setState({ streamConnected: true, resyncing: true }));
    expect(band().textContent).toMatch(/Atualizando/);
    expect(band().textContent).not.toMatch(/Tudo atualizado/);
    tick(3000);
    expect(band().textContent).toMatch(/Atualizando/);

    act(() => useAgentsStore.setState({ resyncing: false }));
    expect(band().textContent).toMatch(/Conexão restabelecida\. Tudo atualizado\./);
    expect(band().querySelector('.a-conn__band--ok')).toBeTruthy();
    tick(CONNECTION_BAND_DONE_MS - 1);
    expect(band().textContent).toMatch(/Tudo atualizado/);
    tick(1);
    expect(band().textContent).toBe('');
    tick(10_000);
    expect(band().textContent).toBe('');
  });

  it('a new drop during the confirmation replaces it and starts the 1,2 s count again', () => {
    useAgentsStore.setState({ streamConnected: true });
    render(<ConnectionBand />);
    act(() => useAgentsStore.setState({ streamConnected: false }));
    tick(CONNECTION_BAND_DELAY_MS);
    act(() => useAgentsStore.setState({ streamConnected: true, resyncing: false }));
    expect(band().textContent).toMatch(/Tudo atualizado/);
    act(() => useAgentsStore.setState({ streamConnected: false }));
    expect(band().textContent).toBe('');
    tick(CONNECTION_BAND_DELAY_MS);
    expect(band().textContent).toMatch(down);
  });

  it('never blocks the composer or touches a draft: it takes no part in the layout and holds no controls', () => {
    useAgentsStore.setState({ streamConnected: false });
    render(<ConnectionBand />);
    tick(CONNECTION_BAND_DELAY_MS);
    expect(band().querySelectorAll('button, input, textarea, a, [tabindex]')).toHaveLength(0);
  });

  it('is part of the agents area only once the harness is ready', async () => {
    useAgentsStore.setState({ harnessState: 'ready', streamConnected: true, projects: [makeProject()], agents: [makeAgent()] });
    mocked.getOverview.mockResolvedValue(emptyOverview);
    const { container } = render(<ConfirmProvider><AgentsSpace /></ConfirmProvider>);
    expect(container.querySelector('.a-conn')).toBeTruthy();
    cleanup();
    mocked.ensureToken.mockRejectedValue(new api.HarnessDisabledError());
    useAgentsStore.setState({ harnessState: 'disabled' });
    const second = render(<ConfirmProvider><AgentsSpace /></ConfirmProvider>);
    expect(second.container.querySelector('.a-conn')).toBeNull();
  });
});
