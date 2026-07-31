import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A tela de voz não tem `api.ts`: ela comanda o `RealtimeController`, que já
// existe e é dono do áudio/VPIO/wake word. O teste troca o controller por um
// duplo (é ele quem arrastaria three.js/WebGL para dentro do jsdom) e o
// `useAppRefs`, que entrega o WebSocket compartilhado de onde vem a transcrição.
const h = vi.hoisted(() => ({
  refs: {
    wsRef: { current: null as unknown },
    playbackRef: { current: null as unknown },
  },
  /** Últimas props que o controller recebeu — é por elas que se vê o comando. */
  props: null as Record<string, unknown> | null,
  montagens: 0,
}));

vi.mock('../../../stores/RefsContext', () => ({ useAppRefs: () => h.refs }));
vi.mock('../../../realtime', () => ({
  RealtimeController: (p: Record<string, unknown>) => {
    h.props = p;
    h.montagens += 1;
    return null;
  },
}));

import { useChatStore } from '../../../stores/chatStore';
import { useRealtimeStore } from '../../../stores/realtimeStore';
import { VozScreen } from '../VozScreen';

type Ouvinte = (m: unknown) => void;

/** A frase que a tela só pode dizer com sessão de verdade. Comparada por
 *  igualdade exata: um `/estou ouvindo/i` casaria também com uma negativa. */
const OUVINDO = 'Estou ouvindo — fale quando quiser.';

/** O texto que o `RealtimeController` produz quando o microfone não sobe
 *  (`RealtimeController.tsx:520`) — sem acento, como ele o escreve. */
const ERRO_DO_MOTOR = 'Nao foi possivel iniciar o modo realtime. Verifique o microfone.';

/** Só a superfície do `SeraphineWS` que a tela usa. */
class FakeWS {
  enviadas: Record<string, unknown>[] = [];
  private msgs = new Set<Ouvinte>();
  private conns = new Set<(s: string) => void>();
  send(m: Record<string, unknown>) { this.enviadas.push(m); }
  onMessage(cb: Ouvinte) { this.msgs.add(cb); return () => { this.msgs.delete(cb); }; }
  onStatus(cb: (s: string) => void) { this.conns.add(cb); return () => { this.conns.delete(cb); }; }
  emite(m: unknown) { act(() => { this.msgs.forEach((cb) => cb(m)); }); }
  /** O socket ABRIU. É só isto que autoriza a tela a dizer "ao vivo" — a
   *  existência do objeto, que vem antes, não autoriza nada. */
  conecta() { act(() => { this.conns.forEach((cb) => cb('connected')); }); }
  /** A queda. O cliente real ainda tenta voltar sozinho, em silêncio. */
  cai() { act(() => { this.conns.forEach((cb) => cb('disconnected')); }); }
}

/** Socket presente E aberto: o caminho feliz. */
function montar(props: Record<string, unknown> = {}) {
  const ws = new FakeWS();
  h.refs.wsRef.current = ws;
  const r = render(<VozScreen {...props} />);
  ws.conecta();
  return { ws, ...r };
}

/** Socket presente e MUDO — construído, nunca aberto. */
function montarSemAbrir(props: Record<string, unknown> = {}) {
  const ws = new FakeWS();
  h.refs.wsRef.current = ws;
  return { ws, ...render(<VozScreen {...props} />) };
}

/** O motor avisando que não conseguiu subir o microfone. */
function micFalha(mensagem: string | null = ERRO_DO_MOTOR) {
  const cb = h.props?.onError as ((m: string | null) => void) | undefined;
  if (!cb) throw new Error('o controller não recebeu `onError`: a falha do microfone não tem por onde sair');
  act(() => { cb(mensagem); });
}

const token = (texto: string, turn = 't1') =>
  ({ type: 'token', turn_id: turn, text: texto });

beforeEach(() => {
  h.refs.wsRef.current = null;
  h.refs.playbackRef.current = null;
  h.props = null;
  h.montagens = 0;
  localStorage.clear();
  useRealtimeStore.setState({ realtimeActive: false, manualMute: false });
  // O `AppBootstrap` mantém este campo; a tela o usa como semente porque
  // `onStatus` só fala em transições. Cada teste começa desconectado.
  useChatStore.setState({ status: 'disconnected' });
});

afterEach(() => { vi.useRealTimers(); });

