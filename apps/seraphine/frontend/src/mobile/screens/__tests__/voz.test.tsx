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

import { useRealtimeStore } from '../../../stores/realtimeStore';
import { VozScreen } from '../VozScreen';

type Ouvinte = (m: unknown) => void;

/** Só a superfície do `SeraphineWS` que a tela usa. */
class FakeWS {
  enviadas: Record<string, unknown>[] = [];
  private msgs = new Set<Ouvinte>();
  private conns = new Set<(s: string) => void>();
  send(m: Record<string, unknown>) { this.enviadas.push(m); }
  onMessage(cb: Ouvinte) { this.msgs.add(cb); return () => { this.msgs.delete(cb); }; }
  onStatus(cb: (s: string) => void) { this.conns.add(cb); return () => { this.conns.delete(cb); }; }
  emite(m: unknown) { act(() => { this.msgs.forEach((cb) => cb(m)); }); }
}

function montar(props: Record<string, unknown> = {}) {
  const ws = new FakeWS();
  h.refs.wsRef.current = ws;
  return { ws, ...render(<VozScreen {...props} />) };
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
    expect(screen.getByText(/estou ouvindo/i)).toBeTruthy();
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
    expect(screen.queryByText(/estou ouvindo/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

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

  it('o timer conta em mm:ss e passa de 60s', () => {
    vi.useFakeTimers();
    const ws = new FakeWS();
    h.refs.wsRef.current = ws;
    render(<VozScreen />);
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

  it('o teclado volta para o chat e para a sessão', () => {
    const onBack = vi.fn();
    montar({ onBack });
    fireEvent.click(screen.getByRole('button', { name: /teclado/i }));

    expect(useRealtimeStore.getState().realtimeActive).toBe(false);
    expect(onBack).toHaveBeenCalledTimes(1);
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
