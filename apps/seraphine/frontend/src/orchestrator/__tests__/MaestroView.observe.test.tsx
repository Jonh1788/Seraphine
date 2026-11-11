/* O painel aberto acompanhando a sessão viva.
 *
 * A queixa original tinha duas metades. A lista congelada era a primeira; esta é
 * a segunda: com a sessão observada aberta, resposta nova só aparecia fechando e
 * reabrindo a aba, porque o transcript era lido UMA vez, num efeito preso só em
 * `observed`.
 *
 * Integração de verdade: só `../api` e os stores são falsificados. `useSessions`
 * (o poller) roda de verdade, então o teste falha se a fiação entre o mtime que o
 * poller traz e a releitura do transcript se soltar.
 *
 * O poller é adiantado pelo botão "Atualizar" (o mesmo `refreshNow` do intervalo)
 * em vez de timers falsos: o caminho testado é idêntico e não há relógio a fingir.
 */
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const est = vi.hoisted(() => {
  const agora = Date.now();
  return {
    agora,
    sessoes: [] as { session_id: string; slug: string; cwd: string; last_modified_ms: number }[],
    /** Transcript de cada sessão, por slug. Cresce quando a sessão "responde". */
    linhas: {} as Record<string, { type: string; texto: string }[]>,
    /** Slugs cuja leitura de observação nunca resolve (transcript lento). */
    lentos: new Set<string>(),
    /** Quantas leituras de observação (tail 200) foram feitas. */
    leiturasObservacao: 0,
  };
});

/** Estado da timeline falsa: montagens/desmontagens provam se ela piscou, e a
 *  altura simulada cresce junto com o conteúdo, como no navegador. */
const tl = vi.hoisted(() => ({ montagens: 0, desmontagens: 0, alturaPorEvento: 1000, altura: 0 }));

vi.mock('../api', () => ({
  listSessions: vi.fn(async () => est.sessoes.map((s) => ({ ...s }))),
  listHosts: vi.fn(async () => []),
  readTranscript: vi.fn(async (slug: string, _sid: string, tail = 200) => {
    if (tail === 200) {
      est.leiturasObservacao += 1;
      if (est.lentos.has(slug)) return new Promise<unknown[]>(() => {});
      // A leitura de observação é um IPC do Tauri: custa milissegundos, não um
      // microtask. Resolver na hora esconderia o pisca-pisca — o React nunca
      // chegaria a pintar a lista vazia antes do conteúdo novo chegar.
      await new Promise((r) => setTimeout(r, 5));
      return est.linhas[slug] ?? [];
    }
    return (est.linhas[slug] ?? []).slice(-tail);
  }),
  sendToAgent: vi.fn(), stopAgent: vi.fn(), respondPermission: vi.fn(),
  resumeSession: vi.fn(), forkSession: vi.fn(), checkHost: vi.fn(), listRemoteSessions: vi.fn(),
}));
vi.mock('../useAgentStream', () => ({ useAgentStream: () => [] }));

const aprovacoes = vi.hoisted(() => ({
  enabled: false, pending: [] as unknown[], busy: null, rules: [] as unknown[],
  init: async () => {}, setEnabled: async () => {}, resolve: async () => {}, saveRules: async () => {},
}));
vi.mock('../approvalsStore', () => ({
  useApprovalsStore: (sel: (s: unknown) => unknown) => sel(aprovacoes),
}));
vi.mock('../selfImproveStore', () => {
  const hook = (sel: (s: unknown) => unknown) => sel({ phase: 'idle', history: [] });
  (hook as unknown as { getState: () => unknown }).getState = () => ({ phase: 'idle', history: [] });
  return { useSelfImproveStore: hook };
});
vi.mock('../skillsStore', () => ({ useSkillsStore: (sel: (s: unknown) => unknown) => sel({ drafts: [] }) }));
vi.mock('../SelfImprove', () => ({ SelfImprove: () => null }));
vi.mock('../SkillsPanel', () => ({ SkillsPanel: () => null }));
vi.mock('../NewAgentDialog', () => ({ NewAgentDialog: () => null }));
vi.mock('../Timeline', () => ({
  Timeline: ({ events }: { events: { raw: unknown }[] }): JSX.Element => {
    // A altura do conteúdo cresce no MESMO commit em que o texto novo entra —
    // é isso que torna visível a diferença entre decidir antes e depois.
    tl.altura = tl.alturaPorEvento * events.length;
    useEffect(() => {
      tl.montagens += 1;
      return () => { tl.desmontagens += 1; };
    }, []);
    return (
      <div data-testid="tl">
        {events.map((e, i) => <span key={i}>{String((e.raw as { texto?: string })?.texto ?? '')}</span>)}
      </div>
    );
  },
}));

import { MaestroView } from '../MaestroView';

/** A linha da LISTA (não o cabeçalho do detalhe) que contém este cwd. */
function linha(cwd: string): HTMLElement {
  const lista = document.querySelector('.maestro__list') as HTMLElement;
  const el = within(lista).getByText(cwd).closest('.maestro__row');
  if (!el) throw new Error(`sem linha para ${cwd}`);
  return el as HTMLElement;
}

const timelineEl = (): HTMLElement => document.querySelector('.maestro__timeline') as HTMLElement;
const campoAssumir = (): HTMLInputElement =>
  document.querySelector('.maestro__takeover input') as HTMLInputElement;

