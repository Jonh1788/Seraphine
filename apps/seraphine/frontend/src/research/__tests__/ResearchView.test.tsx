import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchEvent } from '../types';

// --- Mock the api module the view consumes ------------------------------------
const startRun = vi.fn();
const streamRun = vi.fn();
const listRuns = vi.fn();
const getRun = vi.fn();
const getConfig = vi.fn();
const listModels = vi.fn();
const putConfig = vi.fn();
const cancelRun = vi.fn();

vi.mock('../api', () => ({
  startRun: (...a: unknown[]) => startRun(...a),
  streamRun: (...a: unknown[]) => streamRun(...a),
  listRuns: (...a: unknown[]) => listRuns(...a),
  getRun: (...a: unknown[]) => getRun(...a),
  getConfig: (...a: unknown[]) => getConfig(...a),
  listModels: (...a: unknown[]) => listModels(...a),
  putConfig: (...a: unknown[]) => putConfig(...a),
  cancelRun: (...a: unknown[]) => cancelRun(...a),
}));

// Imported AFTER vi.mock so the mock is wired.
import { ResearchView } from '../ResearchView';

afterEach(() => {
  vi.clearAllMocks();
});

function defaultStubs(): void {
  startRun.mockResolvedValue({ id: 'r1' });
  listRuns.mockResolvedValue([]);
  getConfig.mockResolvedValue({
    fanout_model: 'cliproxy:claude-haiku-4-5-20251001',
    synth_model: 'cliproxy:claude-opus-4-8',
    openrouter_key_set: false,
  });
  listModels.mockResolvedValue({ cliproxy: [], openrouter: [] });
}

describe('ResearchView', () => {
  it('runs a query and renders streamed query, source, and final report', async () => {
    defaultStubs();

    // streamRun(id, onEvent, onClose) — replay a scripted sequence synchronously.
    const script: ResearchEvent[] = [
      { type: 'query', q: 'q1' },
      { type: 'source_found', url: 'https://a.com', title: 'T' },
      {
        type: 'report',
        markdown: 'Resposta [1]',
        sources: [{ url: 'https://a.com', title: 'T', n: 1 }],
      },
      { type: 'done', status: 'done' },
    ];
    streamRun.mockImplementation(
      async (_id: string, onEvent: (e: ResearchEvent) => void, onClose?: () => void) => {
        for (const e of script) onEvent(e);
        onClose?.();
      },
    );

    render(<ResearchView onBack={() => {}} />);

    // Wait for the mount-time history load to settle.
    await waitFor(() => expect(listRuns).toHaveBeenCalled());

    const textarea = screen.getByPlaceholderText(/pergunt/i);
    fireEvent.change(textarea, { target: { value: 'o que e X?' } });

    fireEvent.click(screen.getByRole('button', { name: /pesquisar/i }));

    await waitFor(() => expect(startRun).toHaveBeenCalledWith('o que e X?', 'quick'));

    // The streamed query appears.
    await waitFor(() => expect(screen.getByText('q1')).toBeTruthy());
    // The found source title appears (in the live card and the final Sources
    // list — assert at least one instance).
    expect(screen.getAllByText('T').length).toBeGreaterThan(0);
    // The final report text appears (citation is linkified, so match the prose).
    await waitFor(() => expect(screen.getByText(/Resposta/)).toBeTruthy());
  });
});
