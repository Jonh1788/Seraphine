import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../planning/api', () => ({
  fetchPlan: vi.fn(),
  acceptPlan: vi.fn(),
  updateBlock: vi.fn(),
}));
import { fetchPlan, acceptPlan, updateBlock } from '../../../planning/api';
import type { DailyPlan } from '../../../planning/types';
import { PlanejamentoScreen } from '../PlanejamentoScreen';

/* O QUE ESTE ARQUIVO PRENDE
 *
 * 1. NADA DO MOCKUP QUE A API NÃO SUSTENTA. O frame escreve "90 min · seu
 *    melhor horário" no bloco de foco e "1h · Google Meet" na reunião. Nem
 *    "seu melhor horário" nem "Google Meet" existem em `TimeBlock` — o que
 *    existe é `reason`, escrito pelo backend (`_focus_reason_for_energy`) ou
 *    reescrito pelo LLM. A duração é real (fim menos início). Os testes exigem
 *    a razão da api e proíbem a frase do mockup.
 *
 * 2. O BRILHO SÓ APARECE QUANDO HOUVE LLM. `context.ai_generated` é o único
 *    campo que diz se um modelo escreveu alguma coisa; o desktop já trata o
 *    sparkle como marca de autoria. Sem ele, o bloco continua sendo "FOCO
 *    SUGERIDO" (o backend sugere mesmo, por heurística), mas sem a marca.
 *
 * 3. ENCAIXAR NÃO PODE RECARREGAR. `GET /planning/today` chama
 *    `generate_plan()`, que REGENERA e sobrescreve a linha do dia
 *    (`INSERT ... ON CONFLICT DO UPDATE SET plan_json = excluded.plan_json`).
 *    Recarregar depois de um PATCH joga o PATCH fora. O teste conta as
 *    chamadas de `fetchPlan` depois do encaixe.
 *
 * 4. A GUARDA DE REENTRADA NÃO É O ATRIBUTO `disabled`. Dois toques no mesmo
 *    quadro chegam aos dois antes de qualquer re-render: o `disabled` que o
 *    React ainda não pintou não impede o segundo. Por isso os testes de
 *    reentrada despacham os dois cliques DENTRO do mesmo `act`, o que só passa
 *    se existir uma guarda síncrona (ref), e não o atributo.
 */

