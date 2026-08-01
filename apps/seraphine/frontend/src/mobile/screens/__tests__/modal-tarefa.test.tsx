import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ModalTarefa } from '../ModalTarefa';
import type { Task } from '../../../tasks/types';

// O QUE ESTE ARQUIVO PRENDE
//
// O modal de tarefa não tem Cancelar nem Salvar: cada campo vira um
// `PATCH /tasks/:id` 800ms depois da última tecla. Num formulário assim o
// defeito mais caro não é o campo errado — é o SAVE QUE FALHA CALADO: o
// usuário fecha o sheet convencido de que salvou e o texto some. Por isso o
// caminho de falha tem tantos testes quanto o feliz, e o fechar com save em voo
// tem os seus.
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: jsdom não faz layout, então os
// testes de aparência não medem pixel; afirmam a CASCATA (existe regra no CSS
// que casa com aquele elemento e lhe declara o valor do handoff) — mesma
// técnica de `mobile/__tests__/sheet.test.tsx`. O retângulo pintado continua
// sendo coisa de simulador.

const CSS_PATH = resolve(__dirname, '..', 'ModalTarefa.css');

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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function tarefa(over: Partial<Task> = {}): Task {
  return {
    id: 7,
    type: 'generic',
    status: 'pending',
    title: '',
    description: '',
    source: 'mobile',
    payload: {},
    created_at: '2026-06-20T09:00:00',
    ...over,
  };
}

/** A tarefa cheia do handoff: Pendente, Alta, Moradia, 20 de junho 09:00,
 *  1 hora antes, tag "casa". */
function tarefaCheia(): Task {
  return tarefa({
    title: 'Pagar aluguel',
    description: 'boleto no e-mail',
    status: 'pending',
    priority: 'high',
    category: 'moradia',
    due_date: '2026-06-20',
    due_time: '09:00',
    remind: '1h_before',
    tags: ['casa'],
  });
}

function abrir(over: { tarefa?: Task; salvar?: Mock; excluir?: Mock } = {}) {
  const salvar = over.salvar ?? vi.fn().mockResolvedValue(undefined);
  const excluir = over.excluir ?? vi.fn().mockResolvedValue(undefined);
  const onFechar = vi.fn();
  const onSalvo = vi.fn();
  const utils = render(
    <ModalTarefa
      aberto
      tarefa={over.tarefa ?? tarefaCheia()}
      onFechar={onFechar}
      salvar={salvar}
      excluir={excluir}
      onSalvo={onSalvo}
    />,
  );
  return { ...utils, salvar, excluir, onFechar, onSalvo };
}

