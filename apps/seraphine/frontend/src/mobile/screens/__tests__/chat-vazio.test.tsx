import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// O vazio do chat não consome api nenhuma (handoff linha 647): é só o primeiro
// uso. Nada a mockar — o que se testa é a fidelidade ao handoff.
//
// A Task 28 embutiu ESTE bloco dentro do `ChatScreen` e removeu a tela inteira
// que a Task 23 também exportava (cabeçalho com "pronta" hardcoded, composer só
// com microfone). O que aqueles testes cobriam e continua valendo — as quatro
// sugestões, a ordem, o texto de cada uma, a ausência de emoji — está aqui.
// Que o bloco de fato aparece no chat, e que tocar numa sugestão manda a
// mensagem, é `chat.test.tsx` quem trava.
import { ChatVazioMiolo, SUGESTOES } from '../ChatVazioScreen';

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

describe('ChatVazioMiolo', () => {
  it('desenha o título, a linha de apoio e o orb de 88px do handoff', () => {
    const { container } = render(<ChatVazioMiolo />);

    expect(screen.getByText('Sobre o que a gente conversa primeiro?')).toBeTruthy();
    expect(screen.getByText(/Toque numa sugestão/)).toBeTruthy();

    const orbs = Array.from(container.querySelectorAll<HTMLElement>('.morb'));
    expect(orbs.map((o) => o.style.width)).toEqual(['88px']);
  });

  it('entrega só orb + título + sugestões: nem cabeçalho nem composer', () => {
    // Os do `ChatScreen` é que valem — o composer dele tem botão de enviar e o
    // cabeçalho dele deriva a presença do socket em vez de afirmar "pronta".
    render(<ChatVazioMiolo />);
    expect(screen.queryByPlaceholderText('Mensagem…')).toBeNull();
    expect(screen.queryByText('Seraphine')).toBeNull();
    expect(screen.queryByText('pronta')).toBeNull();
  });

  it('lista as quatro sugestões do handoff, na ordem, como botões tocáveis', () => {
    render(<ChatVazioMiolo />);
    const botoes = screen.getAllByRole('button', { name: /minha semana|gastos|hábito|ensina/ });
    expect(botoes.map((b) => b.textContent)).toEqual(TEXTOS);
  });

  // Cada sugestão manda O SEU texto. Um laço, e não um clique só, porque um
  // handler que ignorasse o índice passaria no caso único.
  it.each(TEXTOS.map((t, i) => [i, t] as const))(
    'tocar na sugestão %i dispara o callback com "%s"',
    (_i, texto) => {
      const onSugestao = vi.fn();
      render(<ChatVazioMiolo onSugestao={onSugestao} />);

      fireEvent.click(screen.getByRole('button', { name: texto }));

      expect(onSugestao.mock.calls).toEqual([[texto]]);
    },
  );

  it('não quebra ao tocar numa sugestão sem callback ligado', () => {
    render(<ChatVazioMiolo />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: TEXTOS[0] }))).not.toThrow();
  });

  it('não usa emoji em lugar nenhum — os ícones são SVG', () => {
    const { container } = render(<ChatVazioMiolo />);
    expect(container.textContent ?? '').not.toMatch(EMOJI);
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(TEXTOS.length);
  });

  /* A frase entre aspas da linha de apoio não é texto de UI: é contrato com o
     classificador embarcado (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`,
     limiar 0.92), treinado em "Ei Seraphine". E aqui ela é INSTRUÇÃO — "só diga
     X" — no estado vazio do chat, ou seja, onde alguém abre o app pela primeira
     vez e testa. Ensinar a frase errada é falha muda: a pessoa fala e nada
     acontece, sem erro nenhum na tela. Daí as duas metades: a frase certa
     aparece E a errada não sobrevive. */
  it('instrui a frase em que o modelo foi treinado, não outra', () => {
    render(<ChatVazioMiolo />);
    const apoio = screen.getByText(/Toque numa sugestão/).textContent ?? '';
    expect(apoio).toMatch(/ei seraphine/i);
    expect(apoio).not.toMatch(/oi sera\b/i);
  });

  it('exporta as sugestões como dado, na ordem do handoff', () => {
    expect(SUGESTOES.map((s) => s.texto)).toEqual(TEXTOS);
  });
});