const CSS_PATH = resolve(__dirname, '..', 'PlanejamentoScreen.css');
const lerCss = (): string => readFileSync(CSS_PATH, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Bloco de declarações da PRIMEIRA regra cujo seletor termina em `sel`. */
function blocoDe(sel: string): string {
  const css = lerCss();
  const i = css.indexOf(`${sel} {`);
  if (i === -1) return '';
  const abre = css.indexOf('{', i);
  const fecha = css.indexOf('}', abre);
  return abre === -1 || fecha === -1 ? '' : css.slice(abre, fecha);
}

/* ── fixtures: o formato que `GET /planning/today` devolve de verdade ──
   Os títulos "Focus", "Pausa", "Tempo livre" e "Exercicio" são os que o
   `PlanningService` escreve; a `reason` do foco é a que ele monta quando há
   prioridades pendentes. */

const PLANO: DailyPlan = {
  time_blocks: [
    { id: 'm1', start: '09:00', end: '10:00', type: 'meeting', title: 'Call com o time' },
    { id: 'f1', start: '10:30', end: '12:00', type: 'focus', title: 'Focus', reason: '3 tarefa(s) prioritaria(s)' },
    { id: 'l1', start: '12:30', end: '13:30', type: 'free', title: 'Tempo livre' },
    { id: 'e1', start: '14:30', end: '15:15', type: 'exercise', title: 'Exercicio', reason: 'Streak em risco -- manter consistencia' },
    { id: 'f2', start: '15:30', end: '17:30', type: 'focus', title: 'Focus', reason: 'Energia alta -- bom momento para trabalho profundo' },
  ],
  priorities: [
    { id: 't1', title: 'Revisar PR', priority: 'high' },
    { id: 't2', title: 'Pagar aluguel' },
    { id: 't3', title: 'Curso de Rust' },
  ],
  at_risk: { habits: [], goals: [] },
  context: {
    sleep_hours: 7.5,
    energy_estimate: 'high',
    meetings_count: 1,
    free_slots_min: 600,
    mood_valence: null,
    mood_reason: null,
  },
};

const VAZIO: DailyPlan = {
  time_blocks: [],
  priorities: [],
  at_risk: { habits: [], goals: [] },
  context: {
    sleep_hours: null,
    energy_estimate: 'medium',
    meetings_count: 0,
    free_slots_min: 0,
    mood_valence: null,
    mood_reason: null,
  },
};

function comPlano(p: DailyPlan = PLANO): void {
  vi.mocked(fetchPlan).mockResolvedValue(p);
}

function linha(id: string): HTMLElement {
  return screen.getByTestId(`ms-plan-linha-${id}`);
}

async function assentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

/** Dois cliques no MESMO quadro: nenhum re-render entre eles, então o
 *  `disabled` que o React ainda não pintou não protege nada. */
async function toqueDuplo(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.mocked(fetchPlan).mockReset();
  vi.mocked(acceptPlan).mockReset();
  vi.mocked(updateBlock).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlanejamentoScreen — dado, vazio e erro', () => {
  it('desenha a linha do tempo com a hora, o título e a duração reais de cada bloco', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByText('Seu dia')).toBeTruthy();

    const reuniao = linha('m1');
    expect(within(reuniao).getByText('09:00')).toBeTruthy();
    expect(within(reuniao).getByText('Call com o time')).toBeTruthy();
    expect(within(reuniao).getByText(/^1h$/)).toBeTruthy();

    const livre = linha('l1');
    expect(within(livre).getByText('12:30')).toBeTruthy();
    expect(within(livre).getByText('Tempo livre')).toBeTruthy();

    const exercicio = linha('e1');
    expect(within(exercicio).getByText('Exercicio')).toBeTruthy();
    expect(within(exercicio).getByText(/45 min/)).toBeTruthy();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sem nenhum bloco, diz que não há plano e NÃO diz que houve erro', async () => {
    comPlano(VAZIO);
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByText(/nenhum bloco no plano de hoje/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // sem bloco não há o que aceitar: o CTA não pode fingir que há
    expect(screen.queryByRole('button', { name: 'Aceitar plano' })).toBeNull();
    // e a saída do estado vazio continua de pé
    expect(screen.getByRole('button', { name: 'Refazer' })).toBeTruthy();
  });

  it('quando o plano falha, avisa em alerta e não vira tela vazia', async () => {
    vi.mocked(fetchPlan).mockRejectedValue(new Error('rede'));
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByRole('alert').textContent).toMatch(/não consegui carregar/i);
    expect(screen.queryByText(/nenhum bloco no plano de hoje/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aceitar plano' })).toBeNull();
  });

  it('enquanto carrega mostra esqueleto sem texto e não afirma nada', async () => {
    vi.mocked(fetchPlan).mockReturnValue(new Promise<DailyPlan>(() => {}));
    const { container } = render(<PlanejamentoScreen />);
    await assentar();

    const esqueletos = container.querySelectorAll('.ms-plan-skel');
    expect(esqueletos.length).toBeGreaterThan(0);
    for (const s of esqueletos) {
      expect(s.getAttribute('aria-hidden')).toBe('true');
      expect(s.textContent).toBe('');
    }
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/nenhum bloco no plano de hoje/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aceitar plano' })).toBeNull();
    expect(screen.queryByText(/A ENCAIXAR/i)).toBeNull();
  });

  it('o ‹ chama quem empurrou a tela', async () => {
    comPlano();
    const onBack = vi.fn();
    render(<PlanejamentoScreen onBack={onBack} />);
    await assentar();

    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('Refazer pede um plano novo', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();
    expect(fetchPlan).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }));
    await assentar();
    expect(fetchPlan).toHaveBeenCalledTimes(2);
  });
});

