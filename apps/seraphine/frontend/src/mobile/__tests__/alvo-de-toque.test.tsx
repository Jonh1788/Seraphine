import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O QUE ESTE ARQUIVO PRENDE
//
// Todo controle que TIRA da tela (o ‹ das empurradas, o X da lição) tem de ter
// pelo menos 44×44pt de alvo — o mínimo da HIG, o mesmo que a tab bar já cumpre
// em `.mtab`. A garantia morava no cabeçalho que o shell desenhava; quando cada
// tela passou a desenhar o seu, sumiu sem ninguém perceber, e as caixas ficaram
// entre 22px e 43px. Ela voltou como UMA regra compartilhada em
// `mobile/obsidian.css`, presa ao rótulo do botão.
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: jsdom não faz layout — todo
// `getBoundingClientRect()` devolve zero e `getComputedStyle(el, '::after')` é
// "Not implemented". Então este teste NÃO mede o retângulo pintado; ele afirma
// a cascata: existe, no CSS do shell, uma regra que casa com aquele botão e lhe
// declara 44×44 (na própria caixa ou num pseudo posicionado sobre ela). É o que
// morre quando alguém apaga a regra, encolhe o 44 ou troca o rótulo do controle
// numa tela nova. O retângulo em si continua sendo coisa de simulador.

const DIR_MOBILE = resolve(__dirname, '..');
const CSS_SHELL = resolve(DIR_MOBILE, 'obsidian.css');
const DIR_TELAS = resolve(DIR_MOBILE, 'screens');
const MINIMO = 44;

/** Os `<button>` de uma tela que chamam `onBack`, pelo aria-label de cada um.
 *  Anda a tag contando chaves para não parar no `>` de uma arrow (`() =>`). */
function rotulosQueVoltam(src: string): string[] {
  const rotulos: string[] = [];
  for (let i = src.indexOf('<button'); i !== -1; i = src.indexOf('<button', i + 1)) {
    let chaves = 0;
    let fim = -1;
    for (let j = i + '<button'.length; j < src.length; j++) {
      const c = src[j];
      if (c === '{') chaves++;
      else if (c === '}') chaves--;
      else if (c === '>' && chaves === 0) { fim = j; break; }
    }
    if (fim === -1) continue;
    const tag = src.slice(i, fim);
    if (!tag.includes('onBack')) continue;
    const m = /aria-label="([^"]+)"/.exec(tag);
    if (m) rotulos.push(m[1]);
  }
  return rotulos;
}

function controlesDeSaida(): Array<{ tela: string; rotulo: string }> {
  const achados: Array<{ tela: string; rotulo: string }> = [];
  for (const arquivo of readdirSync(DIR_TELAS)) {
    if (!arquivo.endsWith('.tsx')) continue;
    const src = readFileSync(resolve(DIR_TELAS, arquivo), 'utf8');
    for (const rotulo of rotulosQueVoltam(src)) achados.push({ tela: arquivo, rotulo });
  }
  return achados;
}

/** `style.minWidth` volta vazio no CSSOM do jsdom (a propriedade não está na
 *  lista tipada do cssstyle); `getPropertyValue` lê o que o parser guardou. */
function pxDe(estiloDaRegra: CSSStyleDeclaration, prop: string): number {
  const n = /^(\d+(?:\.\d+)?)px$/.exec(estiloDaRegra.getPropertyValue(prop).trim());
  return n ? Number(n[1]) : 0;
}

function regrasDoShell(): CSSStyleRule[] {
  return Array.from(estilo.sheet!.cssRules).filter((r): r is CSSStyleRule => 'selectorText' in r);
}

/** O maior alvo que o CSS do shell garante para este botão: ou a caixa dele
 *  (min-width/width), ou um pseudo absoluto desenhado por cima. */
function alvoGarantido(el: Element): { largura: number; altura: number } {
  let largura = 0;
  let altura = 0;
  for (const regra of regrasDoShell()) {
    for (const parte of regra.selectorText.split(',')) {
      const seletor = parte.trim();
      const base = seletor.replace(/::?(after|before)$/, '');
      // pseudo solto não cobre nada: só conta se estiver posicionado sobre o botão
      if (base !== seletor && regra.style.getPropertyValue('position') !== 'absolute') continue;
      if (!el.matches(base)) continue;
      largura = Math.max(largura, pxDe(regra.style, 'min-width') || pxDe(regra.style, 'width'));
      altura = Math.max(altura, pxDe(regra.style, 'min-height') || pxDe(regra.style, 'height'));
    }
  }
  return { largura, altura };
}

let estilo: HTMLStyleElement;

describe('alvo de toque dos controles de saída (44pt)', () => {
  beforeAll(() => {
    document.documentElement.dataset.shell = 'phone';
    estilo = document.createElement('style');
    estilo.textContent = readFileSync(CSS_SHELL, 'utf8');
    document.head.appendChild(estilo);
  });

  afterAll(() => {
    estilo.remove();
    delete document.documentElement.dataset.shell;
  });

  // Se o varredor de fonte parar de achar os botões, ele passaria calado e o
  // resto do arquivo viraria enfeite. Este número é o piso conhecido hoje:
  // 12 ‹ de "Voltar" + os 2 X de "Sair da lição".
  it('acha todos os controles de saída das telas', () => {
    const achados = controlesDeSaida();
    expect(achados.length).toBeGreaterThanOrEqual(14);
    expect(new Set(achados.map((a) => a.rotulo))).toEqual(new Set(['Voltar', 'Sair da lição']));
  });

  it('o CSS do shell garante 44×44 para cada rótulo de saída, na pilha e na aba', () => {
    // Dois contêineres porque as duas montagens existem: a tela empurrada
    // (`.mpushed__body`) e a ABA — o mapa de Trilhas desenha o mesmo ‹ dentro
    // de `.mshell__content` (ver PhoneShell). Uma regra presa só à pilha
    // deixaria o mapa de fora.
    document.body.innerHTML = `
      <div class="mshell">
        <div class="mpushed"><div class="mpushed__body" id="pilha"></div></div>
        <main class="mshell__content" id="aba"></main>
      </div>`;

    const rotulos = [...new Set(controlesDeSaida().map((a) => a.rotulo))];
    for (const onde of ['pilha', 'aba']) {
      const caixa = document.getElementById(onde)!;
      for (const rotulo of rotulos) {
        const botao = document.createElement('button');
        botao.setAttribute('aria-label', rotulo);
        caixa.appendChild(botao);
        const { largura, altura } = alvoGarantido(botao);
        expect(`${onde}/${rotulo}: ${largura}x${altura}`).toBe(`${onde}/${rotulo}: ${MINIMO}x${MINIMO}`);
      }
    }
  });

  // A tab bar nunca perdeu o mínimo dela; é o outro lado do mesmo padrão e
  // serve de âncora: se ele mudar, os dois lados mudam juntos.
  it('a tab bar do shell continua com o mesmo mínimo', () => {
    document.body.innerHTML = `<div class="mshell"><nav class="mtabbar"><button class="mtab"></button></nav></div>`;
    const { largura, altura } = alvoGarantido(document.querySelector('.mtab')!);
    expect(largura).toBeGreaterThanOrEqual(MINIMO);
    expect(altura).toBeGreaterThanOrEqual(MINIMO);
  });
});