/** Deixa o debounce vencer e os `await` do envio assentarem. */
async function passar(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('ModalTarefa — dado, vazio e erro', () => {
  it('mostra a tarefa com status, prioridade, categoria, data, lembrete, tags e descrição', () => {
    abrir();

    expect((screen.getByLabelText('Título da tarefa') as HTMLInputElement).value).toBe('Pagar aluguel');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('pending');
    expect(screen.getByRole('option', { name: 'Pendente', selected: true })).toBeTruthy();
    expect((screen.getByLabelText('Prioridade') as HTMLSelectElement).value).toBe('high');
    expect((screen.getByLabelText('Categoria') as HTMLSelectElement).value).toBe('moradia');
    expect((screen.getByLabelText('Data') as HTMLInputElement).value).toBe('2026-06-20');
    expect(screen.getByText('20 de junho')).toBeTruthy();
    expect((screen.getByLabelText('Hora') as HTMLInputElement).value).toBe('09:00');
    expect((screen.getByLabelText('Lembrete') as HTMLSelectElement).value).toBe('1h_before');
    expect(screen.getByText('casa')).toBeTruthy();
    expect((screen.getByLabelText('Descrição') as HTMLTextAreaElement).value).toBe('boleto no e-mail');
    // rodapé do handoff: a data de criação
    expect(screen.getByText('20/06/2026')).toBeTruthy();
  });

  it('as cores de status, prioridade e categoria são as do spec, no ponto', () => {
    const { container } = abrir();
    const ponto = (qual: string) => container.querySelector(`.ms-mtarefa-ponto--${qual}`) as HTMLElement;
    expect(ponto('status').style.backgroundColor).toBe('rgb(154, 147, 255)'); // #9a93ff pendente
    expect(ponto('prioridade').style.backgroundColor).toBe('rgb(239, 68, 68)'); // #ef4444 alta
    expect(ponto('categoria').style.backgroundColor).toBe('rgb(92, 107, 192)'); // #5c6bc0 moradia

    // e o ponto acompanha a escolha do usuário, não só o valor que chegou
    for (const [valor, cor] of [
      ['approved', 'rgb(34, 211, 238)'], // #22d3ee em andamento
      ['completed', 'rgb(74, 222, 128)'], // #4ade80 concluido
      ['rejected', 'rgb(100, 116, 139)'], // #64748b descartado
    ] as const) {
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: valor } });
      expect(ponto('status').style.backgroundColor).toBe(cor);
    }

    for (const [valor, cor] of [
      ['low', 'rgb(74, 222, 128)'], // #4ade80 baixa
      ['med', 'rgb(245, 158, 11)'], // #f59e0b media
    ] as const) {
      fireEvent.change(screen.getByLabelText('Prioridade'), { target: { value: valor } });
      expect(ponto('prioridade').style.backgroundColor).toBe(cor);
    }
  });

  it('a categoria vem da taxonomia de finanças SEM o emoji do label', () => {
    abrir();
    const opcoes = Array.from(screen.getByLabelText('Categoria').querySelectorAll('option')).map((o) => o.textContent);
    expect(opcoes).toContain('Moradia');
    expect(opcoes).toContain('Alimentação');
    expect(opcoes).toContain('Selecionar');
    for (const texto of opcoes) expect(texto ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('tarefa vazia mostra os placeholders do handoff e NÃO é um erro', () => {
    abrir({ tarefa: tarefa() });

    expect(screen.getByPlaceholderText('Titulo da tarefa...')).toBeTruthy();
    expect(screen.getByPlaceholderText('adicionar tag...')).toBeTruthy();
    expect(screen.getByPlaceholderText('Escreva os detalhes...')).toBeTruthy();
    expect((screen.getByLabelText('Prioridade') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Categoria') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Lembrete') as HTMLSelectElement).value).toBe('');
    // "Selecionar" é a opção vazia de prioridade E de categoria
    expect(screen.getAllByRole('option', { name: 'Selecionar' }).length).toBe(2);
    expect(screen.getByRole('option', { name: 'Nao lembrar', selected: true })).toBeTruthy();
    expect(screen.getByText('Selecionar data')).toBeTruthy();
    // vazio não é erro
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/erro/i)).toBeNull();
  });

  it('nada de emoji no texto renderizado', () => {
    const { container } = abrir();
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('ModalTarefa — autosave', () => {
  it('espera 800ms depois da última tecla, e manda uma vez só', async () => {
    const { salvar } = abrir();
    const titulo = screen.getByLabelText('Título da tarefa');

    for (const v of ['P', 'Pa', 'Pag', 'Paga']) {
      fireEvent.change(titulo, { target: { value: v } });
      await passar(100);
    }
    expect(salvar).not.toHaveBeenCalled(); // 400ms de digitação, nenhum PATCH

    await passar(699);
    expect(salvar).not.toHaveBeenCalled();

    await passar(1);
    expect(salvar).toHaveBeenCalledTimes(1);
    expect(salvar).toHaveBeenCalledWith(7, { title: 'Paga' });
  });

  it('junta os campos mudados na janela do debounce num PATCH só', async () => {
    const { salvar } = abrir();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'approved' } });
    fireEvent.change(screen.getByLabelText('Prioridade'), { target: { value: 'low' } });
    await passar(800);

    expect(salvar).toHaveBeenCalledTimes(1);
    expect(salvar).toHaveBeenCalledWith(7, { status: 'approved', priority: 'low' });
  });

  it('sucesso: mostra salvando… e depois salvo', async () => {
    let liberar: (() => void) | null = null;
    const salvar = vi.fn(() => new Promise<void>((res) => { liberar = () => res(); }));
    const { onSalvo } = abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'boleto pago' } });
    await passar(800);
    expect(screen.getByText('salvando…')).toBeTruthy();
    expect(screen.queryByText('salvo')).toBeNull();

    await act(async () => { liberar!(); });
    expect(screen.getByText('salvo')).toBeTruthy();
    expect(screen.queryByText('salvando…')).toBeNull();
    expect(onSalvo).toHaveBeenCalled();
  });

  it('FALHA DO PATCH: o rodapé grita, e grita como alert', async () => {
    const salvar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'boleto pago' } });
    await passar(800);

    expect(screen.getByRole('alert').textContent).toMatch(/erro ao salvar/);
    // e em hipótese alguma o oposto
    expect(screen.queryByText('salvo')).toBeNull();
    expect(screen.queryByText('salvando…')).toBeNull();
    // uma região de alerta, só (regra da onda)
    expect(screen.getAllByRole('alert').length).toBe(1);
  });

  it('FALHA DO PATCH: o que o usuário escreveu volta para a fila e é reenviado', async () => {
    // Um erro que descarta o patch perde o texto sem avisar — o mesmo defeito
    // do save silencioso, só que mais tarde.
    const salvar = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'boleto pago' } });
    await passar(800);
    expect(screen.getByRole('alert').textContent).toMatch(/erro ao salvar/);

    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }));
    await passar();

    expect(salvar).toHaveBeenCalledTimes(2);
    expect(salvar).toHaveBeenLastCalledWith(7, { description: 'boleto pago' });
    expect(screen.getByText('salvo')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"salvo" não sobrevive a uma mudança que ainda está na fila', async () => {
    abrir();
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'primeiro' } });
    await passar(800);
    expect(screen.getByText('salvo')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'segundo' } });
    // dizer "salvo" com texto não enviado na fila é afirmar o que não é
    expect(screen.queryByText('salvo')).toBeNull();
  });

  it('não deixa dois PATCH em voo: o mais velho não pode chegar por último', async () => {
    const soltar: Array<() => void> = [];
    const salvar = vi.fn(() => new Promise<void>((res) => { soltar.push(() => res()); }));
    abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'primeiro' } });
    await passar(800);
    expect(salvar).toHaveBeenCalledTimes(1); // em voo, travado

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'segundo' } });
    await passar(800);
    expect(salvar).toHaveBeenCalledTimes(1); // o segundo espera a vez

    await act(async () => { soltar[0](); });
    await passar();
    expect(salvar).toHaveBeenCalledTimes(2);
    expect(salvar).toHaveBeenLastCalledWith(7, { description: 'segundo' });
  });

  it('o indicador fica FORA da área rolável do sheet', async () => {
    // O rodapé do MobileSheet não rola; pôr o status dentro do `children` faria
    // o erro sumir justo quando o formulário está comprido.
    const { container } = abrir();
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'x' } });
    await passar(800);
    const rolavel = container.querySelector('.ms-sheet__corpo')!;
    expect(rolavel.contains(screen.getByText('salvo'))).toBe(false);
    expect(container.querySelector('.ms-sheet__rodape')!.contains(screen.getByText('salvo'))).toBe(true);
  });

  it('desmontar não dispara o PATCH agendado', async () => {
    const { salvar, unmount } = abrir();
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'meio digitado' } });
    unmount();
    await passar(2000);
    expect(salvar).not.toHaveBeenCalled();
  });
});

