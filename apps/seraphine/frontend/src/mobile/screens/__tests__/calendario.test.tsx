import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../../calendar/api', () => ({
  fetchAggregate: vi.fn(),
  fetchTasksByRange: vi.fn(),
  // O "+" desta tela passou a abrir o `ModalEvento`, que salva por `criarEvento`
  // e reconhece `ErroCriarEvento` para decidir se "tentar de novo" faz sentido.
  // Os dois precisam existir no mock ou o modal quebra no render.
  criarEvento: vi.fn(),
  ErroCriarEvento: class ErroCriarEvento extends Error {},
  apagarEvento: vi.fn(),
}));
import { fetchAggregate, fetchTasksByRange, criarEvento, apagarEvento } from '../../../calendar/api';
import type { AggregateDay, Task } from '../../../calendar/types';
import { CalendarioScreen } from '../CalendarioScreen';

/* O mês exibido é sempre o mês corrente, então o fixture é montado a partir da
   data real: nada de congelar o relógio (fake timers brigam com o waitFor). */
const HOJE = new Date();
const ANO = HOJE.getFullYear();
const MES = HOJE.getMonth();
const DIAS_NO_MES = new Date(ANO, MES + 1, 0).getDate();
const HOJE_DIA = HOJE.getDate();
/** Um dia do mês que garantidamente não é hoje. */
const OUTRO_DIA = HOJE_DIA === 1 ? 2 : 1;