/** Adianta o poller sem timers falsos: é o mesmo `refreshNow` do intervalo. */
function atualizar(): void {
  fireEvent.click(screen.getByText('Atualizar'));
}

/** Faz o container da timeline responder a scrollTop/scrollHeight/clientHeight —
 *  jsdom não calcula layout, então tudo seria 0. */
function comRolagem(el: HTMLElement, scrollTop: number, clientHeight = 100): { get: () => number } {
  let top = scrollTop;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true, get: () => top, set: (v: number) => { top = v; },
  });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => tl.altura });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  return { get: () => top };
}

/** Abre a sessão viva e espera a primeira carga do transcript. */
async function observarViva(): Promise<void> {
  render(<MaestroView onBack={() => {}} />);
  await waitFor(() => expect(linha('/repos/vivo')).toBeTruthy());
  fireEvent.click(linha('/repos/vivo'));
  await waitFor(() => expect(screen.getByTestId('tl').textContent).toContain('primeira resposta'));
}

beforeEach(() => {
  est.sessoes = [
    { session_id: 'aaaa1111-viva', slug: 'repo-vivo', cwd: '/repos/vivo', last_modified_ms: est.agora - 10_000 },
    { session_id: 'bbbb2222-outra', slug: 'repo-outra', cwd: '/repos/outra', last_modified_ms: est.agora - 20_000 },
  ];
  est.linhas = {
    'repo-vivo': [{ type: 'assistant', texto: 'primeira resposta' }],
    'repo-outra': [{ type: 'assistant', texto: 'transcript da outra sessao' }],
  };
  est.lentos = new Set();
  est.leiturasObservacao = 0;
  tl.montagens = 0; tl.desmontagens = 0; tl.altura = 0;
});

/** A sessão observada escreveu de novo: mtime novo e uma linha a mais. */
function sessaoVivaRespondeu(): void {
  est.sessoes[0].last_modified_ms = est.agora;
  est.linhas['repo-vivo'] = [
    { type: 'assistant', texto: 'primeira resposta' },
    { type: 'assistant', texto: 'resposta final' },
  ];
}

describe('MaestroView: o detalhe aberto acompanha a sessão viva', () => {
  it('resposta nova aparece sem fechar e reabrir a aba', async () => {
    await observarViva();
    expect(screen.getByTestId('tl').textContent).not.toContain('resposta final');
    const leiturasAntes = est.leiturasObservacao;

    sessaoVivaRespondeu();
    atualizar();

    await waitFor(() => expect(screen.getByTestId('tl').textContent).toContain('resposta final'));
    expect(est.leiturasObservacao).toBeGreaterThan(leiturasAntes);
  });

  it('mtime igual não relê o transcript — o gatilho é a mudança, não o tick', async () => {
    await observarViva();
    const leiturasAntes = est.leiturasObservacao;

    atualizar();
    await waitFor(() => expect(screen.getByText(/2 sessões/)).toBeTruthy());
    // Deixa qualquer efeito pendente rodar antes de conferir.
    await new Promise((r) => setTimeout(r, 0));

    expect(est.leiturasObservacao).toBe(leiturasAntes);
  });

  it('reler a MESMA sessão não pisca a timeline', async () => {
    await observarViva();
    expect(tl.montagens).toBe(1);

    sessaoVivaRespondeu();
    atualizar();
    await waitFor(() => expect(screen.getByTestId('tl').textContent).toContain('resposta final'));

    // Um `setObservedEvents([])` no caminho de recarga desmontaria a timeline
    // (o painel cai no "Carregando transcript…") e remontaria em seguida.
    expect(tl.desmontagens).toBe(0);
    expect(tl.montagens).toBe(1);
  });

  it('trocar de sessão limpa a timeline e o campo de assumir', async () => {
    await observarViva();
    fireEvent.change(campoAssumir(), { target: { value: 'continua e abre um PR' } });
    expect(campoAssumir().value).toBe('continua e abre um PR');

    est.lentos.add('repo-outra'); // a leitura da outra demora: dá para ver o estado limpo
    fireEvent.click(linha('/repos/outra'));

    await waitFor(() => expect(screen.queryByTestId('tl')).toBeNull());
    expect(screen.getByText(/Carregando transcript/)).toBeTruthy();
    expect(campoAssumir().value).toBe('');
  });

  it('quem está no fim é levado junto pelo conteúdo novo', async () => {
    await observarViva();
    const rolagem = comRolagem(timelineEl(), 900); // altura 1000, janela 100 -> no fim

    sessaoVivaRespondeu();
    atualizar();
    await waitFor(() => expect(screen.getByTestId('tl').textContent).toContain('resposta final'));

    // A decisão foi tomada com a altura ANTIGA (1000). Decidir depois do render
    // veria 2000-100-900 = 1000 de distância e deixaria o usuário para trás.
    expect(rolagem.get()).toBe(2000);
  });

  it('quem subiu para ler não é arrastado de volta', async () => {
    await observarViva();
    const rolagem = comRolagem(timelineEl(), 100); // 1000-100-100 = 800 de distância

    sessaoVivaRespondeu();
    atualizar();
    await waitFor(() => expect(screen.getByTestId('tl').textContent).toContain('resposta final'));

    expect(rolagem.get()).toBe(100);
  });
});
