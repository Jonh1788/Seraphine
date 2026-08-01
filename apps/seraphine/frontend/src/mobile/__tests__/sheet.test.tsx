import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MobileSheet } from '../MobileSheet';

// O QUE ESTE ARQUIVO PRENDE
//
// `MobileSheet` é a ÚNICA moldura de sheet da onda: os três modais (tarefa,
// evento, memória) a consomem em vez de cada um redesenhar backdrop, grabber e
// cantos. Por isso os quatro riscos clássicos de sheet moram aqui, uma vez, e
// não três:
//
// 1. fechado não pode deixar conteúdo no DOM (campo de formulário focável por
//    trás do backdrop é o sintoma de um sheet que só se esconde com CSS);
// 2. o backdrop fecha, o conteúdo não (o clique não pode borbulhar de um campo
//    até o backdrop e derrubar o modal no meio da digitação);
// 3. o rodapé fica FORA da área rolável (é onde o modal de tarefa mostra
//    salvando…/salvo/erro ao salvar — se rolar junto, o erro some justo quando
//    importa);
// 4. o teclado do iOS não pode enterrar o rodapé.
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: jsdom não faz layout. Nenhum
// `getBoundingClientRect()` mede nada e `getComputedStyle(el, '::after')` é
// "Not implemented". Então os testes de aparência não medem pixel pintado; eles
// afirmam a CASCATA — existe no CSS uma regra que casa com aquele elemento e
// lhe declara o valor do handoff. É o que morre quando alguém apaga a regra ou
// troca o valor. O retângulo em si continua sendo coisa de simulador.

const CSS_PATH = resolve(__dirname, '..', 'MobileSheet.css');
/** CSS sem comentários: as asserções de texto cru não podem casar com prosa. */
const cssCru = readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** As declarações das regras deste seletor exato — para os valores que o CSSOM
 *  do jsdom normaliza ou descarta (atalhos, `var()`, `env()`, `min()`). Junta
 *  todas as ocorrências para não depender da ordem no arquivo (o mesmo seletor
 *  reaparece sob `prefers-reduced-motion`). */
function bloco(seletor: string): string {
  const partes: string[] = [];
  for (let i = cssCru.indexOf(seletor + ' {'); i !== -1; i = cssCru.indexOf(seletor + ' {', i + 1)) {
    partes.push(cssCru.slice(cssCru.indexOf('{', i) + 1, cssCru.indexOf('}', i)));
  }
  if (!partes.length) throw new Error(`sem regra para ${seletor}`);
  return partes.join('\n');
}

const FONE = "html[data-shell='phone'] ";

let estilo: HTMLStyleElement;
function regras(): CSSStyleRule[] {
  return Array.from(estilo.sheet!.cssRules).filter((r): r is CSSStyleRule => 'selectorText' in r);
}

/** O valor que o CSS declara para `prop` no elemento — varrendo as regras que
 *  de fato casam com ele (mesma técnica de `alvo-de-toque.test.tsx`). */
function declarado(el: Element, prop: string, pseudo = false): string {
  let achado = '';
  for (const regra of regras()) {
    for (const parte of regra.selectorText.split(',')) {
      const seletor = parte.trim();
      const base = seletor.replace(/::?(after|before)$/, '');
      if ((base !== seletor) !== pseudo) continue;
      if (!el.matches(base)) continue;
      const v = regra.style.getPropertyValue(prop).trim();
      if (v) achado = v;
    }
  }
  return achado;
}

function px(el: Element, prop: string, pseudo = false): number {
  const n = /^(\d+(?:\.\d+)?)px$/.exec(declarado(el, prop, pseudo));
  return n ? Number(n[1]) : 0;
}

beforeAll(() => {
  document.documentElement.dataset.shell = 'phone';
  estilo = document.createElement('style');
  estilo.textContent = readFileSync(CSS_PATH, 'utf8');
  document.head.appendChild(estilo);
});

afterAll(() => {
  estilo.remove();
  delete document.documentElement.dataset.shell;
});

