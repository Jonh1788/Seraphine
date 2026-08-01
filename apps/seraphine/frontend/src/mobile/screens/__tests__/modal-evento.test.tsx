import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CALENDARIOS, ModalEvento, REPETICOES, criarEventoViaApi } from '../ModalEvento';
import {
  CALENDARIO_DO_EVENTO,
  ErroCriarEvento,
  OUTRAS_CATEGORIAS,
  REPETICOES_ACEITAS,
} from '../../../calendar/api';

// O QUE ESTE ARQUIVO PRENDE
//
// O modal de evento é CRIAÇÃO: não há id, logo não há autosave — tem Cancelar e
// Salvar. Isso desloca o defeito mais caro em relação ao irmão (`ModalTarefa`):
// lá era o PATCH que falha calado; aqui é o SALVAR QUE FALHA E LEVA JUNTO o que
// o usuário digitou. Um formulário de criação que se esvazia (ou se fecha) num
// erro obriga a redigitar tudo, e a pessoa nem sempre lembra o que escreveu.
// Por isso três eixos têm peso igual: o caminho feliz, a falha do salvar com o
// digitado INTACTO, e o "dia inteiro" que apaga os horários sem perdê-los.
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: jsdom não faz layout, então os
// testes de aparência não medem pixel; afirmam a CASCATA (existe regra no CSS
// que casa com aquele elemento e lhe declara o valor do handoff) — mesma
// técnica de `modal-tarefa.test.tsx` e de `mobile/__tests__/sheet.test.tsx`.

const CSS_PATH = resolve(__dirname, '..', 'ModalEvento.css');

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

/** 2026-06-19 é uma sexta — é o "sex, 09:00" que o handoff desenha. */
const SEXTA = '2026-06-19';

function abrir(over: { criar?: Mock; dia?: string } = {}) {
  const criar = over.criar ?? vi.fn().mockResolvedValue(undefined);
  const onFechar = vi.fn();
  const onCriado = vi.fn();
  const utils = render(
    <ModalEvento
      aberto
      dia={over.dia ?? SEXTA}
      onFechar={onFechar}
      criar={criar}
      onCriado={onCriado}
    />,
  );
  return { ...utils, criar, onFechar, onCriado };
}

/** Deixa os `await` do salvamento assentarem. */
async function assentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function digitar(rotulo: string, valor: string): void {
  fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });
}

/** Preenche o mínimo que o formulário exige para salvar. */
function preencher(titulo = 'Retro do time'): void {
  digitar('Título do evento', titulo);
}

