import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos os MÓDULOS de api, não o `fetch`: os dois `api.ts` leem
// `res.headers.get('content-type')`, e um mock de fetch com `{ ok, json }` sem
// `headers` estoura TypeError — o teste passaria sempre pelo caminho de erro
// achando que testou o caminho feliz.
vi.mock('../../../journal/api', () => ({
  fetchJournalEntries: vi.fn(),
  fetchJournalStats: vi.fn(),
  createJournalEntry: vi.fn(),
}));
vi.mock('../../../mood/api', () => ({ fetchMoodTrend: vi.fn() }));

import { fetchJournalEntries, fetchJournalStats, createJournalEntry } from '../../../journal/api';
import { fetchMoodTrend } from '../../../mood/api';
import type { JournalEntry } from '../../../journal/types';
import { DiarioScreen } from '../DiarioScreen';

/** Data local no formato YYYY-MM-DD — a mesma conta que a tela faz. */
function diaLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const HOJE = new Date();
const ONTEM = new Date(HOJE.getFullYear(), HOJE.getMonth(), HOJE.getDate() - 1);

const entrada = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  id: 'j1',
  date: diaLocal(ONTEM),
  type: 'manual',
  title: 'Dia produtivo',
  content: 'Terminei o redesign do app e fechei a direção visual.',
  mood_label: 'good',
  mood_valence: 0.6,
  tags: [],
  source: 'user',
  source_id: null,
  created_at: `${diaLocal(ONTEM)}T22:40:00`,
  updated_at: `${diaLocal(ONTEM)}T22:40:00`,
  reflection: null,
  ...over,
});

