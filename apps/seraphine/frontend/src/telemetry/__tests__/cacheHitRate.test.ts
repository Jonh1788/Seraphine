import { describe, expect, it } from 'vitest';

import { cacheHitRate } from '../api';

/* A taxa de acerto do cache de prompt.
 *
 * O backend já gravava `cache_read_tokens`/`cache_write_tokens` havia semanas e
 * NENHUMA tela mostrava — o número existia só no banco. Esta função é o que o
 * torna legível, e o risco dela é inteiro sobre uma distinção: `null` (não dá
 * para dizer) versus `0` (o cache não pegou nada). Mostrar "0%" onde a resposta
 * é "não sei" inventaria um diagnóstico; mostrar "--" onde a resposta é 0%
 * esconderia um cache que está sendo pago e não usado.
 */

describe('cacheHitRate', () => {
  it('é a fração da entrada que veio do cache', () => {
    expect(cacheHitRate({ input_tokens: 1000, cache_read_tokens: 800 })).toBeCloseTo(0.8);
    expect(cacheHitRate({ input_tokens: 1000, cache_read_tokens: 1000 })).toBe(1);
  });

  it('escrita sem leitura é 0%, e isso NÃO é "não sei"', () => {
    /* Primeiro turno de uma conversa: o cache foi escrito (a 1,25x do preço) e
       nada foi lido dele ainda. Zero é a resposta certa e é acionável — é o
       custo do cache sem o benefício. */
    const taxa = cacheHitRate({ input_tokens: 5000, cache_read_tokens: 0, cache_write_tokens: 5000 });
    expect(taxa).toBe(0);
    expect(taxa).not.toBeNull();
  });

  it('backend que não reporta cache devolve null, não zero', () => {
    // cliproxy: nenhum dos dois contadores. Dizer 0% afirmaria que o cache
    // falhou, quando na verdade não há cache nenhum nessa rota.
    expect(cacheHitRate({ input_tokens: 5000 })).toBeNull();
    expect(cacheHitRate({ input_tokens: 5000, cache_read_tokens: 0, cache_write_tokens: 0 })).toBeNull();
  });

  it('sem entrada não há fração', () => {
    expect(cacheHitRate({ input_tokens: 0, cache_read_tokens: 0 })).toBeNull();
    // Divisão por zero nunca pode virar Infinity numa tela.
    expect(cacheHitRate({ input_tokens: 0, cache_read_tokens: 100 })).toBeNull();
  });

  it('campos ausentes contam como zero, sem NaN', () => {
    expect(cacheHitRate({ input_tokens: 100, cache_read_tokens: 50 })).toBeCloseTo(0.5);
    const r = cacheHitRate({ input_tokens: 100, cache_write_tokens: 10 });
    expect(r).toBe(0);
    expect(Number.isNaN(r as number)).toBe(false);
  });

  it('a leitura NÃO é subtraída da entrada — o cache é subconjunto dela', () => {
    /* Na semântica OpenAI que o OpenRouter normaliza, `prompt_tokens` já é o
       TOTAL. Se alguém "corrigir" a fórmula para read/(input+read), 800 de
       1000 vira 44% e a tela passa a subnotificar o cache pela metade. */
    expect(cacheHitRate({ input_tokens: 1000, cache_read_tokens: 800 })).toBeCloseTo(0.8);
    expect(cacheHitRate({ input_tokens: 1000, cache_read_tokens: 800 })).not.toBeCloseTo(800 / 1800);
  });
});
