import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um mock de fetch com `{ ok, json }`
// sem `headers` faz helpers que leem `res.headers.get(...)` estourarem, e o
// teste passaria pelo caminho de erro achando que testou o caminho feliz.
// `createFact` entra porque a tela passou a montar o `ModalMemoria`, que o usa
// como padrão do `criar`. Sem ele no mock, TODOS os testes desta tela quebram no
// render — o default de prop é lido na montagem do modal, não no envio.
vi.mock('../../../memory/api', () => ({
  listFacts: vi.fn(),
  fetchProfile: vi.fn(),
  createFact: vi.fn(),
}));

import { listFacts, fetchProfile, createFact } from '../../../memory/api';
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
    vi.mocked(createFact).mockReset();
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
    // A linha do cabeçalho tem SUJEITO: "nenhuma casa com a busca" era frase
    // quebrada — sem o substantivo, "casa" vira o cômodo, não o verbo. O
    // substantivo desta tela é lembrança, o mesmo da contagem ("3 lembranças").
    expect(screen.getByText('nenhuma lembrança casa com a busca')).toBeTruthy();
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

  /* O "+" — a ausência que deixou de ter justificativa.
     Esta tela RECUSOU o "+" do handoff com um argumento correto na época:
     `memory/api.ts` só lia, e um "+" sem POST é botão morto. A Task 10 abriu
     `createFact`; o argumento caiu com ela, e o comentário que o repetia ficou
     desatualizado no arquivo. */
  describe('nova lembrança', () => {
    const abrir = async () => {
      vi.mocked(listFacts).mockResolvedValue(tres());
      render(<MemoriaScreen />);
      await waitFor(() => expect(screen.getByText('3 lembranças')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Nova lembrança' }));
      return await screen.findByRole('dialog');
    };

    it('o "+" abre o sheet de nova lembrança', async () => {
      const dialogo = await abrir();
      expect(dialogo.getAttribute('aria-label')).toBe('Nova lembrança');
    });

    it('sem tocar no "+", não há sheet montado', async () => {
      vi.mocked(listFacts).mockResolvedValue(tres());
      render(<MemoriaScreen />);
      await waitFor(() => expect(screen.getByText('3 lembranças')).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('salvar grava pela camada e refaz a leitura', async () => {
      vi.mocked(createFact).mockResolvedValue(fato({ id: 'f9', text: 'Prefere reuniões depois das 10h.' }));
      await abrir();
      expect(listFacts).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByLabelText('Lembrança'), {
        target: { value: 'Prefere reuniões depois das 10h.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

      await waitFor(() => expect(createFact).toHaveBeenCalledWith({
        text: 'Prefere reuniões depois das 10h.',
        source: 'explicit',
        confidence: 1,
      }));
      // a contagem do cabeçalho sai da LISTA do servidor, não de um contador local
      await waitFor(() => expect(listFacts).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('fechar sem salvar não refaz a leitura', async () => {
      await abrir();
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(listFacts).toHaveBeenCalledTimes(1);
      expect(createFact).not.toHaveBeenCalled();
    });

    it('reabrir depois de salvar traz o campo VAZIO', async () => {
      // A tela mantém o modal MONTADO entre uma abertura e outra. Sem o reset na
      // transição fechado→aberto, a "nova lembrança" seguinte nasceria com o
      // texto que acabou de ser gravado — oferecido para ser gravado de novo.
      vi.mocked(createFact).mockResolvedValue(fato({ id: 'f9', text: 'x' }));
      await abrir();
      fireEvent.change(screen.getByLabelText('Lembrança'), { target: { value: 'Odeia coentro.' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      fireEvent.click(screen.getByRole('button', { name: 'Nova lembrança' }));
      await screen.findByRole('dialog');
      expect((screen.getByLabelText('Lembrança') as HTMLTextAreaElement).value).toBe('');
    });
  });
});
