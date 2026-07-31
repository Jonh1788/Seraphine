import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um mock de fetch com `{ ok, json }`
// sem `headers` faz helpers que leem `res.headers.get(...)` estourarem, e o
// teste passaria pelo caminho de erro achando que testou o caminho feliz.
vi.mock('../../../memory/api', () => ({ listFacts: vi.fn(), fetchProfile: vi.fn() }));

import { listFacts, fetchProfile } from '../../../memory/api';
import type { Fact } from '../../../memory/types';
import { MemoriaScreen } from '../MemoriaScreen';

const fato = (over: Partial<Fact> = {}): Fact => ({
  id: 'f1',
  text: 'Aniversário da Ana é 12 de março.',
  source: 'reflection',
  confidence: 0.92,
  created_at: '2026-07-01T10:00:00Z',
  superseded_by: null,
  last_used_at: null,
  category: 'PESSOAS',
  ...over,
});

const tres = (): Fact[] => [
  fato(),
  fato({ id: 'f2', text: 'Acorda às 6h e treina toda manhã.', category: 'ROTINA', confidence: 0.62 }),
  fato({ id: 'f3', text: 'Dev full-stack; foca em React e Rust.', category: 'TRABALHO', confidence: 0.88 }),
];

describe('MemoriaScreen', () => {
  beforeEach(() => {
    vi.mocked(listFacts).mockReset().mockResolvedValue([]);
    vi.mocked(fetchProfile).mockReset().mockResolvedValue(null);
  });

  it('lista as lembranças com a categoria em eyebrow e a contagem no cabeçalho', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Aniversário da Ana é 12 de março.')).toBeTruthy());
    expect(screen.getByText('Acorda às 6h e treina toda manhã.')).toBeTruthy();
    expect(screen.getByText('PESSOAS')).toBeTruthy();
    expect(screen.getByText('TRABALHO')).toBeTruthy();
    expect(screen.getByText('3 lembranças')).toBeTruthy();
  });

  it('mostra estado vazio, não some, quando não há lembrança nenhuma', async () => {
    vi.mocked(listFacts).mockResolvedValue([]);
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText(/nenhuma memória guardada ainda/i)).toBeTruthy());
  });

  it('mostra erro quando a api de lembranças falha', async () => {
    vi.mocked(listFacts).mockRejectedValue(new Error('rede'));
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar suas lembranças/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar suas lembranças/i).getAttribute('role')).toBe('alert');
  });

  it('digitar na busca chama listFacts com q', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    render(<MemoriaScreen />);
    await waitFor(() => expect(vi.mocked(listFacts)).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/buscar na memória/i), { target: { value: 'ana' } });
    await waitFor(() =>
      expect(vi.mocked(listFacts)).toHaveBeenCalledWith(expect.objectContaining({ q: 'ana' })),
    );
  });

  it('busca sem resultado diz que nada casa, em vez de sumir', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Aniversário da Ana é 12 de março.')).toBeTruthy());
    vi.mocked(listFacts).mockResolvedValue([]);
    fireEvent.change(screen.getByLabelText(/buscar na memória/i), { target: { value: 'xpto' } });
    await waitFor(() => expect(screen.getByText(/nada na memória casa com “xpto”/i)).toBeTruthy());
  });

  it('confiança baixa rende o ponto âmbar; alta, o verde', async () => {
    vi.mocked(listFacts).mockResolvedValue([
      fato({ id: 'f1', text: 'Talvez prefira chá.', confidence: 0.2 }),
      fato({ id: 'f2', text: 'Mora em São Paulo.', confidence: 0.95 }),
    ]);
    const { container } = render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Talvez prefira chá.')).toBeTruthy());

    const baixa = container.querySelector('.ms-memoria-fato')!;
    expect(baixa.textContent).toContain('Talvez prefira chá.');
    expect(baixa.querySelector('.ms-memoria-dot--ambar')).toBeTruthy();
    expect(baixa.querySelector('.ms-memoria-dot--verde')).toBeNull();
    expect(baixa.textContent).toContain('baixa');

    const alta = container.querySelectorAll('.ms-memoria-fato')[1];
    expect(alta.querySelector('.ms-memoria-dot--verde')).toBeTruthy();
    expect(alta.querySelector('.ms-memoria-dot--ambar')).toBeNull();
  });

  it('o filtro de categoria recorta a lista e avisa quando a categoria está vazia', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Acorda às 6h e treina toda manhã.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Pessoas' }));
    await waitFor(() => expect(screen.queryByText('Acorda às 6h e treina toda manhã.')).toBeNull());
    expect(screen.getByText('Aniversário da Ana é 12 de março.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Metas' }));
    await waitFor(() => expect(screen.getByText(/nenhuma lembrança em Metas/i)).toBeTruthy());

    // com chip ligado, o "nada" é da categoria — a frase precisa dizer qual
    fireEvent.change(screen.getByLabelText(/buscar na memória/i), { target: { value: 'ana' } });
    await waitFor(() => expect(screen.getByText(/nada em Metas casa com “ana”/i)).toBeTruthy());
  });

  // fetchProfile() resolvendo null é resposta normal ("perfil ainda não
  // montado"), não falha: o bloco tem que dizer isso em vazio, não em erro.
  it('perfil nulo vira vazio, não erro', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    vi.mocked(fetchProfile).mockResolvedValue(null);
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText(/perfil ainda vazio/i)).toBeTruthy());
    expect(screen.queryByText(/não consegui carregar o perfil/i)).toBeNull();
  });

  it('mostra o perfil quando ele existe e erra sozinho quando falha', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    vi.mocked(fetchProfile).mockResolvedValue({ identity: { nome: 'Jonathan' } });
    const { unmount } = render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Jonathan')).toBeTruthy());
    unmount();

    vi.mocked(fetchProfile).mockRejectedValue(new Error('rede'));
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar o perfil/i)).toBeTruthy());
    // a falha do perfil não pode derrubar as lembranças
    expect(screen.getByText('Aniversário da Ana é 12 de março.')).toBeTruthy();
  });

  // O shell deixou de desenhar chrome (PushedScreen virou só corpo): sem a seta
  // aqui, quem entra em Memória fica preso na tela.
  it('tem o voltar do handoff e chama onBack ao tocar', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    const onBack = vi.fn();
    render(<MemoriaScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    vi.mocked(listFacts).mockResolvedValue(tres());
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Aniversário da Ana é 12 de março.')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  it('lembrança substituída não aparece na lista', async () => {
    vi.mocked(listFacts).mockResolvedValue([
      fato({ id: 'f1', text: 'Trabalha na Acme.', superseded_by: 'f2' }),
      fato({ id: 'f2', text: 'Trabalha na Globo.' }),
    ]);
    render(<MemoriaScreen />);
    await waitFor(() => expect(screen.getByText('Trabalha na Globo.')).toBeTruthy());
    expect(screen.queryByText('Trabalha na Acme.')).toBeNull();
    expect(screen.getByText('1 lembrança')).toBeTruthy();
  });
});