describe('PlanejamentoScreen — o bloco de foco sugerido', () => {
  it('usa a razão que a api mandou, não a frase do mockup', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();

    const foco = linha('f1');
    expect(within(foco).getByText('FOCO SUGERIDO')).toBeTruthy();
    expect(within(foco).getByText(/3 tarefa\(s\) prioritaria\(s\)/)).toBeTruthy();
    // 10:30 → 12:00 = 90 min, como o frame escreve. O número sai do dado.
    expect(within(foco).getByText(/90 min/)).toBeTruthy();

    // a frase do mockup não existe em `TimeBlock`: não pode ser renderizada
    expect(screen.queryByText(/seu melhor horário/i)).toBeNull();
    expect(screen.queryByText(/google meet/i)).toBeNull();

    // e a outra razão, diferente, também sai do dado
    expect(within(linha('f2')).getByText(/Energia alta/)).toBeTruthy();
  });

  it('um bloco de foco sem razão mostra só a duração — não inventa uma', async () => {
    comPlano({
      ...PLANO,
      time_blocks: [{ id: 'f1', start: '10:30', end: '12:00', type: 'focus', title: 'Focus', reason: null }],
    });
    render(<PlanejamentoScreen />);
    await assentar();

    const foco = linha('f1');
    expect(within(foco).getByText('90 min')).toBeTruthy();
    expect(within(foco).queryByText(/·/)).toBeNull();
  });

  it('sem `ai_generated` não há marca de autoria da Seraphine', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.queryByTestId('ms-plan-ia-f1')).toBeNull();
    // o cartão de sugestão fala por números derivados, sem assinar como IA
    expect(screen.getByText('Plano do dia')).toBeTruthy();
    expect(screen.queryByText(/sugerido pela seraphine/i)).toBeNull();
    expect(screen.getByText(/2 blocos de foco/)).toBeTruthy();
  });

  it('com `ai_generated` e resumo, mostra a marca e o texto do modelo', async () => {
    comPlano({
      ...PLANO,
      context: { ...PLANO.context, ai_generated: true, summary: 'Deixei a manhã livre pro Q3. Aplico?' },
    });
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByTestId('ms-plan-ia-f1')).toBeTruthy();
    expect(screen.getByText('Sugerido pela Seraphine')).toBeTruthy();
    expect(screen.getByText('Deixei a manhã livre pro Q3. Aplico?')).toBeTruthy();
    // o texto derivado não pode aparecer junto com o do modelo
    expect(screen.queryByText(/2 blocos de foco/)).toBeNull();
  });

  it('`ai_generated` sem resumo não inventa texto de modelo', async () => {
    comPlano({
      ...PLANO,
      context: { ...PLANO.context, ai_generated: true, summary: null },
    });
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByText('Plano do dia')).toBeTruthy();
    expect(screen.getByText(/2 blocos de foco/)).toBeTruthy();
  });
});

