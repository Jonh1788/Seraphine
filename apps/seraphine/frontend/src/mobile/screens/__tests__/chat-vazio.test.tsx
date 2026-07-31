import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// Esta tela não consome api nenhuma (handoff linha 647): é só o primeiro uso do
// chat. Nada a mockar — o que se testa é a fidelidade ao handoff e o contrato
// que a Task 28 vai usar para ligá-la ao ChatScreen.
import { ChatVazioScreen, ChatVazioMiolo, SUGESTOES } from '../ChatVazioScreen';

/** As quatro sugestões que o handoff desenha, na ordem em que ele desenha. */
const TEXTOS = [
  'Organiza minha semana',
  'Me ajuda a controlar gastos',
  'Quero criar um hábito novo',
  'Me ensina algo novo',
];

/** Emoji: a casa proíbe (ícone é SVG inline). O handoff usa 📅💸🎯🧠 nas
 *  sugestões; a tela tem de traduzi-los em ícones, não copiá-los. */
const EMOJI = /\p{Extended_Pictographic}/u;

describe('ChatVazioScreen', () => {
  it('desenha o título, a linha de apoio e o orb de 88px do handoff', () => {
    const { container } = render(<ChatVazioScreen />);

    expect(screen.getByText('Sobre o que a gente conversa primeiro?')).toBeTruthy();
    expect(screen.getByText(/Toque numa sugestão/)).toBeTruthy();

    const larguras = Array.from(container.querySelectorAll<HTMLElement>('.morb'))
      .map((o) => o.style.width);
    expect(larguras).toContain('88px');   // o orb do miolo
    expect(larguras).toContain('38px');   // o do cabeçalho
  });

  it('lista as quatro sugestões do handoff, na ordem, como botões tocáveis', () => {
    render(<ChatVazioScreen />);
    const botoes = screen.getAllByRole('button', { name: /minha semana|gastos|hábito|ensina/ });
    expect(botoes.map((b) => b.textContent)).toEqual(TEXTOS);
  });

  // A asserção que a task pede: cada sugestão manda O SEU texto. Um laço, e não
  // um clique só, porque um handler que ignorasse o índice passaria no caso único.
  it.each(TEXTOS.map((t, i) => [i, t] as const))(
    'tocar na sugestão %i dispara o callback com "%s"',
    (_i, texto) => {
      const onPrimeiraMensagem = vi.fn();
      render(<ChatVazioScreen onPrimeiraMensagem={onPrimeiraMensagem} />);

      fireEvent.click(screen.getByRole('button', { name: texto }));

      expect(onPrimeiraMensagem.mock.calls).toEqual([[texto]]);
    },
  );

  it('não quebra ao tocar numa sugestão sem callback ligado', () => {
    render(<ChatVazioScreen />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: TEXTOS[0] }))).not.toThrow();
  });

  it('manda pelo composer o que foi digitado, e limpa o campo', () => {
    const onPrimeiraMensagem = vi.fn();
    render(<ChatVazioScreen onPrimeiraMensagem={onPrimeiraMensagem} />);

    const campo = screen.getByPlaceholderText('Mensagem…') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'quanto gastei em junho?' } });
    fireEvent.submit(campo.closest('form')!);

    expect(onPrimeiraMensagem.mock.calls).toEqual([['quanto gastei em junho?']]);
    expect(campo.value).toBe('');
  });

  it('não manda mensagem em branco', () => {
    const onPrimeiraMensagem = vi.fn();
    render(<ChatVazioScreen onPrimeiraMensagem={onPrimeiraMensagem} />);

    const campo = screen.getByPlaceholderText('Mensagem…') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '   ' } });
    fireEvent.submit(campo.closest('form')!);

    expect(onPrimeiraMensagem).not.toHaveBeenCalled();
  });

  it('o botão do composer abre a voz', () => {
    const onOpen = vi.fn();
    render(<ChatVazioScreen onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: /falar por voz/i }));

    expect(onOpen.mock.calls).toEqual([[{ key: 'voz', title: 'Voz' }]]);
  });

  it('não usa emoji em lugar nenhum — os ícones são SVG', () => {
    const { container } = render(<ChatVazioScreen />);
    expect(container.textContent ?? '').not.toMatch(EMOJI);
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(TEXTOS.length);
  });
});

// O miolo é a porta de entrada da Task 28 quando ela preferir embutir o vazio
// dentro do ChatScreen, que já tem cabeçalho e composer próprios.
describe('ChatVazioMiolo', () => {
  it('entrega só orb + título + sugestões, sem cabeçalho nem composer', () => {
    const onSugestao = vi.fn();
    const { container } = render(<ChatVazioMiolo onSugestao={onSugestao} />);

    expect(screen.getByText('Sobre o que a gente conversa primeiro?')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Mensagem…')).toBeNull();
    expect(screen.queryByText('Seraphine')).toBeNull();
    expect(container.querySelectorAll('.morb').length).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: TEXTOS[3] }));
    expect(onSugestao.mock.calls).toEqual([[TEXTOS[3]]]);
  });

  it('exporta as sugestões como dado, na ordem do handoff', () => {
    expect(SUGESTOES.map((s) => s.texto)).toEqual(TEXTOS);
  });
});
