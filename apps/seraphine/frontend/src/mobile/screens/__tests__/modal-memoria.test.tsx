import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ModalMemoria, CONFIANCAS } from '../ModalMemoria';
import { createFact } from '../../../memory/api';

// A camada de memória é dublê no arquivo inteiro: nenhum teste de tela pode
// encostar em `fetch`. Os testes injetam `criar`; o único que deixa o padrão
// agir é o que prova que o padrão é a camada.
vi.mock('../../../memory/api', () => ({ createFact: vi.fn().mockResolvedValue({ id: 'f-1' }) }));

// O QUE ESTE ARQUIVO PRENDE
//
// O modal de lembrança tem Salvar explícito (ao contrário do irmão de tarefa,
// que salva sozinho). Num formulário assim os defeitos caros são três, e é o
// que os testes cercam:
//  - CRIAR QUE FALHA CALADO: fechar depois de um POST perdido faz o usuário
//    achar que a Seraphine guardou o que ele contou. Erro com `role="alert"`,
//    o sheet NÃO fecha, e o texto continua no campo.
//  - CAMPO VAZIO QUE "SALVA": um POST com texto em branco cria uma lembrança
//    que não diz nada (o backend só exige `min_length=1`, então um espaço
//    passaria pela validação dele).
//  - TEXTO DESCARTADO SEM AVISO: um toque solto no backdrop apagando o que foi
//    escrito é o mesmo sumiço silencioso, só que mais barato de causar.
//
// E prende uma AUSÊNCIA: o seletor de categoria. `POST /memory/facts`
// (`FactCreate` = text/source/confidence) não aceita categoria — ela é
// derivada do texto no servidor (`store.add_fact` → `_derive_fact_category`).
// Um seletor cujo valor a api joga fora seria o botão morto que a tela de
// Memória já recusou; o teste afirma que ele não existe, porque "não verifiquei"
// não é o mesmo que "verifiquei que não está lá".
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: jsdom não faz layout, então os
// testes de aparência não medem pixel; afirmam a CASCATA (existe regra no CSS
// que casa com aquele elemento e lhe declara o valor do handoff) — mesma
// técnica de `modal-tarefa.test.tsx` e de `mobile/__tests__/sheet.test.tsx`.

const CSS_PATH = resolve(__dirname, '..', 'ModalMemoria.css');

let estilo: HTMLStyleElement;

function regras(): CSSStyleRule[] {
  return Array.from(estilo.sheet!.cssRules).filter((r): r is CSSStyleRule => 'selectorText' in r);
}

/** O valor que o CSS declara para `prop` no elemento, varrendo as regras que de
 *  fato casam com ele (`pseudo` procura no `::after`). */
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
  const n = /^(-?\d+(?:\.\d+)?)px$/.exec(declarado(el, prop, pseudo));
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

function abrir(over: { criar?: Mock } = {}) {
  const criar = over.criar ?? vi.fn().mockResolvedValue(undefined);
  const onFechar = vi.fn();
  const onCriada = vi.fn();
  const utils = render(<ModalMemoria aberto onFechar={onFechar} criar={criar} onCriada={onCriada} />);
  return { ...utils, criar, onFechar, onCriada };
}

/** Deixa os `await` do envio assentarem. */
async function assentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function campo(): HTMLTextAreaElement {
  return screen.getByLabelText('Lembrança') as HTMLTextAreaElement;
}

function escrever(texto: string): void {
  fireEvent.change(campo(), { target: { value: texto } });
}

function salvar(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
}