describe('DiarioScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchJournalEntries).mockReset().mockResolvedValue({ entries: [], total: 0 });
    vi.mocked(fetchJournalStats).mockReset().mockResolvedValue({
      current_streak: 0, longest_streak: 0, total_entries: 0, days_logged: 0,
    });
    vi.mocked(fetchMoodTrend).mockReset().mockResolvedValue({ days: [] });
    vi.mocked(createJournalEntry).mockReset().mockResolvedValue(entrada());
  });

  it('mostra a sequência e a última entrada', async () => {
    vi.mocked(fetchJournalStats).mockResolvedValue({
      current_streak: 8, longest_streak: 12, total_entries: 40, days_logged: 30,
    });
    vi.mocked(fetchJournalEntries).mockResolvedValue({ entries: [entrada()], total: 1 });
    render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText('8 dias seguidos escrevendo')).toBeTruthy());
    expect(screen.getByText(/Ontem · Dia produtivo/)).toBeTruthy();
    expect(screen.getByText(/Terminei o redesign do app/)).toBeTruthy();
  });

  it('mostra estado vazio, não some, quando não há entrada nenhuma', async () => {
    vi.mocked(fetchJournalEntries).mockResolvedValue({ entries: [], total: 0 });
    render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText(/ainda não escreveu nada no diário/i)).toBeTruthy());
    // o mapa continua de pé mesmo sem humor nenhum — só diz o que falta
    expect(screen.getByText(/ainda não registrou humor neste mês/i)).toBeTruthy();
  });

  it('mostra erro quando a api de entradas falha', async () => {
    vi.mocked(fetchJournalEntries).mockRejectedValue(new Error('rede'));
    render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar sua última entrada/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar sua última entrada/i).getAttribute('role')).toBe('alert');
  });

  it('erro do mapa de humor é próprio e não derruba a última entrada', async () => {
    vi.mocked(fetchJournalEntries).mockResolvedValue({ entries: [entrada()], total: 1 });
    vi.mocked(fetchMoodTrend).mockRejectedValue(new Error('rede'));
    render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar seu mapa de humor/i)).toBeTruthy());
    expect(screen.getByText(/Ontem · Dia produtivo/)).toBeTruthy();
  });

  it('escolher um humor marca só aquele', async () => {
    render(<DiarioScreen />);
    const otimo = await screen.findByLabelText('Ótimo');
    fireEvent.click(otimo);
    expect(otimo.getAttribute('aria-pressed')).toBe('true');
    for (const rotulo of ['Triste', 'Neutro', 'Ok', 'Bem']) {
      expect(screen.getByLabelText(rotulo).getAttribute('aria-pressed')).toBe('false');
    }
    // trocar de humor não acumula: o anterior solta
    fireEvent.click(screen.getByLabelText('Triste'));
    expect(screen.getByLabelText('Triste').getAttribute('aria-pressed')).toBe('true');
    expect(otimo.getAttribute('aria-pressed')).toBe('false');
  });

  it('Salvar manda o humor e o texto para a api', async () => {
    render(<DiarioScreen />);
    const campo = await screen.findByPlaceholderText('O que te deu energia hoje?');
    fireEvent.click(screen.getByLabelText('Ótimo'));
    fireEvent.change(campo, { target: { value: 'Corri no parque de manhã' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(vi.mocked(createJournalEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'Corri no parque de manhã',
        mood_label: 'great',
        mood_valence: 0.85,
      }),
    ));
    // salvou: o campo esvazia e a tela recarrega o que o servidor tem
    await waitFor(() => expect((campo as HTMLTextAreaElement).value).toBe(''));
    await waitFor(() => expect(vi.mocked(fetchJournalStats).mock.calls.length).toBeGreaterThan(1));
  });

  it('Salvar sem texto não chama a api', async () => {
    render(<DiarioScreen />);
    const salvar = await screen.findByRole('button', { name: 'Salvar' });
    fireEvent.click(salvar);
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled();
    expect((salvar as HTMLButtonElement).disabled).toBe(true);
  });

  it('mostra erro quando não consegue salvar', async () => {
    vi.mocked(createJournalEntry).mockRejectedValue(new Error('rede'));
    render(<DiarioScreen />);
    const campo = await screen.findByPlaceholderText('O que te deu energia hoje?');
    fireEvent.change(campo, { target: { value: 'Um dia qualquer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(screen.getByText(/não consegui salvar sua entrada/i)).toBeTruthy());
    expect(screen.getByText(/não consegui salvar sua entrada/i).getAttribute('role')).toBe('alert');
    // o texto não se perde quando o salvamento falha
    expect((campo as HTMLTextAreaElement).value).toBe('Um dia qualquer');
  });

  it('os chips Gratidão e Desafios semeiam o campo', async () => {
    render(<DiarioScreen />);
    const campo = (await screen.findByPlaceholderText('O que te deu energia hoje?')) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'Gratidão' }));
    expect(campo.value).toMatch(/grato/i);
    fireEvent.click(screen.getByRole('button', { name: 'Desafios' }));
    expect(campo.value).toMatch(/desafio/i);
  });

  it('o mapa de humor tem um quadrado por dia até hoje, e hoje em accent', async () => {
    const hoje = diaLocal(HOJE);
    vi.mocked(fetchMoodTrend).mockResolvedValue({
      days: [{ date: hoje, avg_valence: 0.85, avg_arousal: 0.5, predominant_label: 'happy', count: 3 }],
    });
    const { container } = render(<DiarioScreen />);
    await waitFor(() => expect(container.querySelectorAll('.ms-diario-mapa-cel').length).toBe(HOJE.getDate()));
    const marcados = container.querySelectorAll('.ms-diario-mapa-cel--hoje');
    expect(marcados).toHaveLength(1);
    // hoje é sempre o último quadrado da grade
    expect(marcados[0]).toBe(container.querySelectorAll('.ms-diario-mapa-cel')[HOJE.getDate() - 1]);
    // e o mês pedido ao /mood/trend cobre do dia 1 até hoje
    expect(vi.mocked(fetchMoodTrend)).toHaveBeenCalledWith(HOJE.getDate());
  });

  it('o humor da entrada preenche o mapa quando o /mood/trend está vazio', async () => {
    // O backend do diário guarda o humor NA entrada e não escreve mood_log:
    // sem esse fallback, o humor que o usuário escolhe aqui nunca aparece.
    const ontem = ONTEM.getDate();
    vi.mocked(fetchMoodTrend).mockResolvedValue({ days: [] });
    vi.mocked(fetchJournalEntries).mockResolvedValue({ entries: [entrada()], total: 1 });
    const { container } = render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText(/Ontem · Dia produtivo/)).toBeTruthy());
    // no dia 1 do mês "ontem" cai no mês passado e não tem célula: a asserção
    // só faz sentido quando ontem pertence ao mês desenhado.
    if (ontem < HOJE.getDate()) {
      await waitFor(() => {
        const celula = container.querySelectorAll('.ms-diario-mapa-cel')[ontem - 1];
        expect(celula.className).toContain('ms-diario-mapa-cel--com');
      });
      expect(screen.queryByText(/ainda não registrou humor neste mês/i)).toBeNull();
    }
  });

  it('não afirma "sem humor" enquanto as entradas do mês ainda estão no ar', async () => {
    // O mapa tem duas fontes. A tendência costuma chegar primeiro e VAZIA —
    // é o caso normal de quem só escreve no diário, porque o POST /journal não
    // escreve mood_log. Com o portão preso só nela, o cartão afirmava o vazio e
    // se desmentia meio segundo depois, quando o mês chegasse.
    const hoje = diaLocal(HOJE);
    let entregarMes: (r: { entries: JournalEntry[]; total: number }) => void = () => {};
    vi.mocked(fetchJournalEntries).mockImplementation((params) => {
      if (params?.month != null) {
        return new Promise((resolve) => { entregarMes = resolve; });
      }
      return Promise.resolve({ entries: [entrada({ date: hoje })], total: 1 });
    });
    vi.mocked(fetchMoodTrend).mockResolvedValue({ days: [] });

    const { container } = render(<DiarioScreen />);
    // a última entrada já chegou (consulta sem mês) — logo a tendência vazia já
    // passou por várias voltas do microtask e o mês ainda não voltou
    await waitFor(() => expect(screen.getByText(/Hoje · Dia produtivo/)).toBeTruthy());
    expect(screen.queryByText(/ainda não registrou humor neste mês/i)).toBeNull();
    expect(container.querySelector('.ms-diario-skel-grade')).toBeTruthy();

    entregarMes({ entries: [entrada({ date: hoje, mood_valence: 0.85 })], total: 1 });
    await waitFor(() => expect(container.querySelectorAll('.ms-diario-mapa-cel--com').length).toBeGreaterThan(0));
    expect(screen.queryByText(/ainda não registrou humor neste mês/i)).toBeNull();
  });

  it('o esqueleto do mapa tem o tamanho da grade que vem', async () => {
    let entregar: (r: { days: never[] }) => void = () => {};
    vi.mocked(fetchMoodTrend).mockImplementation(() => new Promise((resolve) => { entregar = resolve; }));
    const { container } = render(<DiarioScreen />);
    await waitFor(() => expect(container.querySelector('.ms-diario-skel-grade')).toBeTruthy());
    expect(container.querySelectorAll('.ms-diario-skel-grade span')).toHaveLength(HOJE.getDate());
    entregar({ days: [] });
    await waitFor(() => expect(container.querySelectorAll('.ms-diario-mapa-cel')).toHaveLength(HOJE.getDate()));
  });

  it('pede o mês inteiro ao servidor em vez de cortar no cliente', async () => {
    render(<DiarioScreen />);
    // recorte no servidor: nenhum dia do mês cai fora da grade em silêncio
    await waitFor(() => expect(vi.mocked(fetchJournalEntries)).toHaveBeenCalledWith(
      expect.objectContaining({ month: HOJE.getMonth() + 1, year: HOJE.getFullYear() }),
    ));
    // e a última entrada é buscada sem recorte de mês, senão o cartão mentiria
    // "você ainda não escreveu nada" no dia 1 de quem escreveu ontem
    expect(vi.mocked(fetchJournalEntries)).toHaveBeenCalledWith({ limit: 1 });
  });

  // O shell deixou de desenhar chrome (PushedScreen virou só corpo): sem a seta
  // aqui, quem entra no Diário fica preso na tela.
  it('tem o voltar do handoff e chama onBack ao tocar', async () => {
    const onBack = vi.fn();
    render(<DiarioScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText('Como foi seu dia?')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  it('não usa emoji em lugar nenhum (regra do projeto: só SVG inline)', async () => {
    vi.mocked(fetchJournalStats).mockResolvedValue({
      current_streak: 8, longest_streak: 12, total_entries: 40, days_logged: 30,
    });
    vi.mocked(fetchJournalEntries).mockResolvedValue({ entries: [entrada()], total: 1 });
    const { container } = render(<DiarioScreen />);
    await waitFor(() => expect(screen.getByText(/Ontem · Dia produtivo/)).toBeTruthy());
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
