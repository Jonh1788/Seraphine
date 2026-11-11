import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// --- Mock the research api module the panel consumes --------------------------
const getChatModel = vi.fn();
const putChatModel = vi.fn();
const listModels = vi.fn();
const getConfig = vi.fn();
const putConfig = vi.fn();
const getChatEffort = vi.fn();
const putChatEffort = vi.fn();

vi.mock('../../research/api', () => ({
  getChatModel: (...a: unknown[]) => getChatModel(...a),
  putChatModel: (...a: unknown[]) => putChatModel(...a),
  listModels: (...a: unknown[]) => listModels(...a),
  getConfig: (...a: unknown[]) => getConfig(...a),
  putConfig: (...a: unknown[]) => putConfig(...a),
  getChatEffort: (...a: unknown[]) => getChatEffort(...a),
  putChatEffort: (...a: unknown[]) => putChatEffort(...a),
}));

// Imported AFTER vi.mock so the mock is wired.
import { ChatModelPanel } from '../ChatModelPanel';

afterEach(() => {
  vi.clearAllMocks();
});

function stubs(): void {
  getChatModel.mockResolvedValue({ chat_model: 'cliproxy' });
  getChatEffort.mockResolvedValue({ effort: '' });
  putChatEffort.mockImplementation(async (e: string) => ({ effort: e }));
  listModels.mockResolvedValue({
    cliproxy: [],
    // O id vem JÁ prefixado de /deepsearch/models (service.py monta
    // `openrouter:{id}`). A fixture antiga vinha crua e por isso o painel
    // podia prefixar de novo sem nenhum teste reclamar.
    // `reasoning` vem do `supported_parameters` do catálogo — o gpt-4o-mini
    // realmente não anuncia raciocínio, então a fixture não mente.
    openrouter: [{ id: 'openrouter:openai/gpt-4o-mini', name: 'GPT-4o mini', reasoning: false }],
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

    // O `<select>` virou combobox com busca (`ui/ModelPicker`) quando o backend
    // parou de cortar o catálogo do OpenRouter em 80: as opções só existem no
    // DOM com o popover aberto.
    const campo = (await screen.findByRole('combobox')) as HTMLInputElement;
    await waitFor(() => expect(campo.disabled).toBe(false));
    expect(campo.value).toBe('Padrão — cliproxy / Claude');

    fireEvent.mouseDown(campo);
    expect(screen.getByRole('option', { name: /Padrão/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'GPT-4o mini' }));

    // O id vai VERBATIM como veio de /deepsearch/models (já prefixado).
    await waitFor(() =>
      expect(putChatModel).toHaveBeenCalledWith('openrouter:openai/gpt-4o-mini'),
    );
    await waitFor(() => expect(campo.value).toBe('GPT-4o mini'));
  });

  it('acha um modelo do fundo do catálogo pela busca — o que o teto de 80 impedia', async () => {
    getChatModel.mockResolvedValue({ chat_model: 'cliproxy' });
    // Catálogo grande o bastante para o corte antigo (80, alfabético) ter
    // levado o último: com o teto de volta, `zzz-modelo` não estaria aqui.
    listModels.mockResolvedValue({
      cliproxy: [],
      openrouter: [
        ...Array.from({ length: 120 }, (_, i) => ({
          id: `openrouter:vendor/m${String(i).padStart(3, '0')}`,
          name: `m${String(i).padStart(3, '0')}`,
        })),
        { id: 'openrouter:vendor/zzz-modelo', name: 'zzz-modelo' },
      ],
    });
    getConfig.mockResolvedValue({
      fanout_model: 'cliproxy:a',
      synth_model: 'cliproxy:b',
      openrouter_key_set: true,
    });
    putChatModel.mockImplementation(async (m: string) => ({ chat_model: m }));

    render(<ChatModelPanel />);
    const campo = (await screen.findByRole('combobox')) as HTMLInputElement;
    await waitFor(() => expect(campo.disabled).toBe(false));

    fireEvent.mouseDown(campo);
    expect(screen.getByText('122 modelos')).toBeTruthy(); // 121 + o Padrão

    fireEvent.change(campo, { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('option', { name: 'zzz-modelo' }));

    await waitFor(() =>
      expect(putChatModel).toHaveBeenCalledWith('openrouter:vendor/zzz-modelo'),
    );
  });

  it('shows the inline key field when no OpenRouter key is set', async () => {
    getChatModel.mockResolvedValue({ chat_model: 'cliproxy' });
    getChatEffort.mockResolvedValue({ effort: '' });
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

  /* ── esforço de raciocínio ─────────────────────────────────────────── */

  function comEsforco(modelo: string, catalogo: unknown[], efeito = '') {
    getChatModel.mockResolvedValue({ chat_model: modelo });
    getChatEffort.mockResolvedValue({ effort: efeito });
    putChatEffort.mockImplementation(async (e: string) => ({ effort: e }));
    putChatModel.mockImplementation(async (m: string) => ({ chat_model: m }));
    listModels.mockResolvedValue({ cliproxy: [], openrouter: catalogo });
    getConfig.mockResolvedValue({
      fanout_model: 'cliproxy:a',
      synth_model: 'cliproxy:b',
      openrouter_key_set: true,
    });
  }

  const PENSA = { id: 'openrouter:openai/gpt-5', name: 'GPT-5', reasoning: true };
  const NAO_PENSA = {
    id: 'openrouter:openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    reasoning: false,
  };

  it('salva o esforço escolhido quando o modelo aceita raciocínio', async () => {
    comEsforco(PENSA.id, [PENSA, NAO_PENSA]);
    render(<ChatModelPanel />);

    const alto = await screen.findByRole('button', { name: 'Alto' });
    await waitFor(() => expect((alto as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(alto);

    await waitFor(() => expect(putChatEffort).toHaveBeenCalledWith('high'));
    await waitFor(() => expect(alto.getAttribute('aria-pressed')).toBe('true'));
  });

  it('modelo sem raciocínio: controle desabilitado e o motivo nomeia o modelo', async () => {
    comEsforco(NAO_PENSA.id, [PENSA, NAO_PENSA]);
    render(<ChatModelPanel />);

    const alto = await screen.findByRole('button', { name: 'Alto' });
    await waitFor(() => expect((alto as HTMLButtonElement).disabled).toBe(true));
    // Dizer QUAL modelo é o que transforma o controle apagado em informação.
    expect(screen.getByText(/GPT-4o mini não aceita/)).toBeTruthy();

    fireEvent.click(alto);
    expect(putChatEffort).not.toHaveBeenCalled();
  });

  it('no Padrão explica que o cliproxy não passa por este ajuste', async () => {
    comEsforco('cliproxy', [PENSA]);
    render(<ChatModelPanel />);

    await waitFor(() =>
      expect(screen.getByText(/Padrão \(cliproxy \/ Claude\) não passa por este ajuste/)).toBeTruthy(),
    );
  });

  it('o esforço gravado chega marcado na tela', async () => {
    comEsforco(PENSA.id, [PENSA], 'max');
    render(<ChatModelPanel />);

    const maximo = await screen.findByRole('button', { name: 'Máximo' });
    await waitFor(() => expect(maximo.getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Desligado' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('falhar só o esforço não derruba o seletor de modelo', async () => {
    comEsforco(PENSA.id, [PENSA]);
    getChatEffort.mockRejectedValue(new Error('HTTP 503'));

    render(<ChatModelPanel />);

    // O principal da tela continua de pé...
    const campo = (await screen.findByRole('combobox')) as HTMLInputElement;
    await waitFor(() => expect(campo.disabled).toBe(false));
    expect(campo.value).toBe('GPT-5');
    // ...e o esforço cai no desligado em vez de inventar um valor.
    expect(screen.getByRole('button', { name: 'Desligado' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('falha ao salvar devolve o esforço anterior, sem deixar a tela mentir', async () => {
    comEsforco(PENSA.id, [PENSA], 'low');
    putChatEffort.mockRejectedValue(new Error('HTTP 500'));
    render(<ChatModelPanel />);

    const baixo = await screen.findByRole('button', { name: 'Baixo' });
    await waitFor(() => expect(baixo.getAttribute('aria-pressed')).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: 'Máximo' }));

    // Volta para o que o backend de fato tem — é ele que monta a requisição.
    await waitFor(() => expect(baixo.getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByRole('button', { name: 'Máximo' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('o selo de raciocínio aparece na lista, só em quem aceita', async () => {
    comEsforco('cliproxy', [PENSA, NAO_PENSA]);
    render(<ChatModelPanel />);

    const campo = (await screen.findByRole('combobox')) as HTMLInputElement;
    await waitFor(() => expect(campo.disabled).toBe(false));
    fireEvent.mouseDown(campo);

    const linha = (nome: string) => screen.getByRole('option', { name: nome });
    expect(linha('GPT-5').textContent).toContain('raciocínio');
    // Ausência afirmada: o selo é uma promessa, e prometer onde não vale seria
    // pior que não ter selo nenhum.
    expect(linha('GPT-4o mini').textContent).not.toContain('raciocínio');
  });
});
