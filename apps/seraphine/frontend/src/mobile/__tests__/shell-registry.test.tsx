import { lazy } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    tarefas: lazy(async () => ({ default: () => <div>tela:tarefas</div> })),
    chat: lazy(async () => ({ default: () => <div>tela:chat</div> })),
    trilhas: lazy(() => new Promise<{ default: () => JSX.Element }>(() => {})),
    financas: lazy(async () => ({
      default: ({ onBack }: ScreenProps) => (
        <button type="button" onClick={onBack}>fechar-financas</button>
      ),
    })),
  },
}));

const { PhoneShell } = await import('../PhoneShell');

beforeEach(() => {
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
    const { getByText, findByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Tarefas'));
    expect(await findByText('tela:tarefas')).toBeTruthy();
    fireEvent.click(getByText('Chat'));
    expect(await findByText('tela:chat')).toBeTruthy();
  });

  it('mantém a tab bar visível enquanto a tela da aba ainda carrega', () => {
    const { container, getByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Trilhas')); // suspende e nunca resolve
    expect(container.querySelector('.mshell__content')?.innerHTML).toBe('');
    // se o Suspense envolvesse o shell inteiro, o React esconderia a tab bar
    expect(visivel(container.querySelector('.mtabbar'))).toBe(true);
  });

  it('empurra o módulo pelo registry e volta pelo onBack da tela', async () => {
    const { container, getByText, findByText, queryByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle(); // deixa o fetch de stats do Mais assentar
    fireEvent.click(getByText('Finanças'));
    // cabeçalho da tela empurrada visível ANTES de a tela resolver
    expect(container.querySelector('.mpushed__title')?.textContent).toBe('Finanças');
    expect(visivel(container.querySelector('.mpushed__back'))).toBe(true);
    fireEvent.click(await findByText('fechar-financas'));
    expect(queryByText('fechar-financas')).toBeNull();
    expect(container.querySelector('.mtabbar')).toBeTruthy();
    await settle(); // o Mais remonta ao voltar e refaz o fetch de stats
  });

  it('cai no "em construção" quando a chave empurrada não existe no registry', async () => {
    const { container, getByText } = render(<PhoneShell />);
    fireEvent.click(getByText('Mais'));
    await settle();
    fireEvent.click(getByText('Memória')); // não está no registry de mentira
    expect(container.querySelector('.mshell-pending')?.textContent).toBe('Em construção');
  });
});
