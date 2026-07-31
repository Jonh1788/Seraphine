import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// O chat não tem `api.ts`: a "api" dele é o WebSocket compartilhado, que a tela
// pega pelo `useAppRefs()`. É esse módulo que o teste troca por um duplo, mais
// o `tasks/api` que o botão Concluir do cartão inline usa.
const h = vi.hoisted(() => ({ refs: { wsRef: { current: null as unknown } } }));
vi.mock('../../../stores/RefsContext', () => ({ useAppRefs: () => h.refs }));
vi.mock('../../../tasks/api', () => ({ updateTaskStatus: vi.fn() }));

import { updateTaskStatus } from '../../../tasks/api';
import { ChatScreen } from '../ChatScreen';

type Ouvinte = (m: unknown) => void;

/** Só a superfície do `SeraphineWS` que a tela usa: send/onMessage/onStatus. */
class FakeWS {
  enviadas: Record<string, unknown>[] = [];
  private msgs = new Set<Ouvinte>();
  private conns = new Set<(s: string) => void>();
  send(m: Record<string, unknown>) { this.enviadas.push(m); }
  onMessage(cb: Ouvinte) { this.msgs.add(cb); return () => { this.msgs.delete(cb); }; }
  onStatus(cb: (s: string) => void) { this.conns.add(cb); return () => { this.conns.delete(cb); }; }
  /** Empurra um quadro do servidor como o socket real empurraria. */
  emite(m: unknown) { act(() => { this.msgs.forEach((cb) => cb(m)); }); }
  conexao(s: 'connected' | 'disconnected') { act(() => { this.conns.forEach((cb) => cb(s)); }); }
}

function montar(props: Record<string, unknown> = {}) {
  const ws = new FakeWS();
  h.refs.wsRef.current = ws;
  return { ws, ...render(<ChatScreen {...props} />) };
}

/** Digita no composer e submete, como o teclado do iPhone faria. */
function escrever(container: HTMLElement, texto: string) {
  fireEvent.change(screen.getByPlaceholderText('Mensagem…'), { target: { value: texto } });
  fireEvent.submit(container.querySelector('form') as HTMLFormElement);
}

/** Uma resposta da Seraphine chegando por streaming. */
const token = (texto: string, turn = 't1') =>
  ({ type: 'token', conversation_id: 'c1', turn_id: turn, text: texto });

beforeEach(() => {
  h.refs.wsRef.current = null;
  vi.mocked(updateTaskStatus).mockReset();
  vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

describe('ChatScreen', () => {
  it('mostra a conversa com a bolha do usuário distinta da da Seraphine', () => {
    const { ws, container } = montar();
    escrever(container, 'me lembra de pagar o aluguel amanhã cedo');
    ws.emite(token('Feito! Lembrete pra amanhã às 08:00.'));

    expect(screen.getByText('me lembra de pagar o aluguel amanhã cedo')).toBeTruthy();
    expect(screen.getByText(/Feito! Lembrete pra amanhã/)).toBeTruthy();
    // As duas bolhas existem e NÃO compartilham a classe de variante — é ela que
    // pinta o usuário de accent à direita e deixa a Seraphine à esquerda.
    const voce = container.querySelector('.ms-chat-bolha--voce');
    const sera = container.querySelector('.ms-chat-bolha--sera');
    expect(voce).toBeTruthy();
    expect(sera).toBeTruthy();
    expect(voce!.className).not.toBe(sera!.className);
  });

  it('mostra estado vazio, não some, quando ainda não há mensagem', () => {
    montar();
    expect(screen.getByText(/ainda não trocamos/i)).toBeTruthy();
  });

  it('mostra erro quando o servidor devolve um quadro de erro', () => {
    const { ws } = montar();
    ws.emite({ type: 'error', code: 'llm_timeout', message: 'estourou o tempo' });
    const erro = screen.getByText(/não consegui responder/i);
    expect(erro).toBeTruthy();
    expect(erro.getAttribute('role')).toBe('alert');
  });

  it('mostra esqueleto sem texto enquanto o socket ainda não existe', () => {
    h.refs.wsRef.current = null;
    const { container } = render(<ChatScreen />);
    expect(container.querySelector('.ms-chat-skel')).toBeTruthy();
    expect(screen.queryByText(/ainda não trocamos/i)).toBeNull();
    expect(screen.queryByText(/em construção/i)).toBeNull();
  });

  it('desiste com erro em vez de esqueletar para sempre sem socket', () => {
    vi.useFakeTimers();
    h.refs.wsRef.current = null;
    const { container } = render(<ChatScreen />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText(/não consegui abrir a conversa/i)).toBeTruthy();
    expect(container.querySelector('.ms-chat-skel')).toBeNull();
  });

  it('o composer envia ao submeter e limpa o campo', () => {
    const { ws, container } = montar();
    escrever(container, 'e o orçamento, como tá?');
    expect(ws.enviadas).toHaveLength(1);
    expect(ws.enviadas[0].type).toBe('user_message');
    expect(ws.enviadas[0].content).toBe('e o orçamento, como tá?');
    expect((screen.getByPlaceholderText('Mensagem…') as HTMLInputElement).value).toBe('');
  });

  it('não envia mensagem em branco', () => {
    const { ws, container } = montar();
    escrever(container, '   ');
    expect(ws.enviadas).toHaveLength(0);
  });

  it('renderiza o cartão de tarefa inline e conclui pelo botão', async () => {
    const { ws } = montar();
    ws.emite(token('Feito! Também adicionei como tarefa.'));
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
      metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending', due_time: '08:00' } },
    });

    expect(screen.getByText('Pagar aluguel')).toBeTruthy();
    expect(screen.getByText(/08:00/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(updateTaskStatus).toHaveBeenCalledWith(7, 'completed'));
    await waitFor(() => expect(screen.getByText('Concluída')).toBeTruthy());
  });

  it('avisa quando não consegue concluir a tarefa do cartão', async () => {
    vi.mocked(updateTaskStatus).mockRejectedValue(new Error('rede'));
    const { ws } = montar();
    ws.emite(token('Adicionei como tarefa.'));
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
      metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending' } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.getByText(/não consegui concluir/i)).toBeTruthy());
  });

  it('renderiza a barra de orçamento inline com o quanto sobrou', () => {
    const { ws, container } = montar();
    ws.emite(token('No ritmo certo.'));
    ws.emite({
      type: 'tool_result', request_id: 'r2', ok: true, output: 'ok', error: null,
      metadata: { dashboard_data: { income: 3500, expenses: 2340, balance: 1160 } },
    });

    expect(screen.getByText('67% usado')).toBeTruthy();
    expect(screen.getByText(/1\.160/)).toBeTruthy();
    const barra = container.querySelector('.ms-chat-orc__fill') as HTMLElement;
    expect(barra.style.width).toBe('67%');
  });

  it('o mic do composer abre a tela de Voz', () => {
    const onOpen = vi.fn();
    montar({ onOpen });
    fireEvent.click(screen.getByRole('button', { name: /voz/i }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'voz', title: 'Voz' });
  });

  it('troca a presença por um alerta quando o socket cai', () => {
    const { ws } = montar();
    ws.conexao('connected');
    expect(screen.getByText(/ouvindo/i)).toBeTruthy();
    ws.conexao('disconnected');
    const alerta = screen.getByText(/sem conexão/i);
    expect(alerta.getAttribute('role')).toBe('alert');
    expect(screen.queryByText(/ouvindo/i)).toBeNull();
  });
});