describe('VozScreen', () => {
  it('liga o realtime ao abrir e desenha a sessão ao vivo', () => {
    montar();
    // O comando de partida: o controller é montado com a sessão ligada.
    expect(useRealtimeStore.getState().realtimeActive).toBe(true);
    expect(h.props?.active).toBe(true);
    expect(screen.getByText('ao vivo')).toBeTruthy();
  });

  it('mostra a transcrição que o controller reporta', () => {
    const { ws } = montar();
    ws.emite({ type: 'transcription', text: 'o que eu tenho amanhã?' });
    ws.emite(token('Amanhã você tem 3 compromissos'));
    ws.emite(token(' — o primeiro é às 9h.'));

    expect(screen.getByText('Amanhã você tem 3 compromissos — o primeiro é às 9h.')).toBeTruthy();
    expect(screen.getByText(/você disse/)).toBeTruthy();
    expect(screen.getByText(/o que eu tenho amanhã\?/)).toBeTruthy();
  });

  it('mostra estado vazio enquanto ninguém falou, não some', () => {
    montar();
    expect(screen.getByText(OUVINDO)).toBeTruthy();
    expect(screen.getByText(/você disse · ainda nada/i)).toBeTruthy();
  });

  it('mostra erro, e não uma tela congelada, quando a sessão não abre', () => {
    vi.useFakeTimers();
    // Sem socket: a tela tenta por 4s e então diz que não abriu.
    h.refs.wsRef.current = null;
    render(<VozScreen />);
    act(() => { vi.advanceTimersByTime(5000); });

    const alerta = screen.getByRole('alert');
    expect(alerta.textContent).toMatch(/não consegui abrir a sessão de voz/i);
    // O aviso de erro não pode ser lido como "ao vivo".
    expect(screen.queryByText('ao vivo')).toBeNull();
  });

  it('não pisca texto enquanto conecta: só esqueleto', () => {
    vi.useFakeTimers();
    h.refs.wsRef.current = null;
    const { container } = render(<VozScreen />);
    expect(container.querySelector('.ms-voz-skel')).toBeTruthy();
    expect(screen.queryByText(OUVINDO)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── o defeito central: afirmar sessão que não se verificou ──────────────

  it('socket que existe mas nunca abriu NÃO é sessão: sem "ao vivo", sem relógio, sem onda', () => {
    vi.useFakeTimers();
    const { container, ws } = montarSemAbrir();
    // O objeto está lá, e é exatamente o que a versão anterior confundia com
    // conexão: `!!ws` era a régua do "ao vivo".
    expect(h.props?.ws).toBe(ws);

    act(() => { vi.advanceTimersByTime(3000); });

    expect(screen.queryByText('ao vivo')).toBeNull();
    expect(screen.getByText('conectando')).toBeTruthy();
    // O relógio não conta tempo de uma sessão que não existe.
    expect(screen.getByText('00:00')).toBeTruthy();
    // E a onda não ondula: `--mudo` é a classe que zera a animação.
    expect(container.querySelector('.ms-voz__onda--mudo')).toBeTruthy();
    expect(screen.queryByText(OUVINDO)).toBeNull();
  });

  it('a queda no meio da sessão retira a afirmação — e o relógio para junto', () => {
    vi.useFakeTimers();
    const { container, ws } = montarSemAbrir();
    ws.conecta();
    expect(screen.getByText('ao vivo')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('00:03')).toBeTruthy();

    ws.cai();

    // A reconexão do cliente é silenciosa (backoff 1s/2s/5s). Silêncio não é
    // sessão: enquanto ela não volta, a tela não pode continuar afirmando.
    expect(screen.queryByText('ao vivo')).toBeNull();
    expect(screen.getByText('reconectando')).toBeTruthy();
    expect(container.querySelector('.ms-voz__onda--mudo')).toBeTruthy();
    expect(screen.queryByText(OUVINDO)).toBeNull();

    // O relógio congela em vez de somar tempo que não houve.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText('00:03')).toBeTruthy();

    // Quando o backoff vence, a afirmação volta — e o relógio com ela.
    ws.conecta();
    expect(screen.getByText('ao vivo')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.getByText('00:05')).toBeTruthy();
  });

  it('a queda que não volta vira "sem conexão", não uma tela parada dizendo ao vivo', () => {
    vi.useFakeTimers();
    const { ws } = montarSemAbrir();
    ws.conecta();
    ws.cai();
    act(() => { vi.advanceTimersByTime(5000); });

    expect(screen.getByText('sem conexão')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/caiu/i);
    expect(screen.queryByText('ao vivo')).toBeNull();
  });

  it('socket já aberto antes de a tela abrir conta como conexão', () => {
    // `onStatus` só dispara em TRANSIÇÕES: sem a semente do `chatStore`, quem
    // assina um socket já aberto ficaria "conectando" para sempre.
    useChatStore.setState({ status: 'connected' });
    montarSemAbrir();
    expect(screen.getByText('ao vivo')).toBeTruthy();
  });

  it('microfone negado: a tela avisa e para de dizer que está ouvindo', () => {
    const { container } = montar();
    expect(screen.getByText(OUVINDO)).toBeTruthy();

    micFalha();

    // O aviso do motor mora num subárvore que esta tela esconde; ela tem que
    // dizer a falha com a própria voz, senão o microfone negado fica invisível.
    expect(screen.getByRole('alert').textContent).toMatch(/microfone/i);
    expect(screen.queryByText(OUVINDO)).toBeNull();
    expect(screen.queryByText('ao vivo')).toBeNull();
    expect(screen.getByText('sem microfone')).toBeTruthy();
    expect(container.querySelector('.ms-voz__onda--mudo')).toBeTruthy();
  });

  it('microfone que volta a subir devolve a sessão', () => {
    montar();
    micFalha();
    expect(screen.queryByText('ao vivo')).toBeNull();
    micFalha(null);
    expect(screen.getByText('ao vivo')).toBeTruthy();
    expect(screen.getByText(OUVINDO)).toBeTruthy();
  });

  // ── comandos ────────────────────────────────────────────────────────────

  it('encerrar manda o controller parar e sai da tela', () => {
    const onBack = vi.fn();
    montar({ onBack });
    fireEvent.click(screen.getByRole('button', { name: /encerrar/i }));

    // "Parar" é a única forma que o controller expõe: `active` volta a false.
    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
    expect(h.props?.active).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('encerrar sem `onBack` não congela a tela: ela se diz encerrada', () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: /encerrar/i }));

    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
    expect(screen.getByText('sessão encerrada')).toBeTruthy();
    expect(screen.getByText(/conversa encerrada/i)).toBeTruthy();
    expect(screen.queryByText('ao vivo')).toBeNull();
    // E o motor recebeu a ordem de parar, não só o rótulo mudou.
    expect(h.props?.active).toBe(false);
  });

  it('sair da tela desliga o realtime — o microfone não fica quente', () => {
    const { unmount } = montar();
    expect(useRealtimeStore.getState().realtimeActive).toBe(true);
    unmount();
    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
  });

  it('o teclado abre o chat, que é onde o teclado mora', () => {
    const onOpen = vi.fn();
    const onBack = vi.fn();
    montar({ onOpen, onBack });
    fireEvent.click(screen.getByRole('button', { name: /teclado/i }));

    expect(onOpen).toHaveBeenCalledWith({ key: 'chat', title: 'Chat' });
    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
  });

  it('o teclado volta para o chat e para a sessão', () => {
    const onBack = vi.fn();
    montar({ onBack });
    fireEvent.click(screen.getByRole('button', { name: /teclado/i }));

    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem rota para o chat, o botão do teclado não promete teclado', () => {
    montar();
    const b = screen.getByRole('button', { name: /teclado/i }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    // E não é um segundo "encerrar" disfarçado de teclado.
    fireEvent.click(b);
    expect(useRealtimeStore.getState().realtimeActive).toBe(true);
    expect(screen.getByText('ao vivo')).toBeTruthy();
  });

  it('o timer conta em mm:ss e passa de 60s', () => {
    vi.useFakeTimers();
    const { ws } = montarSemAbrir();
    ws.conecta();
    expect(screen.getByText('00:00')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(75_000); });
    expect(screen.getByText('01:15')).toBeTruthy();
  });

  it('o mudo passa para o controller e para a onda', () => {
    const { container } = montar();
    expect(h.props?.manualMute).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /silenciar/i }));

    expect(useRealtimeStore.getState().manualMute).toBe(true);
    expect(h.props?.manualMute).toBe(true);
    expect(container.querySelector('.ms-voz__onda--mudo')).toBeTruthy();
  });

  it('desenha os dois anéis e as oito barras do handoff', () => {
    const { container } = montar();
    expect(container.querySelectorAll('.ms-voz__anel')).toHaveLength(2);
    expect(container.querySelectorAll('.ms-voz__barra')).toHaveLength(8);
    // A segunda barra não pode compartilhar o atraso da primeira: é o
    // escalonamento que faz a onda ondular em vez de pulsar em bloco.
    const barras = container.querySelectorAll<HTMLElement>('.ms-voz__barra');
    expect(barras[0].style.animationDelay).not.toBe(barras[1].style.animationDelay);
  });

  it('diz que a resposta falhou em vez de ficar calada', () => {
    const { ws } = montar();
    ws.emite({ type: 'error', message: 'o modelo caiu' });
    const alerta = screen.getByRole('alert');
    expect(alerta.textContent).toMatch(/o modelo caiu/);
  });
});