describe('ModalTarefa — fechar com save em voo', () => {
  it('descarrega o debounce pendente antes de fechar', async () => {
    const { salvar, onFechar } = abrir();
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'quase salvo' } });
    await passar(200); // ainda dentro dos 800ms
    fireEvent.click(screen.getByLabelText('Fechar tarefa'));
    await passar();

    expect(salvar).toHaveBeenCalledWith(7, { description: 'quase salvo' });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('espera o save em voo terminar antes de fechar', async () => {
    let liberar: (() => void) | null = null;
    const salvar = vi.fn(() => new Promise<void>((res) => { liberar = () => res(); }));
    const { onFechar } = abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'em voo' } });
    await passar(800);
    fireEvent.click(screen.getByLabelText('Fechar tarefa'));
    await passar();
    expect(onFechar).not.toHaveBeenCalled(); // o save ainda não voltou

    await act(async () => { liberar!(); });
    await passar();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('se o save do fechamento falhar, o sheet NÃO fecha calado', async () => {
    const salvar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { onFechar } = abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'não pode sumir' } });
    await passar(200);
    fireEvent.click(screen.getByLabelText('Fechar tarefa'));
    await passar();

    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/erro ao salvar/);
    // o texto continua no campo, não foi descartado
    expect((screen.getByLabelText('Descrição') as HTMLTextAreaElement).value).toBe('não pode sumir');
  });

  it('avisado uma vez, o segundo toque em fechar sai (backend fora do ar não prende ninguém)', async () => {
    const salvar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { onFechar } = abrir({ salvar });

    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'x' } });
    await passar(200);
    fireEvent.click(screen.getByLabelText('Fechar tarefa'));
    await passar();
    expect(onFechar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Fechar tarefa'));
    await passar();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('o backdrop do sheet passa pelo mesmo caminho do X', async () => {
    const { container, salvar, onFechar } = abrir();
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'pelo backdrop' } });
    await passar(200);
    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    await passar();

    expect(salvar).toHaveBeenCalledWith(7, { description: 'pelo backdrop' });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });
});