describe('ModalEvento — o formulário que o handoff desenha', () => {
  it('abre com título vazio, dia inteiro desligado e sex, 09:00 → sex, 10:00', () => {
    const { container } = abrir();

    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value).toBe('');
    expect(screen.getByPlaceholderText('Título do evento')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Dia inteiro' }).getAttribute('aria-checked')).toBe('false');

    expect((screen.getByLabelText('Data de início') as HTMLInputElement).value).toBe(SEXTA);
    expect((screen.getByLabelText('Hora de início') as HTMLInputElement).value).toBe('09:00');
    expect((screen.getByLabelText('Data de fim') as HTMLInputElement).value).toBe(SEXTA);
    expect((screen.getByLabelText('Hora de fim') as HTMLInputElement).value).toBe('10:00');

    // o que o olho lê na pílula é o do handoff, dia da semana incluído
    expect(container.querySelector('.ms-mevento-pill--inicio')!.textContent).toBe('sex, 09:00');
    expect(container.querySelector('.ms-mevento-pill--fim')!.textContent).toBe('sex, 10:00');

    expect((screen.getByLabelText('Local') as HTMLInputElement).value).toBe('');
    expect(screen.getByPlaceholderText('adicionar')).toBeTruthy();
    expect((screen.getByLabelText('Repetir') as HTMLSelectElement).value).toBe('nunca');
    expect(screen.getByRole('option', { name: 'Nunca', selected: true })).toBeTruthy();
  });

  it('a data que a tela de origem passou é a que abre — não "hoje"', () => {
    const { container } = abrir({ dia: '2026-06-20' }); // sábado
    expect((screen.getByLabelText('Data de início') as HTMLInputElement).value).toBe('2026-06-20');
    expect(container.querySelector('.ms-mevento-pill--inicio')!.textContent).toBe('sáb, 09:00');
  });

  it('os calendários são a taxonomia real do CalendarView, nas cores dele', () => {
    abrir();
    const grupo = screen.getByRole('radiogroup', { name: 'Calendário' });
    const opcoes = Array.from(grupo.querySelectorAll('[role="radio"]'));
    expect(opcoes.map((o) => o.getAttribute('data-calendario'))).toEqual([
      'agenda', 'financas', 'tarefas', 'lembretes', 'outros',
    ]);
    const cor = (nome: string) =>
      (screen.getByRole('radio', { name: nome }).querySelector('.ms-mevento-ponto') as HTMLElement).style.backgroundColor;
    expect(cor('Agenda')).toBe('rgb(66, 165, 245)');    // #42a5f5
    expect(cor('Finanças')).toBe('rgb(102, 187, 106)'); // #66bb6a
    expect(cor('Tarefas')).toBe('rgb(154, 147, 255)');  // #9a93ff
    expect(cor('Lembretes')).toBe('rgb(255, 167, 38)'); // #ffa726
    expect(cor('Outros')).toBe('rgb(120, 144, 156)');   // #78909c

    // Agenda vem marcada; escolher outro move a marca, e só uma fica marcada
    expect(screen.getByRole('radio', { name: 'Agenda', checked: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Lembretes' }));
    expect(screen.getByRole('radio', { name: 'Lembretes', checked: true })).toBeTruthy();
    expect(opcoes.filter((o) => o.getAttribute('aria-checked') === 'true').length).toBe(1);
  });

  it('formulário em branco NÃO é erro', () => {
    abrir();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/erro/i)).toBeNull();
  });

  it('nada de emoji no texto renderizado', () => {
    const { container } = abrir();
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('ModalEvento — dia inteiro', () => {
  it('ligado, os horários somem do DOM e o payload perde a hora', async () => {
    const { criar } = abrir();
    preencher();
    fireEvent.click(screen.getByRole('switch', { name: 'Dia inteiro' }));

    expect(screen.getByRole('switch', { name: 'Dia inteiro' }).getAttribute('aria-checked')).toBe('true');
    // ausência afirmada: não é "não verifiquei", é "não está lá"
    expect(screen.queryByLabelText('Hora de início')).toBeNull();
    expect(screen.queryByLabelText('Hora de fim')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();
    expect(criar).toHaveBeenCalledWith(expect.objectContaining({
      diaInteiro: true, inicio: SEXTA, fim: SEXTA,
    }));
  });

  it('desligado de volta, restaura o horário QUE O USUÁRIO pôs, não o padrão', async () => {
    const { criar } = abrir();
    preencher();
    digitar('Hora de início', '11:30');
    digitar('Hora de fim', '13:45');

    fireEvent.click(screen.getByRole('switch', { name: 'Dia inteiro' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Dia inteiro' }));

    expect((screen.getByLabelText('Hora de início') as HTMLInputElement).value).toBe('11:30');
    expect((screen.getByLabelText('Hora de fim') as HTMLInputElement).value).toBe('13:45');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();
    expect(criar).toHaveBeenCalledWith(expect.objectContaining({
      diaInteiro: false, inicio: `${SEXTA}T11:30`, fim: `${SEXTA}T13:45`,
    }));
  });
});

describe('ModalEvento — salvar', () => {
  it('sucesso: manda o evento inteiro, avisa quem abriu e fecha', async () => {
    const { criar, onCriado, onFechar } = abrir();
    preencher('Retro do time');
    digitar('Hora de início', '14:00');
    digitar('Hora de fim', '15:00');
    digitar('Local', 'Sala 3');
    fireEvent.change(screen.getByLabelText('Repetir'), { target: { value: 'semanal' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Tarefas' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(criar).toHaveBeenCalledTimes(1);
    expect(criar).toHaveBeenCalledWith({
      titulo: 'Retro do time',
      diaInteiro: false,
      inicio: `${SEXTA}T14:00`,
      fim: `${SEXTA}T15:00`,
      local: 'Sala 3',
      repetir: 'semanal',
      calendario: 'tarefas',
    });
    expect(onCriado).toHaveBeenCalledTimes(1);
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('dois toques em Salvar, no MESMO lote de render, criam UM evento', async () => {
    // Os dois cliques saem dentro de UM `act`: assim o React ainda não repintou
    // o botão como `disabled` quando o segundo chega — que é o toque duplo de
    // verdade, o dedo mais rápido que o repintar. Se o teste desse os cliques
    // soltos, o `disabled` sozinho já seguraria o segundo e a guarda de
    // reentrada poderia sumir do código sem ninguém notar (foi o que aconteceu:
    // ver a mutação registrada no relatório).
    let liberar: (() => void) | null = null;
    const criar = vi.fn(() => new Promise<void>((res) => { liberar = () => res(); }));
    const { onFechar } = abrir({ criar });
    preencher();

    const botao = screen.getByRole('button', { name: 'Salvar' });
    await act(async () => {
      fireEvent.click(botao);
      fireEvent.click(botao);
    });
    await assentar();

    expect(criar).toHaveBeenCalledTimes(1);
    expect(screen.getByText('salvando…')).toBeTruthy();
    expect(onFechar).not.toHaveBeenCalled();

    await act(async () => { liberar!(); });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('FALHA: grita como alert, NÃO fecha e o que foi digitado continua ali', async () => {
    const criar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { onFechar, onCriado } = abrir({ criar });
    preencher('Jantar com a Ana');
    digitar('Local', 'Rua das Flores, 12');
    fireEvent.click(screen.getByRole('radio', { name: 'Lembretes' }));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/Falha HTTP 500/);
    expect(screen.getAllByRole('alert').length).toBe(1); // uma região de alerta, só
    expect(onFechar).not.toHaveBeenCalled();
    expect(onCriado).not.toHaveBeenCalled();
    // nada do que a pessoa escreveu pode ter sumido junto com o erro
    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value).toBe('Jantar com a Ana');
    expect((screen.getByLabelText('Local') as HTMLInputElement).value).toBe('Rua das Flores, 12');
    expect(screen.getByRole('radio', { name: 'Lembretes', checked: true })).toBeTruthy();
  });

  it('FALHA: "tentar de novo" reenvia o MESMO evento e, dando certo, fecha', async () => {
    const criar = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const { onFechar } = abrir({ criar });
    preencher('Jantar com a Ana');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }));
    await assentar();

    expect(criar).toHaveBeenCalledTimes(2);
    expect(criar).toHaveBeenLastCalledWith(expect.objectContaining({ titulo: 'Jantar com a Ana' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('sem título não cria nada, e diz por quê', async () => {
    const { criar, onFechar } = abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(criar).not.toHaveBeenCalled();
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/título/i);
  });

  it('fim antes do início não cria nada, e diz por quê', async () => {
    const { criar } = abrir();
    preencher();
    digitar('Hora de fim', '08:00'); // início continua 09:00
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(criar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/fim/i);

    // e some assim que o dado passa a se sustentar
    digitar('Hora de fim', '10:00');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();
    expect(criar).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('horário apagado com dia inteiro DESLIGADO não vira meia-noite calada', async () => {
    const { criar } = abrir();
    preencher();
    digitar('Hora de início', '');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(criar).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/horário/i);
  });

  it('o aviso fica FORA da área rolável do sheet', async () => {
    const criar = vi.fn().mockRejectedValue(new Error('Falha HTTP 500'));
    const { container } = abrir({ criar });
    preencher();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    const alerta = screen.getByRole('alert');
    expect(container.querySelector('.ms-sheet__corpo')!.contains(alerta)).toBe(false);
    expect(container.querySelector('.ms-sheet__rodape')!.contains(alerta)).toBe(true);
  });
});

describe('ModalEvento — cancelar', () => {
  it('formulário intocado fecha no primeiro toque', () => {
    const { criar, onFechar } = abrir();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
    expect(criar).not.toHaveBeenCalled();
  });

  it('com coisa digitada, cancelar CONFIRMA antes de jogar fora', () => {
    const { criar, onFechar } = abrir();
    preencher('Retro do time');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByText('Descartar evento?')).toBeTruthy();

    // "Continuar" volta ao formulário com tudo no lugar
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));
    expect(onFechar).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value).toBe('Retro do time');
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy();

    // "Descartar" sai, sem criar nada
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(onFechar).toHaveBeenCalledTimes(1);
    expect(criar).not.toHaveBeenCalled();
  });

  it('o backdrop e o Escape passam pelo MESMO caminho do Cancelar', () => {
    const { container, onFechar } = abrir();
    preencher('Retro do time');

    fireEvent.click(container.querySelector('.ms-sheet__backdrop')!);
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByText('Descartar evento?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onFechar).not.toHaveBeenCalled();
    expect(screen.getByText('Descartar evento?')).toBeTruthy();
  });
});

describe('ModalEvento — moldura e alvo de toque', () => {
  it('é um diálogo com nome próprio e reusa o MobileSheet', () => {
    const { container } = abrir();
    expect(screen.getByRole('dialog', { name: 'Novo evento' })).toBeTruthy();
    expect(container.querySelector('.ms-sheet__painel')).toBeTruthy();
    // o modal não põe margem própria: o painel do sheet já tem o padding lateral
    expect(declarado(container.querySelector('.ms-mevento-cabecalho')!, 'margin-left')).toBe('');
    expect(declarado(container.querySelector('.ms-mevento-cabecalho')!, 'margin-right')).toBe('');
  });

  it('reaberto, o formulário RECOMEÇA — o evento anterior não vaza para o próximo', () => {
    const criar = vi.fn().mockResolvedValue(undefined);
    const onFechar = vi.fn();
    const props = { onFechar, criar };
    const { rerender } = render(<ModalEvento aberto dia={SEXTA} {...props} />);

    digitar('Título do evento', 'Retro do time');
    digitar('Local', 'Sala 3');
    fireEvent.click(screen.getByRole('switch', { name: 'Dia inteiro' }));

    // quem abre o modal costuma mantê-lo montado entre uma abertura e outra
    rerender(<ModalEvento aberto={false} dia={SEXTA} {...props} />);
    rerender(<ModalEvento aberto dia="2026-06-20" {...props} />);

    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Local') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('switch', { name: 'Dia inteiro' }).getAttribute('aria-checked')).toBe('false');
    expect((screen.getByLabelText('Hora de início') as HTMLInputElement).value).toBe('09:00');
    // e abre no dia que a tela de origem está mostrando AGORA, não no de antes
    expect((screen.getByLabelText('Data de início') as HTMLInputElement).value).toBe('2026-06-20');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fechado não deixa nada no DOM', () => {
    render(<ModalEvento aberto={false} dia={SEXTA} onFechar={vi.fn()} criar={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByLabelText('Título do evento')).toBeNull();
  });

  it('Cancelar, Salvar, o toggle e os chips têm 44pt de alvo', () => {
    const { container } = abrir();
    for (const nome of ['Cancelar', 'Salvar']) {
      const botao = screen.getByRole('button', { name: nome });
      expect(declarado(botao, 'position', true)).toBe('absolute');
      expect(px(botao, 'height', true)).toBe(44);
      expect(px(botao, 'min-width', true)).toBeGreaterThanOrEqual(44);
    }
    const toggle = screen.getByRole('switch', { name: 'Dia inteiro' });
    expect(px(toggle, 'height')).toBe(26); // o desenho do handoff continua 44×26
    expect(px(toggle, 'width')).toBe(44);
    expect(px(toggle, 'height', true)).toBe(44);

    const chip = screen.getByRole('radio', { name: 'Agenda' });
    expect(px(chip, 'height', true)).toBe(44);
    // Dois chips empilhados só cabem sem se roubarem se a altura do desenho mais
    // o vão entre linhas fecharem 44.
    const chips = container.querySelector('.ms-mevento-chips')!;
    expect(px(chip, 'min-height') + px(chips, 'row-gap')).toBeGreaterThanOrEqual(44);
  });

  it('os campos nativos cobrem a linha inteira, com 44 nos dois eixos', () => {
    const { container } = abrir();
    for (const rotulo of ['Data de início', 'Hora de início', 'Data de fim', 'Hora de fim']) {
      const campo = screen.getByLabelText(rotulo).closest('.ms-mevento-campo')!;
      expect(px(campo, 'min-width')).toBeGreaterThanOrEqual(44);
      expect(px(screen.getByLabelText(rotulo), 'height')).toBe(44);
    }
    for (const rotulo of ['Repetir']) {
      expect(px(screen.getByLabelText(rotulo), 'height')).toBe(44);
    }
    // o input de local ocupa a linha toda de 48; não precisa de pseudo
    expect(px(container.querySelector('.ms-mevento-local')!, 'min-height')).toBeGreaterThanOrEqual(44);
  });
});

describe('ModalEvento — a falha diz o que aconteceu', () => {
  // O rodapé mostrava "erro ao salvar" para tudo. O caso que mais importa
  // depois do sucesso é o Google desconectado, e "erro ao salvar" não diz a
  // ninguém que basta reconectar. A tela não INTERPRETA o erro — ela mostra o
  // que a camada disse, que é onde mora o conhecimento do domínio.

  it('mostra a MENSAGEM do erro, não um rótulo genérico', async () => {
    const criar = vi.fn().mockRejectedValue(
      new ErroCriarEvento('Google não está conectado — conecte em /google/oauth/start', {
        retentavel: true,
        status: 401,
      }),
    );
    const { onFechar } = abrir({ criar });
    preencher('Jantar com a Ana');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/Google não está conectado/);
    expect(screen.getByRole('alert').textContent).toMatch(/oauth\/start/);
    expect(onFechar).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value)
      .toBe('Jantar com a Ana');
    // dá para reconectar em outro lugar e reenviar o mesmo evento
    expect(screen.getByRole('button', { name: 'tentar de novo' })).toBeTruthy();
  });

  it('a falha que NÃO adianta repetir não oferece "tentar de novo"', async () => {
    // Uma recusa da camada (categoria que a leitura não reconstrói, título
    // vazio) devolve exatamente a mesma coisa a cada toque. Um botão que
    // promete outro resultado é uma promessa falsa.
    const criar = vi.fn().mockRejectedValue(
      new ErroCriarEvento('um evento do Google sempre volta como Agenda.', {
        retentavel: false,
      }),
    );
    abrir({ criar });
    preencher('Jantar com a Ana');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/sempre volta como Agenda/);
    expect(screen.queryByRole('button', { name: 'tentar de novo' })).toBeNull();
    // e o que foi digitado continua ali para a pessoa corrigir a escolha
    expect((screen.getByLabelText('Título do evento') as HTMLInputElement).value)
      .toBe('Jantar com a Ana');
  });

  it('erro sem mensagem nenhuma ainda diz que falhou', async () => {
    const criar = vi.fn().mockRejectedValue(new Error(''));
    abrir({ criar });
    preencher();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/erro ao salvar/);
  });
});

describe('ModalEvento — o que o modal oferece e o que a camada aceita', () => {
  // A lição do `FactCreate.source`: os dois lados divergirem é o que traz o
  // bug de volta. O que segura é a igualdade dos CONJUNTOS, não uma lista de
  // valores conhecidos.

  it('toda repetição do seletor é uma repetição que a camada aceita', () => {
    expect(new Set(REPETICOES.map((o) => o.valor))).toEqual(new Set(REPETICOES_ACEITAS));
  });

  it('todo chip de calendário ou é o aceito, ou tem explicação de onde vem', () => {
    // Um chip novo sem explicação cairia num texto genérico ("de outra fonte
    // do calendário") — barrado, mas sem ensinar nada.
    expect(new Set(CALENDARIOS.map((c) => c.valor))).toEqual(
      new Set([CALENDARIO_DO_EVENTO, ...Object.keys(OUTRAS_CATEGORIAS)]),
    );
  });
});

describe('ModalEvento — o adaptador padrão', () => {
  it('fala com a camada do domínio: POST /google/calendar/events', async () => {
    const spy = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 201,
      statusText: 'Created',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true, id: 'evt-1', html_link: null, all_day: false, recurrence: [] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', spy);

    await criarEventoViaApi({
      titulo: 'Retro do time', diaInteiro: false,
      inicio: `${SEXTA}T09:00`, fim: `${SEXTA}T10:00`,
      local: '', repetir: 'nunca', calendario: 'agenda',
    });

    expect(String(spy.mock.calls[0][0])).toContain('/google/calendar/events');
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
    vi.unstubAllGlobals();
  });

  it('a recusa da camada chega ao modal com a mensagem inteira', async () => {
    // O chip "Lembretes" existe no desenho, mas um evento do Google nunca
    // volta como lembrete. Quem sabe disso é a camada; a tela só mostra.
    await expect(criarEventoViaApi({
      titulo: 'x', diaInteiro: false, inicio: `${SEXTA}T09:00`, fim: `${SEXTA}T10:00`,
      local: '', repetir: 'nunca', calendario: 'lembretes',
    })).rejects.toThrow(/Agenda/);
  });
});