describe('MobileSheet', () => {
  it('fechado não deixa conteúdo no DOM', () => {
    render(
      <MobileSheet aberto={false} onFechar={vi.fn()}>
        <input placeholder="oi" />
      </MobileSheet>,
    );
    // Nem o conteúdo (um campo escondido atrás do backdrop continua focável
    // pelo Tab), nem a moldura.
    expect(screen.queryByPlaceholderText('oi')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.ms-sheet__backdrop')).toBeNull();
  });

  it('toque no backdrop fecha; toque no conteúdo não', () => {
    const onFechar = vi.fn();
    const { container } = render(
      <MobileSheet aberto onFechar={onFechar}>
        <button>dentro</button>
      </MobileSheet>,
    );
    fireEvent.click(screen.getByText('dentro'));
    expect(onFechar).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('o rodapé fica fora da área rolável', () => {
    // o indicador de autosave não pode sumir com o scroll do conteúdo
    const { container } = render(
      <MobileSheet aberto onFechar={vi.fn()} rodape={<span>salvo</span>}>
        x
      </MobileSheet>,
    );
    const rolavel = container.querySelector('.ms-sheet__corpo')!;
    expect(rolavel.contains(screen.getByText('salvo'))).toBe(false);

    // Estar fora do `.ms-sheet__corpo` no DOM só basta se quem rola for ELE:
    // com `overflow` no painel, o rodapé sairia da tela do mesmo jeito.
    const painel = container.querySelector('.ms-sheet__painel')!;
    expect(declarado(rolavel, 'overflow-y')).toBe('auto');
    expect(declarado(painel, 'overflow-y')).not.toMatch(/auto|scroll/);
    expect(declarado(painel, 'flex-direction')).toBe('column');
    // e se ele encolhesse, um corpo comprido o achataria a zero
    expect(declarado(container.querySelector('.ms-sheet__rodape')!, 'flex-shrink')).toBe('0');
  });

  it('o rodapé sobe com o teclado do iOS', () => {
    const { container, vv } = comTeclado();
    const painel = container.querySelector('.ms-sheet__painel') as HTMLElement;
    expect(painel.style.getPropertyValue('--ms-sheet-teclado')).toBe('0px');

    // teclado subiu: a visual viewport encolhe, a layout viewport não
    act(() => {
      vv.height = window.innerHeight - 336;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(painel.style.getPropertyValue('--ms-sheet-teclado')).toBe('336px');

    act(() => {
      vv.height = window.innerHeight;
      vv.dispatchEvent(new Event('resize'));
    });
    expect(painel.style.getPropertyValue('--ms-sheet-teclado')).toBe('0px');
  });

  it('a medida do teclado desloca o painel de verdade', () => {
    // A variável só serve se o CSS a consumir; senão é enfeite que passa no
    // teste acima e enterra o rodapé no aparelho.
    expect(bloco(FONE + '.ms-sheet__painel')).toMatch(/bottom:[^;]*var\(--ms-sheet-teclado/);
  });

  it('é um diálogo modal, nasce com o foco e fecha no Escape', () => {
    const onFechar = vi.fn();
    const { container } = render(
      <MobileSheet aberto onFechar={onFechar} titulo={<h2>Nova tarefa</h2>}>
        x
      </MobileSheet>,
    );
    const painel = container.querySelector('.ms-sheet__painel')!;
    expect(painel.getAttribute('role')).toBe('dialog');
    expect(painel.getAttribute('aria-modal')).toBe('true');
    // nome acessível: quem lê tela precisa saber QUAL modal abriu
    expect(document.getElementById(painel.getAttribute('aria-labelledby')!)?.textContent).toBe('Nova tarefa');
    expect(document.activeElement).toBe(painel);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('o controle de fechar da moldura tem alvo de 44pt', () => {
    const { container } = render(
      <MobileSheet aberto onFechar={vi.fn()}>
        x
      </MobileSheet>,
    );
    const fechar = container.querySelector('.ms-sheet__grabber')!;
    expect(fechar.getAttribute('aria-label')).toBe('Fechar');
    // Mesmo mecanismo do ‹ das telas empurradas (obsidian.css): o pseudo cresce
    // por fora, centrado, sem mover nem engordar a barrinha desenhada.
    expect(declarado(fechar, 'position', true)).toBe('absolute');
    expect(`${px(fechar, 'width', true)}x${px(fechar, 'height', true)}`).toBe('44x44');
    // e a barrinha do handoff continua 38×4
    expect(`${px(fechar, 'width')}x${px(fechar, 'height')}`).toBe('38x4');
  });

  it('mantém as medidas do handoff (backdrop, raio, home indicator)', () => {
    const backdrop = bloco(FONE + '.ms-sheet__backdrop');
    expect(backdrop).toMatch(/background:\s*rgba\(0,\s*0,\s*0,\s*\.55\)/);
    expect(backdrop).toMatch(/backdrop-filter:\s*blur\(3px\)/);
    const painel = bloco(FONE + '.ms-sheet__painel');
    expect(painel).toMatch(/border-radius:\s*28px 28px 0 0/);
    expect(painel).toMatch(/34px/); // padding inferior do home indicator
  });
});

/** Sheet aberto com uma `visualViewport` falsa — jsdom não tem a dele. */
function comTeclado() {
  const vv = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
  Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
  const r = render(
    <MobileSheet aberto onFechar={vi.fn()} rodape={<span>salvo</span>}>
      x
    </MobileSheet>,
  );
  return { ...r, vv };
}

afterEach(() => {
  Reflect.deleteProperty(window, 'visualViewport');
});