describe('PlanejamentoScreen — a encaixar', () => {
  it('conta as prioridades pendentes e lista uma ficha para cada', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByText('A ENCAIXAR · 3')).toBeTruthy();
    expect(screen.getByTestId('ms-plan-chip-t1').textContent).toMatch(/Revisar PR/);
    expect(screen.getByTestId('ms-plan-chip-t2').textContent).toMatch(/Pagar aluguel/);
    expect(screen.getByTestId('ms-plan-chip-t3').textContent).toMatch(/Curso de Rust/);
  });

  it('sem prioridade nenhuma, afirma que não há o que encaixar', async () => {
    comPlano({ ...PLANO, priorities: [] });
    render(<PlanejamentoScreen />);
    await assentar();

    expect(screen.getByText(/nada pendente para encaixar/i)).toBeTruthy();
    expect(screen.getByText('A ENCAIXAR · 0')).toBeTruthy();
    expect(screen.queryByTestId('ms-plan-chip-t1')).toBeNull();
  });

  it('tocar numa ficha oferece SÓ os blocos de foco como horário', async () => {
    comPlano();
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByTestId('ms-plan-chip-t1'));

    expect(screen.getByTestId('ms-plan-slot-f1')).toBeTruthy();
    expect(screen.getByTestId('ms-plan-slot-f2')).toBeTruthy();
    // reunião, exercício e tempo livre não são vagas: a api não move tarefa
    // para dentro deles sem mentir sobre o que são
    expect(screen.queryByTestId('ms-plan-slot-m1')).toBeNull();
    expect(screen.queryByTestId('ms-plan-slot-e1')).toBeNull();
    expect(screen.queryByTestId('ms-plan-slot-l1')).toBeNull();
  });

  it('escolher o horário salva pelo PATCH e NÃO recarrega (recarregar regenera o plano)', async () => {
    comPlano();
    vi.mocked(updateBlock).mockResolvedValue({ ok: true });
    render(<PlanejamentoScreen />);
    await assentar();
    expect(fetchPlan).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('ms-plan-chip-t1'));
    fireEvent.click(screen.getByTestId('ms-plan-slot-f1'));
    await assentar();

    expect(updateBlock).toHaveBeenCalledTimes(1);
    expect(updateBlock).toHaveBeenCalledWith('f1', { title: 'Revisar PR' });
    // `GET /planning/today` REGENERA o plano e sobrescreve o que o PATCH salvou
    expect(fetchPlan).toHaveBeenCalledTimes(1);

    // o bloco passa a mostrar a tarefa, e a conta cai
    expect(within(linha('f1')).getByText('Revisar PR')).toBeTruthy();
    expect(screen.getByText('A ENCAIXAR · 2')).toBeTruthy();
    // a ficha encaixada mostra onde foi parar e não abre o seletor de novo
    expect(screen.getByTestId('ms-plan-chip-t1').textContent).toMatch(/10:30/);
    expect((screen.getByTestId('ms-plan-chip-t1') as HTMLButtonElement).disabled).toBe(true);
    // e o horário ocupado sai da lista de vagas
    fireEvent.click(screen.getByTestId('ms-plan-chip-t2'));
    expect(screen.queryByTestId('ms-plan-slot-f1')).toBeNull();
    expect(screen.getByTestId('ms-plan-slot-f2')).toBeTruthy();
  });

  it('dois toques em vagas diferentes no mesmo quadro salvam UMA vez', async () => {
    comPlano();
    vi.mocked(updateBlock).mockReturnValue(new Promise(() => {}));
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByTestId('ms-plan-chip-t1'));
    const f1 = screen.getByTestId('ms-plan-slot-f1');
    const f2 = screen.getByTestId('ms-plan-slot-f2');
    await act(async () => {
      f1.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      f2.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(updateBlock).toHaveBeenCalledTimes(1);
  });

  it('quando o PATCH falha, diz que falhou, não é alerta, e o bloco não muda', async () => {
    comPlano();
    vi.mocked(updateBlock).mockRejectedValue(new Error('rede'));
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByTestId('ms-plan-chip-t1'));
    fireEvent.click(screen.getByTestId('ms-plan-slot-f1'));
    await assentar();

    expect(screen.getByText(/não consegui encaixar/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(linha('f1')).queryByText('Revisar PR')).toBeNull();
    // nada foi encaixado: a conta não pode cair
    expect(screen.getByText('A ENCAIXAR · 3')).toBeTruthy();
    expect((screen.getByTestId('ms-plan-chip-t1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sem bloco de foco no dia, dizer isso é melhor que abrir um seletor vazio', async () => {
    comPlano({
      ...PLANO,
      time_blocks: [{ id: 'm1', start: '09:00', end: '10:00', type: 'meeting', title: 'Call com o time' }],
    });
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByTestId('ms-plan-chip-t1'));

    expect(screen.getByText(/nenhum bloco de foco/i)).toBeTruthy();
    expect(screen.queryByTestId('ms-plan-slot-m1')).toBeNull();
    expect(updateBlock).not.toHaveBeenCalled();
  });
});

describe('PlanejamentoScreen — aceitar plano', () => {
  it('aceita e diz quantos eventos foram para a agenda', async () => {
    comPlano();
    vi.mocked(acceptPlan).mockResolvedValue({ ok: true, calendar_events_created: 2, event_ids: ['a', 'b'] });
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar plano' }));
    await assentar();

    expect(acceptPlan).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/2 eventos na sua agenda/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aceitar plano' })).toBeNull();
    expect((screen.getByRole('button', { name: /plano aceito/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('aceitar sem criar evento nenhum não finge que criou', async () => {
    comPlano();
    vi.mocked(acceptPlan).mockResolvedValue({ ok: true, calendar_events_created: 0, event_ids: [] });
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar plano' }));
    await assentar();

    expect(screen.getByText(/nenhum evento foi criado/i)).toBeTruthy();
    expect(screen.queryByText(/eventos na sua agenda/i)).toBeNull();
  });

  it('dois toques no mesmo quadro fazem UMA chamada — o `disabled` não protege', async () => {
    comPlano();
    vi.mocked(acceptPlan).mockReturnValue(new Promise(() => {}));
    render(<PlanejamentoScreen />);
    await assentar();

    await toqueDuplo(screen.getByRole('button', { name: 'Aceitar plano' }));

    expect(acceptPlan).toHaveBeenCalledTimes(1);
  });

  it('quando aceitar falha, avisa sem virar alerta e deixa tentar de novo', async () => {
    comPlano();
    vi.mocked(acceptPlan).mockRejectedValue(new Error('rede'));
    render(<PlanejamentoScreen />);
    await assentar();

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar plano' }));
    await assentar();

    expect(screen.getByText(/não consegui aceitar/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    const botao = screen.getByRole('button', { name: 'Aceitar plano' }) as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    expect(screen.queryByText(/na sua agenda/i)).toBeNull();
  });
});

describe('PlanejamentoScreen — CSS', () => {
  it('toda classe e todo keyframe levam o prefixo da tela', () => {
    const css = lerCss();
    const meu = (n: string): boolean => n === 'ms-plan' || n.startsWith('ms-plan-');
    for (const [, nome] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      expect(`classe ${nome}`).toBe(`classe ${meu(nome) ? nome : 'ms-plan-' + nome}`);
    }
    for (const [, nome] of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
      expect(`keyframe ${nome}`).toBe(`keyframe ${meu(nome) ? nome : 'ms-plan-' + nome}`);
    }
  });

  it('as medidas e cores saem do frame, não da imaginação', () => {
    expect(blocoDe('.ms-plan-hora')).toMatch(/width:\s*38px/);
    expect(blocoDe('.ms-plan-hora')).toMatch(/tabular-nums/);
    expect(blocoDe('.ms-plan-bloco')).toMatch(/border-left:\s*3px solid/);
    expect(blocoDe('.ms-plan-bloco')).toMatch(/border-radius:\s*11px/);
    expect(blocoDe('.ms-plan-bloco')).toMatch(/padding:\s*11px 13px/);
    expect(blocoDe('.ms-plan-bloco--meeting')).toMatch(/#42a5f5/i);
    expect(blocoDe('.ms-plan-bloco--exercise')).toMatch(/#ab47bc/i);
    expect(blocoDe('.ms-plan-bloco--break')).toMatch(/#26a69a/i);
    // o foco é tracejado accent, não borda esquerda colorida
    expect(blocoDe('.ms-plan-bloco--focus')).toMatch(/dashed/);
    expect(blocoDe('.ms-plan-cta')).toMatch(/border-radius:\s*14px/);
    expect(blocoDe('.ms-plan-chip')).toMatch(/border-radius:\s*12px/);
  });

  it('os controles tocáveis têm 44pt', () => {
    expect(blocoDe('.ms-plan-cta')).toMatch(/min-height:\s*44px/);
    expect(blocoDe('.ms-plan-chip')).toMatch(/min-height:\s*44px/);
    expect(blocoDe('.ms-plan-slot')).toMatch(/min-height:\s*44px/);
    expect(blocoDe('.ms-plan-refazer')).toMatch(/min-height:\s*44px/);
  });
});
