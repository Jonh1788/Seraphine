import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingFlow } from '../OnboardingFlow';

vi.mock('../../google/api', () => ({ startOAuth: vi.fn() }));
beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockServer(ok: boolean) {
  const fetchMock = vi.fn().mockImplementation((_url, init) => Promise.resolve({
    ok: !init?.method || ok,
    json: async () => init?.method ? { detail: 'Abra o Codex e entre na sua conta.' } : { selected: 'ollama' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function selectCodex() {
  render(<OnboardingFlow onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /come[çc]ar/i }));
  await waitFor(() => expect((screen.getByRole('button', { name: /Codex/ }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: /Codex/ }));
  fireEvent.click(screen.getByRole('button', { name: /Proximo/ }));
}

describe('brain selection', () => {
  it('applies Codex on the server before advancing', async () => {
    const server = mockServer(true);
    await selectCodex();
    await screen.findByText('Tudo certo!');
    expect(server).toHaveBeenCalledWith(expect.stringContaining('/llm/backend'), expect.objectContaining({
      method: 'POST', body: JSON.stringify({ backend: 'codex' }),
    }));
    expect(localStorage.getItem('seraphine.llm_backend')).toBe('codex');
  });

  it('keeps setup open when Codex cannot connect', async () => {
    mockServer(false);
    await selectCodex();
    expect((await screen.findByRole('alert')).textContent).toContain('entre na sua conta');
    expect(screen.queryByText('Tudo certo!')).toBeNull();
    expect(localStorage.getItem('seraphine.llm_backend')).toBeNull();
  });
});
