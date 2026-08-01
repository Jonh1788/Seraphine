import { lazy } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ArrowLeftIcon } from '../../icons/Icons';
import type { ScreenProps } from '../screens/registry';

// O registry real é trocado por telas de mentira: este teste é sobre a MONTAGEM
// (o shell acha a tela pela chave, passa onBack, e quem carrega não derruba a
// tab bar) — não sobre o conteúdo das telas, que a Onda 2 reescreve.
//
// `trilhas` NUNCA resolve de propósito: é a tela usada para observar o estado
// suspenso. As demais resolvem, e o React guarda o módulo resolvido no próprio
// objeto do lazy — por isso cada chave é usada por um teste só.
vi.mock('../screens/registry', () => ({
  SCREEN_KEYS: [],
  SCREENS: {
    // Estas duas dizem se receberam `onBack`: nas ABAS elas não podem receber.
    // É a assimetria que a Task 28 desfez — enquanto a aba `tarefas` ganhava um
    // `onBack` que voltava para o Hoje, a tela não podia usar `onBack &&` para
    // saber se estava empurrada e tinha de perguntar ao DOM.
    tarefas: lazy(async () => ({
      default: ({ onBack }: ScreenProps) => <div>tela:tarefas{onBack ? ':com-onBack' : ''}</div>,
    })),
    chat: lazy(async () => ({
      default: ({ onBack }: ScreenProps) => <div>tela:chat{onBack ? ':com-onBack' : ''}</div>,
    })),
    trilhas: lazy(() => new Promise<{ default: () => JSX.Element }>(() => {})),
    financas: lazy(async () => ({
      default: ({ onBack }: ScreenProps) => (
        <button type="button" onClick={onBack}>fechar-financas</button>
      ),
    })),
    // Tela empurrada como o handoff manda: o cabeçalho (com o ‹) é DELA.
    calendario: lazy(async () => ({
      default: ({ onBack }: ScreenProps) => (
        <div>
          <header>
            <button type="button" aria-label="Voltar" onClick={onBack}>
              <ArrowLeftIcon size={18} />
            </button>
            <h1>Junho</h1>
          </header>
        </div>
      ),
    })),
    // Par usado pelo teste do parâmetro: `inbox` empurra `whatsapp` COM id, e
    // a empurrada mostra o que recebeu. Uma tela empurrada sem id (a própria
    // `inbox`, que o Mais abre) mostra `undefined` — é o caso das quinze telas
    // que não mandam nem leem o campo.
    inbox: lazy(async () => ({
      default: ({ onOpen, onBack, id }: ScreenProps) => (
        <div>
          <span>inbox-id:{String(id)}</span>
          <button type="button"
            onClick={() => onOpen?.({ key: 'whatsapp', title: 'Ana', id: '5511999999999@c.us' })}>
            abrir-thread
          </button>
          <button type="button" onClick={onBack}>fechar-inbox</button>
        </div>
      ),
    })),
    whatsapp: lazy(async () => ({
      default: ({ id, onBack }: ScreenProps) => (
        <div>
          <span>thread:{id ?? 'sem-id'}</span>
          {/* o ‹ é da tela, como no app: é ele que desfaz o degrau */}
          <button type="button" onClick={onBack}>fechar-thread</button>
        </div>
      ),
    })),
    'onboarding-boas-vindas': lazy(async () => ({
      default: ({ onDone }: ScreenProps) => (
        <button type="button" onClick={onDone}>ob1-avancar</button>
      ),
    })),
    'onboarding-permissoes': lazy(async () => ({
      default: ({ onDone }: ScreenProps) => (
        <button type="button" onClick={onDone}>ob2-concluir</button>
      ),
    })),
  },
}));

const { PhoneShell } = await import('../PhoneShell');

const ONBOARDING_KEY = 'seraphine.onboarding.done';
/** O gate de primeiro lançamento fica fora do caminho dos testes de aba. */
const jaOnboardou = () => localStorage.setItem(ONBOARDING_KEY, '1');

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

/** Drena os fetches que as telas reais (Hoje/Mais) disparam no mount. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** O React não desmonta a árvore suspensa: esconde com display:none. Então
 *  "continua no DOM" não prova nada — o que importa é continuar visível. */
