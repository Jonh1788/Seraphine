import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Mock the research api module the panel consumes --------------------------
const getChatModel = vi.fn();
const putChatModel = vi.fn();
const listModels = vi.fn();
const getConfig = vi.fn();
const putConfig = vi.fn();

vi.mock('../../research/api', () => ({
  getChatModel: (...a: unknown[]) => getChatModel(...a),
  putChatModel: (...a: unknown[]) => putChatModel(...a),
  listModels: (...a: unknown[]) => listModels(...a),
  getConfig: (...a: unknown[]) => getConfig(...a),
  putConfig: (...a: unknown[]) => putConfig(...a),
}));

// Imported AFTER vi.mock so the mock is wired.
import { ChatModelPanel } from '../ChatModelPanel';

afterEach(() => {
  vi.clearAllMocks();
});

function stubs(): void {
  getChatModel.mockResolvedValue({ chat_model: 'cliproxy' });
  listModels.mockResolvedValue({
    cliproxy: [],
    openrouter: [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }],
  });
  getConfig.mockResolvedValue({
    fanout_model: 'cliproxy:claude-haiku-4-5',
    synth_model: 'cliproxy:claude-opus-4-8',
    openrouter_key_set: true,
  });
  putChatModel.mockImplementation(async (m: string) => ({ chat_model: m }));
}

describe('ChatModelPanel', () => {
  it('shows the default + OpenRouter option and saves the selected chat model', async () => {
    stubs();
    render(<ChatModelPanel />);

    // Wait for the mount-time load to settle.
    await waitFor(() => expect(getChatModel).toHaveBeenCalled());

    // Default option present.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Padrao/i })).toBeTruthy(),
    );
    // OpenRouter option present.
    const orOption = await screen.findByRole('option', { name: 'GPT-4o mini' });
    expect(orOption).toBeTruthy();

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('cliproxy');

    fireEvent.change(select, { target: { value: 'openrouter:openai/gpt-4o-mini' } });

    await waitFor(() =>
      expect(putChatModel).toHaveBeenCalledWith('openrouter:openai/gpt-4o-mini'),
    );
    await waitFor(() => expect(select.value).toBe('openrouter:openai/gpt-4o-mini'));
  });

  it('shows the inline key field when no OpenRouter key is set', async () => {
    getChatModel.mockResolvedValue({ chat_model: 'cliproxy' });
    listModels.mockResolvedValue({ cliproxy: [], openrouter: [] });
    getConfig.mockResolvedValue({
      fanout_model: 'cliproxy:a',
      synth_model: 'cliproxy:b',
      openrouter_key_set: false,
    });

    render(<ChatModelPanel />);

    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect(await screen.findByPlaceholderText('sk-or-...')).toBeTruthy();
  });
});
