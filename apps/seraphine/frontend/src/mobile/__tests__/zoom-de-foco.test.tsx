import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// O QUE ESTE ARQUIVO PRENDE
//
// O Safari do iPhone dá ZOOM na página quando um campo focado tem fonte abaixo
// de 16px — e o zoom não volta sozinho. O handoff especifica 13–15px, então
// TODO campo do app fazia isso: tocar numa busca, num título ou numa descrição
// aproximava a tela e a deixava lá.
//
// A correção não podia ser "arrume esta tela": o defeito é do TIPO do controle,
// não da tela, e a tela seguinte nasceria com ele de novo. Então é UMA regra em
// `mobile/obsidian.css`, presa a `input`/`select`/`textarea` — o mesmo desenho
// da regra de 44pt, que é presa ao rótulo do botão e por isso já valeu para
// telas que ainda não existiam quando foi escrita.
//
// O QUE ISTO AFIRMA, E O QUE NÃO: jsdom não faz layout nem cascata completa,
// então aqui não se mede pixel pintado — afirma-se a CASCATA no fonte: existe a
// regra do piso, ela é `!important` (é o que a faz vencer o valor de cada tela),
// e NENHUMA tela declara `font-size` num campo. Esta última é a que mais
// trabalha: sob um piso `!important`, uma declaração de tela é letra morta que
// PARECE viva — o próximo que quiser mudar o tamanho vai editá-la e não
// entender por que nada muda. Quem precisa de mais que o piso diz por
// `--ms-campo`, e o `max()` respeita.

const DIR_MOBILE = resolve(__dirname, '..');
const DIR_TELAS = resolve(DIR_MOBILE, 'screens');
const CSS_SHELL = resolve(DIR_MOBILE, 'obsidian.css');
const PISO = 16;

/** Todo `<input>`/`<select>`/`<textarea>` das telas, com as classes de cada um.
 *  Anda a tag contando chaves para não parar no `>` de uma arrow (`() =>`) —
 *  mesmo varredor da regra de 44pt. */
function camposDasTelas(): Array<{ tela: string; tag: string; classes: string[] }> {
  const achados: Array<{ tela: string; tag: string; classes: string[] }> = [];
  for (const arquivo of readdirSync(DIR_TELAS)) {
    if (!arquivo.endsWith('.tsx')) continue;
    const src = readFileSync(resolve(DIR_TELAS, arquivo), 'utf8');
    for (const tag of ['input', 'select', 'textarea']) {
      for (let i = src.indexOf(`<${tag}`); i !== -1; i = src.indexOf(`<${tag}`, i + 1)) {
        let chaves = 0;
        let fim = -1;
        for (let j = i + tag.length + 1; j < src.length; j++) {
          const c = src[j];
          if (c === '{') chaves++;
          else if (c === '}') chaves--;
          else if (c === '>' && chaves === 0) { fim = j; break; }
        }
        if (fim === -1) continue;
        const m = /className="([^"]+)"/.exec(src.slice(i, fim));
        achados.push({ tela: arquivo, tag, classes: m ? m[1].split(/\s+/).filter(Boolean) : [] });
      }
    }
  }
  return achados;
}

/** Todo arquivo CSS do mobile — o do shell e o de cada tela. */
function cssDoMobile(): Array<{ arquivo: string; texto: string }> {
  const fontes = [{ arquivo: 'obsidian.css', texto: readFileSync(CSS_SHELL, 'utf8') }];
  for (const arquivo of readdirSync(DIR_TELAS)) {
    if (!arquivo.endsWith('.css')) continue;
    fontes.push({ arquivo, texto: readFileSync(resolve(DIR_TELAS, arquivo), 'utf8') });
  }
  return fontes;
}

/** `seletor { corpo }`, cru — basta para o que se afirma aqui. */
function regras(texto: string): Array<{ seletor: string; corpo: string }> {
  return [...texto.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    seletor: m[1].trim(),
    corpo: m[2],
  }));
}

const CAMPOS = camposDasTelas();
const CLASSES_DE_CAMPO = new Set(CAMPOS.flatMap((c) => c.classes));
const casaCampo = (seletor: string): boolean =>
  [...CLASSES_DE_CAMPO].some((c) => new RegExp(`\\.${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(seletor));

describe('zoom de foco do iOS: piso de 16px nos campos', () => {
  // Se o varredor parar de achar campo, tudo abaixo passaria calado sobre uma
  // lista vazia. Este número é o piso conhecido hoje.
  it('acha os campos das telas', () => {
    expect(CAMPOS.length).toBeGreaterThanOrEqual(20);
    expect(CLASSES_DE_CAMPO.size).toBeGreaterThanOrEqual(15);
  });

  it('o CSS do shell declara o piso para os três tipos de campo', () => {
    const doShell = regras(readFileSync(CSS_SHELL, 'utf8'));
    /** O ALVO tem de ser a tag NUA: `textarea` pega todas, `textarea.algo` pega
     *  as que tiverem aquela classe — e uma regra assim satisfaria um "contém a
     *  palavra textarea" enquanto deixa o resto das telas sem piso. */
    const cobreATagInteira = (seletor: string, tag: string): boolean =>
      seletor.split(',').some((parte) => {
        const partes = parte.trim().split(/\s+/);
        return partes[partes.length - 1] === tag
          && parte.includes("data-shell='phone'");
      });
    for (const tag of ['input', 'select', 'textarea']) {
      const regra = doShell.find(
        (r) => cobreATagInteira(r.seletor, tag) && /font-size/.test(r.corpo),
      );
      expect(`${tag}: ${regra ? 'tem piso' : 'SEM PISO (ou preso a uma classe)'}`)
        .toBe(`${tag}: tem piso`);
      // `!important` é o que faz o piso vencer o valor de cada tela. Sem ele a
      // regra existe e não vale nada — e o teste passaria do mesmo jeito.
      expect(regra!.corpo).toMatch(/font-size:[^;]*!important/);
      const min = /max\(\s*(\d+)px/.exec(regra!.corpo);
      expect(Number(min?.[1])).toBe(PISO);
    }
  });

  it('nenhuma tela declara font-size num campo — sob o piso, seria letra morta', () => {
    const mortas: string[] = [];
    for (const { arquivo, texto } of cssDoMobile()) {
      if (arquivo === 'obsidian.css') continue; // é o dono do piso
      for (const { seletor, corpo } of regras(texto)) {
        if (!/font-size:/.test(corpo)) continue;
        if (casaCampo(seletor)) mortas.push(`${arquivo}: ${seletor.split('\n').pop()!.trim()}`);
      }
    }
    expect(mortas).toEqual([]);
  });

  it('quem quer mais que o piso diz por --ms-campo, e nunca menos', () => {
    const canal: string[] = [];
    for (const { arquivo, texto } of cssDoMobile()) {
      for (const { seletor, corpo } of regras(texto)) {
        const m = /--ms-campo:\s*([0-9.]+)px/.exec(corpo);
        if (!m) continue;
        canal.push(`${arquivo}: ${seletor.split('\n').pop()!.trim()}`);
        // Pedir MENOS que o piso pelo canal seria contrabandear de volta o zoom
        // que o piso existe para matar — e o `max()` o ignoraria em silêncio.
        expect(Number(m[1])).toBeGreaterThanOrEqual(PISO);
      }
    }
    // Os dois títulos do handoff que passam do piso (18px e 17px): se o canal
    // ficar vazio, ou alguém apagou o desenho, ou voltou a declarar `font-size`.
    expect(canal.length).toBeGreaterThanOrEqual(2);
  });
});