function visivel(el: Element | null): boolean {
  if (!el) return false;
  for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
    if (n.style.display === 'none') return false;
  }
  return true;
}

describe('PhoneShell monta pelo registry', () => {
  it('renderiza a tela do registry nas abas que não são Hoje/Mais', async () => {
    jaOnboardou();
    const { getByText, findByText } = render(<PhoneShell />);
    // "Tarefas" aparece duas vezes enquanto o Hoje está montado: no rótulo da
    // aba e no cartão de tarefas do Hoje — que agora fica de pé mesmo sem
    // tarefa aberta, em vez de sumir. O clique é na ABA.
    fireEvent.click(getByText('Tarefas', { selector: '.mtab__label' }));
    // O sufixo é a asserção: a aba NÃO recebe `onBack`. Se voltar a receber,
    // este texto muda e o teste cai — e é o que faz a tela poder decidir a seta
    // de voltar por `onBack &&` em vez de perguntar ao DOM.
    expect(await findByText('tela:tarefas')).toBeTruthy();
    fireEvent.click(getByText('Chat'));
    expect(await findByText('tela:chat')).toBeTruthy();
  });

  it('mantém a tab bar visível enquanto a tela da aba ainda carrega', () => {
    jaOnboardou();
    const { container, getByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Trilhas')); // suspende e nunca resolve
    expect(container.querySelector('.mshell__content')?.innerHTML).toBe('');
    // se o Suspense envolvesse o shell inteiro, o React esconderia a tab bar
    expect(visivel(container.querySelector('.mtabbar'))).toBe(true);
  });

  it('empurra o módulo pelo registry e volta pelo onBack da tela', async () => {
    jaOnboardou();
    const { container, getByText, findByText, queryByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle(); // deixa o fetch de stats do Mais assentar
    fireEvent.click(getByText('Finanças'));
    // O contêiner monta VAZIO enquanto o chunk carrega: quem desenha cabeçalho
    // é a tela, então o shell não tem nada a mostrar antes dela resolver.
    expect(visivel(container.querySelector('.mpushed'))).toBe(true);
    expect(container.querySelector('.mpushed')?.textContent).toBe('');
    expect(container.querySelector('.mtabbar')).toBeNull(); // empurrada = sem tab bar
    fireEvent.click(await findByText('fechar-financas'));
    expect(queryByText('fechar-financas')).toBeNull();
    expect(container.querySelector('.mtabbar')).toBeTruthy();
    await settle(); // o Mais remonta ao voltar e refaz o fetch de stats
  });

  // A regressão que este teste tranca: o shell voltar a desenhar chrome próprio
  // — dois ‹ na mesma tela, ou o título repetido (aconteceu duas vezes na onda).
  it('não desenha chrome: o voltar da tela empurrada é o único da árvore', async () => {
    jaOnboardou();
    const { container, getByText, findByText, queryByText, queryAllByText, queryAllByLabelText } =
      render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle();
    fireEvent.click(getByText('Calendário'));
    await findByText('Junho'); // a tela resolveu e desenhou o cabeçalho dela

    expect(queryAllByLabelText('Voltar')).toHaveLength(1); // o dela, e só
    expect(container.querySelector('.mpushed__head')).toBeNull();
    // o título que o shell empilhava ('Calendário') não é mais renderizado por
    // ninguém: a tela diz o próprio nome ('Junho')
    expect(queryAllByText('Calendário')).toHaveLength(0);

    fireEvent.click(queryAllByLabelText('Voltar')[0]); // o ‹ da tela fecha a pilha
    expect(queryByText('Junho')).toBeNull();
    expect(container.querySelector('.mtabbar')).toBeTruthy();
    await settle();
  });

  // O buraco que este teste tranca: `Pushed` levava só `{key, title}`, então
  // uma tela empurrada não tinha como saber QUAL lição/conversa abrir — e três
  // telas da onda resolviam uma por conta própria (a Trilhas abria a lição
  // destravada mesmo quando você tocava numa já concluída).
  it('entrega à tela empurrada o id que quem empurrou mandou', async () => {
    jaOnboardou();
    const { getByText, findByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle();

    // empurrada sem id: o campo chega `undefined`, não some nem vira ''
    fireEvent.click(getByText('Inbox'));
    expect(await findByText('inbox-id:undefined')).toBeTruthy();

    // ela empurra outra COM id, e o id atravessa o estado do shell até a tela
    fireEvent.click(getByText('abrir-thread'));
    expect(await findByText('thread:5511999999999@c.us')).toBeTruthy();
    await settle();
  });

  // O buraco que este teste tranca: `pushed` era UM SLOT, então o `onBack` de
  // qualquer tela empurrada voltava para a ABA. Toda cadeia de dois níveis
  // perdia o meio do caminho em silêncio — Configurações → Seletor de modelo
  // caía no Mais, Custos → detalhe idem, Trilhas → lista → mapa idem.
  it('voltar de um segundo nível cai no PRIMEIRO, e não na aba', async () => {
    jaOnboardou();
    const { container, getByText, findByText, queryByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle();

    fireEvent.click(getByText('Inbox')); // degrau 1
    expect(await findByText('inbox-id:undefined')).toBeTruthy();
    fireEvent.click(getByText('abrir-thread')); // degrau 2
    expect(await findByText('thread:5511999999999@c.us')).toBeTruthy();
    expect(queryByText('inbox-id:undefined')).toBeNull(); // só o topo é montado

    fireEvent.click(getByText('fechar-thread'));

    // A ASSERÇÃO: o degrau 1 volta. Com um slot só, aqui aparecia a tab bar e o
    // Inbox tinha sumido — e nenhum teste dizia nada.
    expect(await findByText('inbox-id:undefined')).toBeTruthy();
    expect(container.querySelector('.mtabbar')).toBeNull();

    // e só o segundo voltar esvazia a pilha e devolve a tab bar
    fireEvent.click(getByText('fechar-inbox'));
    expect(queryByText('inbox-id:undefined')).toBeNull();
    expect(container.querySelector('.mtabbar')).toBeTruthy();
    await settle();
  });

  it('cai no "em construção" quando a chave empurrada não existe no registry', async () => {
    jaOnboardou();
    const { container, getByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle();
    fireEvent.click(getByText('Memória')); // não está no registry de mentira
    expect(container.querySelector('.mshell-pending')?.textContent).toBe('Em construção');
  });
});

describe('gate de primeiro lançamento', () => {
  it('sem a flag, mostra o onboarding e NÃO monta a tab bar', async () => {
    const { container, findByText } = render(<PhoneShell />);
    expect(await findByText('ob1-avancar')).toBeTruthy();
    // NÃO MONTADA, não apenas escondida: o onboarding entra no LUGAR do shell
    // de abas. `visivel() === false` aceitaria uma tab bar com display:none.
    expect(container.querySelector('.mtabbar')).toBeNull();
  });

  it('com a flag, mostra o shell de abas e nenhum passo de onboarding', async () => {
    jaOnboardou();
    const { container, queryByText } = render(<PhoneShell />);
    await settle();
    expect(visivel(container.querySelector('.mtabbar'))).toBe(true);
    expect(queryByText('ob1-avancar')).toBeNull();
    expect(queryByText('ob2-concluir')).toBeNull();
  });

  it('avança os passos e no último grava a flag e libera as abas', async () => {
    const { container, findByText, queryByText } = render(<PhoneShell />);
    fireEvent.click(await findByText('ob1-avancar'));

    // segundo passo: ainda sem tab bar e sem flag gravada
    expect(await findByText('ob2-concluir')).toBeTruthy();
    expect(container.querySelector('.mtabbar')).toBeNull();
    expect(localStorage.getItem(ONBOARDING_KEY)).toBeNull();

    fireEvent.click(await findByText('ob2-concluir'));
    expect(localStorage.getItem(ONBOARDING_KEY)).toBe('1');
    expect(queryByText('ob2-concluir')).toBeNull();
    expect(visivel(container.querySelector('.mtabbar'))).toBe(true);
    await settle(); // o Hoje monta ao final e dispara seus fetches
  });
});