describe('ModalTarefa — tags', () => {
  it('Enter e vírgula adicionam; Backspace no campo vazio remove a última', async () => {
    const { salvar } = abrir();
    const campo = screen.getByPlaceholderText('adicionar tag...');

    fireEvent.change(campo, { target: { value: 'urgente' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await passar(800);
    expect(salvar).toHaveBeenLastCalledWith(7, { tags: ['casa', 'urgente'] });

    fireEvent.change(campo, { target: { value: 'aluguel' } });
    fireEvent.keyDown(campo, { key: ',' });
    await passar(800);
    expect(salvar).toHaveBeenLastCalledWith(7, { tags: ['casa', 'urgente', 'aluguel'] });

    fireEvent.keyDown(campo, { key: 'Backspace' });
    await passar(800);
    expect(salvar).toHaveBeenLastCalledWith(7, { tags: ['casa', 'urgente'] });
  });

  it('o X do chip remove a tag', async () => {
    const { salvar } = abrir();
    fireEvent.click(screen.getByLabelText('Remover tag casa'));
    await passar(800);
    expect(salvar).toHaveBeenLastCalledWith(7, { tags: [] });
    expect(screen.queryByText('casa')).toBeNull();
  });
});

describe('ModalTarefa — lixeira', () => {
  it('não exclui no primeiro toque: confirma com Sim/Não', async () => {
    const { excluir, onFechar } = abrir();
    fireEvent.click(screen.getByLabelText('Excluir tarefa'));
    expect(excluir).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sim' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Não' }));
    expect(excluir).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sim' })).toBeNull();
    expect(onFechar).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Excluir tarefa'));
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }));
    await passar();
    expect(excluir).toHaveBeenCalledWith(7);
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('exclusão que falha também aparece, e não fecha', async () => {
    const excluir = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { onFechar } = abrir({ excluir });
    fireEvent.click(screen.getByLabelText('Excluir tarefa'));
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }));
    await passar();

    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/erro ao excluir/);
    expect(screen.getAllByRole('alert').length).toBe(1);
  });
});

describe('ModalTarefa — moldura e alvo de toque', () => {
  it('é um diálogo com nome próprio e reusa o MobileSheet', () => {
    const { container } = abrir();
    expect(screen.getByRole('dialog', { name: 'Editar tarefa' })).toBeTruthy();
    expect(container.querySelector('.ms-sheet__painel')).toBeTruthy();
    // o modal não põe margem própria: o painel do sheet já tem o padding
    expect(declarado(container.querySelector('.ms-mtarefa-cabecalho')!, 'margin-left')).toBe('');
  });

  it('fechado não deixa nada no DOM', () => {
    render(<ModalTarefa aberto={false} tarefa={tarefaCheia()} onFechar={vi.fn()} salvar={vi.fn()} excluir={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Título da tarefa')).toBeNull();
  });

  it('lixeira e fechar têm alvo de 44pt que não se sobrepõem', () => {
    const { container } = abrir();
    for (const botao of [screen.getByLabelText('Excluir tarefa'), screen.getByLabelText('Fechar tarefa')]) {
      expect(declarado(botao, 'position', true)).toBe('absolute');
      expect(`${px(botao, 'width', true)}x${px(botao, 'height', true)}`).toBe('44x44');
      expect(px(botao, 'width')).toBe(30); // o desenho do handoff continua 30×30
    }
    // Dois alvos de 44 lado a lado só cabem sem se roubarem se o vão entre eles
    // fechar a conta: 30 (desenho) + vão ≥ 44.
    expect(30 + px(container.querySelector('.ms-mtarefa-acoes')!, 'gap')).toBeGreaterThanOrEqual(44);
  });
});