const iso = (dia: number) =>
  `${ANO}-${String(MES + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

/** Dia sem nada — o formato que o backend devolve para um dia em branco. */
function vazio(dia: number): AggregateDay {
  return {
    date: iso(dia),
    tasks: [], habits: [], health: null, water: null,
    mood: null, focus: null, journal: null, events: [], score: 0,
  };
}

const TAREFA: Task = {
  id: 1, type: 'reminder', status: 'pending', title: 'Pagar aluguel',
  description: '', source: 'user', payload: {}, created_at: `${iso(HOJE_DIA)}T08:00:00`,
  due_date: iso(HOJE_DIA), due_time: '09:00',
};

/** Mês com dado: hoje tem evento + tarefa, OUTRO_DIA só tem diário. */
function mesComDado(): AggregateDay[] {
  const dias = Array.from({ length: DIAS_NO_MES }, (_, i) => vazio(i + 1));
  dias[HOJE_DIA - 1] = {
    ...vazio(HOJE_DIA),
    events: [{
      // O id vem do agregado (`calendar_agg` o copia do item cru do Google) e é
      // o que a linha usa para saber QUAL evento apagar.
      id: 'evt-call',
      title: 'Call com o time',
      start: `${iso(HOJE_DIA)}T09:00:00`,
      end: `${iso(HOJE_DIA)}T10:00:00`,
    }],
    tasks: [{ id: 1, title: 'Pagar aluguel', status: 'pending' }],
    score: 2,
  };
  dias[OUTRO_DIA - 1] = { ...vazio(OUTRO_DIA), journal: { count: 2 }, score: 1 };
  return dias;
}

function comDado() {
  vi.mocked(fetchAggregate).mockResolvedValue(mesComDado());
  vi.mocked(fetchTasksByRange).mockResolvedValue([TAREFA]);
}

describe('CalendarioScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchAggregate).mockReset();
    vi.mocked(fetchTasksByRange).mockReset();
    vi.mocked(criarEvento).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(apagarEvento).mockReset().mockResolvedValue({ id: 'evt-call', jaNaoExistia: false });
  });

  it('renderiza os itens do dia selecionado', async () => {
    comDado();
    render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
    expect(screen.getByText('Pagar aluguel')).toBeTruthy();
    // horário do evento vem do payload, não é decorativo
    expect(screen.getByText(/09:00\s*–\s*10:00/)).toBeTruthy();
  });

  // REGRESSÃO FIXADA: no desktop a grade do mês era cortada (o usuário via o mês
  // "só até o dia 18"). A contagem abaixo falha alto se alguém truncar de novo.
  it('a grade renderiza TODOS os dias do mês', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    const celulas = container.querySelectorAll('.ms-calendario-dia');
    expect(celulas.length).toBe(DIAS_NO_MES);
    expect(container.querySelector(`[data-dia="${DIAS_NO_MES}"]`)).toBeTruthy();
    // e os números são 1..N, sem buraco
    expect(Array.from(celulas, (c) => Number(c.textContent))).toEqual(
      Array.from({ length: DIAS_NO_MES }, (_, i) => i + 1),
    );
  });

  it('a grade renderiza o mês inteiro mesmo quando a api falha', async () => {
    vi.mocked(fetchAggregate).mockRejectedValue(new Error('rede'));
    vi.mocked(fetchTasksByRange).mockRejectedValue(new Error('rede'));
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar os itens deste dia/i)).toBeTruthy());
    expect(container.querySelectorAll('.ms-calendario-dia').length).toBe(DIAS_NO_MES);
  });

  it('marca o dia de hoje com a classe de destaque', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    const hoje = container.querySelector(`[data-dia="${HOJE_DIA}"]`);
    expect(hoje?.className).toContain('ms-calendario-dia--hoje');
    // e é o único
    expect(container.querySelectorAll('.ms-calendario-dia--hoje').length).toBe(1);
  });

  it('as bolinhas saem do dado, não da decoração', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    // hoje: evento + tarefa = duas categorias
    const pontosHoje = container.querySelectorAll(`[data-pontos="${iso(HOJE_DIA)}"] .ms-calendario-ponto`);
    expect(Array.from(pontosHoje, (p) => p.getAttribute('data-cat')).sort()).toEqual(['eventos', 'tarefas']);
    // outro dia: só diário
    const pontosOutro = container.querySelectorAll(`[data-pontos="${iso(OUTRO_DIA)}"] .ms-calendario-ponto`);
    expect(Array.from(pontosOutro, (p) => p.getAttribute('data-cat'))).toEqual(['diario']);
    // um dia realmente vazio não ganha bolinha nenhuma
    const vaziosSemPonto = Array.from({ length: DIAS_NO_MES }, (_, i) => i + 1)
      .filter((d) => d !== HOJE_DIA && d !== OUTRO_DIA)
      .every((d) => container.querySelectorAll(`[data-pontos="${iso(d)}"] .ms-calendario-ponto`).length === 0);
    expect(vaziosSemPonto).toBe(true);
  });

  it('tocar num dia troca a lista para aquele dia', async () => {
    comDado();
    const { container } = render(<CalendarioScreen />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    fireEvent.click(container.querySelector(`[data-dia="${OUTRO_DIA}"]`) as HTMLElement);
    await waitFor(() => expect(screen.getByText(/2 anotações no diário/i)).toBeTruthy());
    expect(screen.queryByText('Call com o time')).toBeNull();
  });

  it('mostra o vazio do dia, e o bloco não some', async () => {
    vi.mocked(fetchAggregate).mockResolvedValue(
      Array.from({ length: DIAS_NO_MES }, (_, i) => vazio(i + 1)),
    );
    vi.mocked(fetchTasksByRange).mockResolvedValue([]);
    const { container } = render(<CalendarioScreen />);

    await waitFor(() => expect(screen.getByText(/nada marcado neste dia/i)).toBeTruthy());
    expect(screen.getByText(/nenhum registro neste mês/i)).toBeTruthy();
    // o vazio não é um erro
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('mostra erro quando a api falha, com frase própria por bloco', async () => {
    vi.mocked(fetchAggregate).mockRejectedValue(new Error('rede'));
    vi.mocked(fetchTasksByRange).mockRejectedValue(new Error('rede'));
    render(<CalendarioScreen />);

    await waitFor(() => expect(screen.getByText(/não consegui carregar os itens deste dia/i)).toBeTruthy());
    expect(screen.getByText(/não consegui marcar os dias deste mês/i)).toBeTruthy();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    // e nunca mente dizendo que o dia está livre
    expect(screen.queryByText(/nada marcado neste dia/i)).toBeNull();
  });

  it('o ‹ do cabeçalho chama onBack', async () => {
    comDado();
    const onBack = vi.fn();
    render(<CalendarioScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  /* O "+" — o buraco que a integração fechou.
     `ModalEvento` estava pronto e sem quem o montasse. O "+" desta tela abria a
     LISTA DE TAREFAS, porque criar evento não tinha rota: existia só como
     ferramenta do modelo. Com `POST /google/calendar/events` de pé, o controle
     passou a fazer o que a tela em que ele está promete. */
  describe('novo evento', () => {
    const abrir = async () => {
      comDado();
      const onOpen = vi.fn();
      render(<CalendarioScreen onOpen={onOpen} />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Novo evento' }));
      return { dialogo: await screen.findByRole('dialog'), onOpen };
    };

    it('abre o sheet de novo evento em vez de navegar para outra tela', async () => {
      const { dialogo, onOpen } = await abrir();
      expect(dialogo.getAttribute('aria-label')).toBe('Novo evento');
      // A regressão que isto tranca: o "+" voltar a empurrar `tarefas-view`.
      expect(onOpen).not.toHaveBeenCalled();
    });

    it('sem tocar no "+", não há sheet montado', async () => {
      comDado();
      render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('nasce no DIA SELECIONADO, e não em hoje', async () => {
      comDado();
      render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      // escolhe outro dia na grade antes de abrir
      fireEvent.click(screen.getByLabelText(new RegExp(`^${OUTRO_DIA} de `)));
      fireEvent.click(screen.getByRole('button', { name: 'Novo evento' }));

      await screen.findByRole('dialog');
      expect((screen.getByLabelText('Data de início') as HTMLInputElement).value)
        .toBe(iso(OUTRO_DIA));
    });

    it('criado, o mês inteiro se refaz', async () => {
      await abrir();
      expect(fetchAggregate).toHaveBeenCalledTimes(1);

      fireEvent.change(screen.getByLabelText('Título do evento'), {
        target: { value: 'Dentista' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

      await waitFor(() => expect(criarEvento).toHaveBeenCalledTimes(1));
      // O mês, não só o dia: o evento novo pode cair em qualquer célula.
      await waitFor(() => expect(fetchAggregate).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  /* APAGAR EVENTO — o que destrava testar a criação contra o Google de
     verdade: criar pelo celular e apagar pelo celular.

     A INTERAÇÃO É BOTÃO NA LINHA, e não deslizar nem toque longo. As razões,
     na ordem em que pesaram:
      - é DESTRUTIVA. Gesto é a forma mais fácil de disparar sem querer numa
        lista que rola, e um evento apagado por engano não tem desfazer aqui.
      - a onda já decidiu isto uma vez: a tela de Planejamento trocou o
        arrastar por toque (commit 6d680f9) pelo mesmo motivo.
      - gesto não se testa: em jsdom o que se simula é o mock do gesto, não o
        gesto. Um botão a gente clica.
     E a confirmação NOMEIA o que vai sumir — "tem certeza?" não diz nada. */
  describe('apagar evento', () => {
    const carregado = async () => {
      comDado();
      const r = render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Call com o time')).toBeTruthy());
      return r;
    };

    const botaoApagar = () => screen.getByRole('button', { name: /apagar.*call com o time/i });

    it('só as linhas de EVENTO ganham o controle de apagar', async () => {
      await carregado();
      expect(botaoApagar()).toBeTruthy();
      // A tarefa do mesmo dia não: ela se apaga na tela de tarefas, e o
      // `DELETE` do calendário nem a alcançaria.
      expect(screen.queryByRole('button', { name: /apagar.*pagar aluguel/i })).toBeNull();
    });

    it('um toque não apaga: pergunta antes, dizendo o que vai sumir', async () => {
      await carregado();
      fireEvent.click(botaoApagar());

      expect(apagarEvento).not.toHaveBeenCalled();
      const pergunta = screen.getByText(/apagar/i, { selector: '.ms-calendario-confirma__texto' });
      // O NOME e o HORÁRIO: "tem certeza?" é pior que "apagar isto aqui?".
      expect(pergunta.textContent).toContain('Call com o time');
      expect(pergunta.textContent).toMatch(/09:00\s*–\s*10:00/);
      expect(screen.getByRole('button', { name: 'Sim' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Não' })).toBeTruthy();
    });

    it('"Não" desiste, e a linha continua inteira', async () => {
      await carregado();
      fireEvent.click(botaoApagar());
      fireEvent.click(screen.getByRole('button', { name: 'Não' }));

      expect(apagarEvento).not.toHaveBeenCalled();
      expect(screen.getByText('Call com o time')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sim' })).toBeNull();
      expect(botaoApagar()).toBeTruthy();
    });

    it('"Sim" apaga pelo ID, e a linha some junto com a bolinha do dia', async () => {
      const { container } = await carregado();
      fireEvent.click(botaoApagar());
      fireEvent.click(screen.getByRole('button', { name: 'Sim' }));

      await waitFor(() => expect(apagarEvento).toHaveBeenCalledWith('evt-call'));
      await waitFor(() => expect(screen.queryByText('Call com o time')).toBeNull());
      // Bolinha e lista nunca discordam: sem o evento, o dia fica só com a
      // categoria da tarefa.
      const cats = Array.from(
        container.querySelectorAll(`[data-pontos="${iso(HOJE_DIA)}"] .ms-calendario-ponto`),
        (p) => p.getAttribute('data-cat'),
      );
      expect(cats).toEqual(['tarefas']);
    });

    it('A FALHA NÃO APAGA A LINHA — e diz o motivo', async () => {
      // O pior resultado possível desta tela: o usuário achar que apagou e o
      // compromisso continuar no Google.
      vi.mocked(apagarEvento).mockRejectedValue(new Error('rede caiu no meio'));
      await carregado();
      fireEvent.click(botaoApagar());
      fireEvent.click(screen.getByRole('button', { name: 'Sim' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(screen.getByText('Call com o time')).toBeTruthy();
      expect(screen.getByRole('alert').textContent).toContain('rede caiu no meio');
      expect(screen.getByRole('alert').textContent).toContain('Call com o time');
      // e dá para tentar de novo
      expect(botaoApagar()).toBeTruthy();
    });

    it('GOOGLE DESCONECTADO chega com o que fazer, não como "HTTP 401"', async () => {
      vi.mocked(apagarEvento).mockRejectedValue(
        new Error('Google não está conectado — conecte em /google/oauth/start'),
      );
      await carregado();
      fireEvent.click(botaoApagar());
      fireEvent.click(screen.getByRole('button', { name: 'Sim' }));

      await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
      expect(screen.getByRole('alert').textContent).toMatch(/google.*conectado/i);
      expect(screen.getByText('Call com o time')).toBeTruthy();
    });

    it('o "Sim" não dispara duas exclusões', async () => {
      let resolver: (v: { id: string; jaNaoExistia: boolean }) => void = () => {};
      vi.mocked(apagarEvento).mockReturnValue(new Promise((r) => { resolver = r; }));
      await carregado();
      fireEvent.click(botaoApagar());
      const sim = screen.getByRole('button', { name: 'Sim' });
      fireEvent.click(sim);
      fireEvent.click(sim);

      expect(apagarEvento).toHaveBeenCalledTimes(1);
      resolver({ id: 'evt-call', jaNaoExistia: false });
      await waitFor(() => expect(screen.queryByText('Call com o time')).toBeNull());
    });

    it('o alvo de toque do controle destrutivo tem os 44pt', () => {
      // jsdom não faz layout (todo rect é zero), então o que dá para afirmar é
      // a CASCATA: existe no CSS da tela uma regra que casa com o botão e lhe
      // declara 44×44. É o que morre se alguém encolher o alvo — e o alvo que
      // menos pode ser apertado é justamente o que apaga.
      document.documentElement.dataset.shell = 'phone';
      const estilo = document.createElement('style');
      estilo.textContent = readFileSync(
        resolve(__dirname, '..', 'CalendarioScreen.css'),
        'utf8',
      );
      document.head.appendChild(estilo);
      document.body.innerHTML = '<button class="ms-calendario-item__apagar"></button>' +
        '<button class="ms-calendario-confirma__botao"></button>';

      const px = (regra: CSSStyleRule, prop: string) => {
        const m = /^(\d+(?:\.\d+)?)px$/.exec(regra.style.getPropertyValue(prop).trim());
        return m ? Number(m[1]) : 0;
      };
      const medir = (el: Element) => {
        let largura = 0;
        let altura = 0;
        for (const r of Array.from(estilo.sheet!.cssRules)) {
          if (!('selectorText' in r)) continue;
          const regra = r as CSSStyleRule;
          for (const parte of regra.selectorText.split(',')) {
            if (!el.matches(parte.trim())) continue;
            largura = Math.max(largura, px(regra, 'min-width') || px(regra, 'width'));
            altura = Math.max(altura, px(regra, 'min-height') || px(regra, 'height'));
          }
        }
        return { largura, altura };
      };

      expect(medir(document.querySelector('.ms-calendario-item__apagar')!))
        .toEqual({ largura: 44, altura: 44 });
      const conf = medir(document.querySelector('.ms-calendario-confirma__botao')!);
      expect(conf.largura).toBeGreaterThanOrEqual(44);
      expect(conf.altura).toBeGreaterThanOrEqual(44);

      estilo.remove();
      document.body.innerHTML = '';
      delete document.documentElement.dataset.shell;
    });

    it('evento SEM id: o controle aparece desabilitado e diz por quê', async () => {
      // Nada some por falta de dado. Sem id não dá para apagar com segurança —
      // e sumir com o botão calado seria o usuário procurando o que não existe.
      const dias = mesComDado();
      dias[HOJE_DIA - 1] = {
        ...dias[HOJE_DIA - 1],
        events: [{ title: 'Evento sem id', start: `${iso(HOJE_DIA)}T09:00:00`, end: `${iso(HOJE_DIA)}T10:00:00` }],
      };
      vi.mocked(fetchAggregate).mockResolvedValue(dias);
      vi.mocked(fetchTasksByRange).mockResolvedValue([TAREFA]);
      render(<CalendarioScreen />);
      await waitFor(() => expect(screen.getByText('Evento sem id')).toBeTruthy());

      const botao = screen.getByRole('button', { name: /não dá para apagar.*evento sem id/i });
      expect((botao as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(botao);
      expect(apagarEvento).not.toHaveBeenCalled();
    });
  });
});