describe('ModalMemoria — o que o handoff desenha', () => {
  it('mostra a dica da Seraphine, o campo livre e a confiança', () => {
    const { container } = abrir();

    expect(screen.getByText(/Escreva como se fosse me contar/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/prefiro reuniões depois das 10h/i)).toBeTruthy();
    expect(screen.getByText('Nova lembrança')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(salvar()).toBeTruthy();
    // Confiança abre em Alta, como o handoff
    expect((screen.getByLabelText('Confiança') as HTMLSelectElement).value).toBe('alta');
    expect(screen.getByRole('option', { name: 'Alta', selected: true })).toBeTruthy();
    expect(container.querySelector('.ms-mmemoria-valor')!.textContent).toBe('Alta');
    expect(screen.getByText(/levar isso a sério/i)).toBeTruthy();
  });

  it('o campo livre tem os 96px de altura mínima do handoff', () => {
    abrir();
    expect(declarado(campo(), 'min-height')).toBe('96px');
    // A fonte NÃO é afirmada aqui. O piso de 16px (abaixo disso o iOS dá zoom
    // ao focar) deixou de ser coisa de cada tela e virou uma regra só, em
    // `mobile/obsidian.css`, presa ao tipo do controle — quem a prende é
    // `mobile/__tests__/zoom-de-foco.test.tsx`, inclusive exigindo que NENHUMA
    // tela declare `font-size` num campo. Repetir a asserção aqui, contra um
    // arquivo que não declara mais nada, media o vazio e dava 0.
    expect(declarado(campo(), 'font-size')).toBe('');
  });

  it('Alta, Média e Baixa têm ponto verde, âmbar e vermelho', () => {
    const { container } = abrir();
    const ponto = () => container.querySelector('.ms-mmemoria-ponto') as HTMLElement;
    const visivel = () => container.querySelector('.ms-mmemoria-valor')!.textContent;

    expect(ponto().style.backgroundColor).toBe('rgb(74, 222, 128)'); // #4ade80 verde
    fireEvent.change(screen.getByLabelText('Confiança'), { target: { value: 'media' } });
    expect(ponto().style.backgroundColor).toBe('rgb(255, 167, 38)'); // #ffa726 âmbar
    expect(visivel()).toBe('Média');
    fireEvent.change(screen.getByLabelText('Confiança'), { target: { value: 'baixa' } });
    expect(ponto().style.backgroundColor).toBe('rgb(239, 107, 107)'); // #ef6b6b vermelho
    expect(visivel()).toBe('Baixa');
  });

  it('nada de emoji no texto renderizado', () => {
    const { container } = abrir();
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('ModalMemoria — a categoria que a api não aceita', () => {
  // `FactCreate` = {text, source, confidence}. Nada de categoria: o servidor a
  // deriva do texto. Desenhar os cinco chips do handoff seria prometer uma
  // escolha que o POST descarta.
  it('NÃO há seletor de categoria — nem chip, nem select, nem botão', () => {
    const { container } = abrir();

    expect(screen.queryByLabelText(/categoria/i)).toBeNull();
    for (const nome of ['Preferência', 'Pessoas', 'Trabalho', 'Rotina', 'Metas']) {
      expect(screen.queryByRole('button', { name: nome })).toBeNull();
      expect(screen.queryByRole('option', { name: nome })).toBeNull();
    }
    // e nenhum controle escondido com aparência de chip
    expect(container.querySelectorAll('.ms-mmemoria-categoria-chip').length).toBe(0);
  });

  it('em vez do seletor, diz quem escolhe a categoria', () => {
    abrir();
    expect(screen.getByText(/A Seraphine escolhe/i)).toBeTruthy();
  });

  it('a categoria não entra no que é enviado', async () => {
    const { criar } = abrir();
    escrever('prefiro reuniões depois das 10h');
    fireEvent.click(salvar());
    await assentar();

    expect(criar).toHaveBeenCalledTimes(1);
    expect(Object.keys(criar.mock.calls[0][0]).sort()).toEqual(['confidence', 'source', 'text']);
  });
});

describe('ModalMemoria — criar', () => {
  it('manda texto, source e confiança, avisa quem abriu e fecha', async () => {
    const { criar, onCriada, onFechar } = abrir();
    escrever('prefiro reuniões depois das 10h');
    fireEvent.click(salvar());
    await assentar();

    expect(criar).toHaveBeenCalledWith({
      text: 'prefiro reuniões depois das 10h',
      source: 'explicit',
      confidence: 1,
    });
    expect(onCriada).toHaveBeenCalledTimes(1);
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('a confiança escolhida vai no POST', async () => {
    const { criar } = abrir();
    escrever('acho que ele mora em Pinheiros');
    fireEvent.change(screen.getByLabelText('Confiança'), { target: { value: 'baixa' } });
    fireEvent.click(salvar());
    await assentar();

    expect(criar).toHaveBeenCalledWith({
      text: 'acho que ele mora em Pinheiros',
      source: 'explicit',
      confidence: 0.3,
    });
  });

  it('o número enviado volta com a MESMA palavra na tela de Memória', () => {
    // `MemoriaScreen.confianca()`: >= .8 alta, >= .5 média, o resto baixa. Se
    // este mapa sair da faixa, o cartão chamaria de "média" o que o usuário
    // marcou como "alta" — e ninguém veria, porque as duas telas são de donos
    // diferentes.
    const numero = (v: string) => CONFIANCAS.find((c) => c.valor === v)!.numero;
    expect(numero('alta')).toBeGreaterThanOrEqual(0.8);
    expect(numero('media')).toBeGreaterThanOrEqual(0.5);
    expect(numero('media')).toBeLessThan(0.8);
    expect(numero('baixa')).toBeLessThan(0.5);
    // e o contrato do backend: `FactCreate.confidence` é `ge=0.0, le=1.0`
    for (const c of CONFIANCAS) {
      expect(c.numero).toBeGreaterThanOrEqual(0);
      expect(c.numero).toBeLessThanOrEqual(1);
    }
  });

  it('manda o texto como o usuário escreveu — aparar é da camada', async () => {
    // A costura entre a tela e `createFact`: quem apara e quem RECUSA um texto
    // em branco é a camada, porque é lá que se sabe que o backend aceitaria
    // `" "` (`min_length=1`). Duplicar o `trim()` aqui criaria a segunda cópia
    // de uma regra — foi exatamente isso que a mutação M1 expôs neste arquivo.
    const { criar } = abrir();
    escrever('  odeio call antes das 9  ');
    fireEvent.click(salvar());
    await assentar();

    expect(criar).toHaveBeenCalledWith(expect.objectContaining({ text: '  odeio call antes das 9  ' }));
  });

  it('sem a prop `criar`, quem grava é a camada de memória (não um escritor morto)', async () => {
    // O padrão tem de ser um POST de verdade. Enquanto era `throw`, este modal
    // não podia ser montado em lugar nenhum.
    render(<ModalMemoria aberto onFechar={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Lembrança'), { target: { value: 'durmo tarde' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(createFact).toHaveBeenCalledWith({
      text: 'durmo tarde',
      source: 'explicit',
      confidence: 1,
    });
  });

  it('enquanto o POST está em voo mostra salvando… e não manda de novo', async () => {
    let liberar: (() => void) | null = null;
    const criar = vi.fn(() => new Promise<void>((res) => { liberar = () => res(); }));
    const { onFechar } = abrir({ criar });

    escrever('durmo tarde');
    fireEvent.click(salvar());
    await assentar();
    expect(screen.getByText('salvando…')).toBeTruthy();
    expect(salvar().disabled).toBe(true);

    fireEvent.click(salvar());
    await assentar();
    expect(criar).toHaveBeenCalledTimes(1);
    expect(onFechar).not.toHaveBeenCalled();

    await act(async () => { liberar!(); });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });
});

describe('ModalMemoria — campo vazio', () => {
  it('vazio não salva, e o botão diz isso antes do toque', async () => {
    const { criar } = abrir();

    expect(salvar().disabled).toBe(true);
    fireEvent.click(salvar());
    await assentar();
    expect(criar).not.toHaveBeenCalled();
  });

  it('só espaços também não é lembrança (o backend aceitaria: min_length=1)', async () => {
    const { criar, onFechar } = abrir();
    escrever('   ');

    expect(salvar().disabled).toBe(true);
    fireEvent.click(salvar());
    await assentar();
    expect(criar).not.toHaveBeenCalled();
    expect(onFechar).not.toHaveBeenCalled();
  });

  it('vazio NÃO é erro', () => {
    abrir();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/erro/i)).toBeNull();
  });

  it('escreveu algo, o Salvar libera', () => {
    abrir();
    escrever('a');
    expect(salvar().disabled).toBe(false);
  });
});

describe('ModalMemoria — o POST que falha', () => {
  it('grita como alert, NÃO fecha, e o que foi escrito continua no campo', async () => {
    const criar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { onFechar, onCriada } = abrir({ criar });

    escrever('minha mãe faz aniversário em março');
    fireEvent.click(salvar());
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/erro ao salvar/);
    expect(onFechar).not.toHaveBeenCalled();
    expect(onCriada).not.toHaveBeenCalled();
    // o texto é o que custa caro: ele não some junto com a falha
    expect(campo().value).toBe('minha mãe faz aniversário em março');
    // uma região de alerta, só (regra da onda)
    expect(screen.getAllByRole('alert').length).toBe(1);
    expect(screen.queryByText('salvando…')).toBeNull();
  });

  it('tentar de novo reenvia o mesmo texto, e o sucesso fecha', async () => {
    const criar = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { onFechar } = abrir({ criar });

    escrever('treino terça e quinta');
    fireEvent.click(salvar());
    await assentar();
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }));
    await assentar();

    expect(criar).toHaveBeenCalledTimes(2);
    expect(criar).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'treino terça e quinta' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('o erro fica FORA da área rolável do sheet', async () => {
    const criar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { container } = abrir({ criar });
    escrever('x');
    fireEvent.click(salvar());
    await assentar();

    const alerta = screen.getByRole('alert');
    expect(container.querySelector('.ms-sheet__corpo')!.contains(alerta)).toBe(false);
    expect(container.querySelector('.ms-sheet__rodape')!.contains(alerta)).toBe(true);
  });

  it('editar o texto limpa o erro (ele é do envio anterior)', async () => {
    const criar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    abrir({ criar });
    escrever('primeiro');
    fireEvent.click(salvar());
    await assentar();
    expect(screen.getByRole('alert')).toBeTruthy();

    escrever('primeiro corrigido');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ModalMemoria — sair sem perder o que foi escrito', () => {
  it('o backdrop não descarta no primeiro toque: avisa, e o segundo sai', async () => {
    const { container, onFechar } = abrir();
    escrever('não pode sumir');

    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    await assentar();
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/descartar/i);
    expect(campo().value).toBe('não pode sumir');

    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    await assentar();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('com o campo vazio não há o que perder: o backdrop fecha de primeira', async () => {
    const { container, onFechar } = abrir();
    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    await assentar();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('Cancelar é o descarte explícito: sai de primeira, mesmo com texto', async () => {
    const { criar, onFechar } = abrir();
    escrever('escrevi e desisti');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await assentar();

    expect(onFechar).toHaveBeenCalledTimes(1);
    expect(criar).not.toHaveBeenCalled();
  });
});

describe('ModalMemoria — moldura e alvo de toque', () => {
  it('é um diálogo com nome próprio e reusa o MobileSheet', () => {
    const { container } = abrir();
    expect(screen.getByRole('dialog', { name: 'Nova lembrança' })).toBeTruthy();
    expect(container.querySelector('.ms-sheet__painel')).toBeTruthy();
    // o modal não põe margem própria: o painel do sheet já tem o padding de 20
    expect(declarado(container.querySelector('.ms-mmemoria-cabecalho')!, 'margin-left')).toBe('');
  });

  it('fechado não deixa nada no DOM', () => {
    render(<ModalMemoria aberto={false} onFechar={vi.fn()} criar={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Lembrança')).toBeNull();
  });

  it('Cancelar, Salvar e o seletor de confiança têm 44pt de alvo', () => {
    abrir();
    for (const botao of [screen.getByRole('button', { name: 'Cancelar' }), salvar()]) {
      expect(declarado(botao, 'position', true)).toBe('absolute');
      expect(px(botao, 'height', true)).toBe(44);
      expect(px(botao, 'min-width', true)).toBe(44);
    }
    const seletor = screen.getByLabelText('Confiança');
    expect(declarado(seletor, 'position')).toBe('absolute');
    expect(px(seletor, 'height')).toBe(44);
    // A fonte do controle é do piso compartilhado, não desta tela — ver
    // `zoom-de-foco.test.tsx`.
    expect(declarado(seletor, 'font-size')).toBe('');
  });
});
