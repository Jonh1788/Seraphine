import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um mock de fetch com `{ ok, json }`
// sem `headers` faz helpers que leem `res.headers.get(...)` estourarem, e o
// teste passaria pelo caminho de erro achando que testou o feliz.
vi.mock('../../../inbox/api', () => ({ listWhatsAppMessages: vi.fn() }));

import { listWhatsAppMessages } from '../../../inbox/api';
import type { WhatsAppMessage } from '../../../inbox/types';
import { WhatsAppThreadScreen } from '../WhatsAppThreadScreen';

const CHAT = '5511999999999@c.us';

const msg = (over: Partial<WhatsAppMessage> = {}): WhatsAppMessage => ({
  id: 'm1',
  body: 'confirmado o jantar hoje?',
  fromMe: false,
  at: '2026-07-31T22:32:00.000Z',
  ...over,
});

const conversa = (): WhatsAppMessage[] => [
  msg(),
  msg({ id: 'm2', body: 'Confirmadíssimo! 19h no lugar de sempre', fromMe: true, at: '2026-07-31T22:34:00.000Z' }),
  msg({ id: 'm3', body: 'perfeito!! te vejo lá', at: '2026-07-31T22:35:00.000Z' }),
];

const bolhas = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.ms-whatsapp-bolha'));

describe('WhatsAppThreadScreen', () => {
  beforeEach(() => {
    vi.mocked(listWhatsAppMessages).mockReset().mockResolvedValue([]);
  });

  it('mostra a conversa que o id do shell aponta', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    render(<WhatsAppThreadScreen id={CHAT} />);

    await waitFor(() => expect(screen.getByText('confirmado o jantar hoje?')).toBeTruthy());
    expect(screen.getByText('Confirmadíssimo! 19h no lugar de sempre')).toBeTruthy();
    expect(screen.getByText('perfeito!! te vejo lá')).toBeTruthy();
  });

  // O `id` do ScreenProps é o contrato do shell para dizer QUAL conversa abrir
  // (PhoneShell repassa cru o que veio no `onOpen`). Se a tela ignorasse o
  // campo, abriria a conversa errada — ou nenhuma.
  it('o id recebido é o chat pedido à api, e só ele', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    render(<WhatsAppThreadScreen id={CHAT} />);

    await waitFor(() => expect(vi.mocked(listWhatsAppMessages)).toHaveBeenCalledWith(CHAT));
    expect(vi.mocked(listWhatsAppMessages)).toHaveBeenCalledTimes(1);
    // sem nome vindo do shell, o cabeçalho mostra o número do próprio id —
    // nunca um nome inventado
    expect(screen.getByText('5511999999999')).toBeTruthy();
  });

  it('enviada e recebida têm classes distintas, não só cor', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(bolhas(container).length).toBe(3));

    const [recebida, enviada] = bolhas(container);
    expect(recebida.classList.contains('ms-whatsapp-bolha--recebida')).toBe(true);
    expect(recebida.classList.contains('ms-whatsapp-bolha--enviada')).toBe(false);
    expect(enviada.classList.contains('ms-whatsapp-bolha--enviada')).toBe(true);
    expect(enviada.classList.contains('ms-whatsapp-bolha--recebida')).toBe(false);
  });

  it('mostra estado vazio, não some, quando a conversa não tem mensagem', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue([]);
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText(/nenhuma mensagem nesta conversa/i)).toBeTruthy());
    // vazio é vazio, nunca erro: o alerta é reservado para falha de verdade
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('mostra erro quando a api falha', async () => {
    vi.mocked(listWhatsAppMessages).mockRejectedValue(new Error('rede'));
    render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar esta conversa/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar esta conversa/i).getAttribute('role')).toBe('alert');
  });

  it('enquanto carrega mostra esqueleto sem texto, sem piscar "sem mensagem"', async () => {
    vi.mocked(listWhatsAppMessages).mockReturnValue(new Promise(() => {}));
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    expect(container.querySelector('.ms-whatsapp-skel-bolhas')).toBeTruthy();
    expect(screen.queryByText(/nenhuma mensagem nesta conversa/i)).toBeNull();
    expect(screen.queryByText(/não consegui carregar/i)).toBeNull();
  });

  // `id` é opcional no ScreenProps e `undefined` é caso real (quem empurra pode
  // não mandar). Sem id não há conversa possível: a tela tem de DIZER isso, não
  // ficar branca nem chutar um chat.
  it('sem id avisa em vez de chamar a api ou ficar em branco', async () => {
    render(<WhatsAppThreadScreen />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/qual conversa/i);
    expect(vi.mocked(listWhatsAppMessages)).not.toHaveBeenCalled();
  });

  // `inbox/api.ts` ordena por data ascendente tratando `at: ''` como 0, o que
  // joga a mensagem sem data para o TOPO — a posição de "mais antiga da
  // conversa", que o dado não sustenta. A tela a mantém no fim.
  it('mensagem sem data fica no fim da thread, não no topo', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue([
      msg({ id: 'sem', body: 'mensagem sem data', at: '' }),
      msg({ id: 'a', body: 'primeira de verdade', at: '2026-07-31T22:32:00.000Z' }),
      msg({ id: 'b', body: 'segunda de verdade', at: '2026-07-31T22:34:00.000Z' }),
    ]);
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(bolhas(container).length).toBe(3));

    const textos = bolhas(container).map((b) => b.textContent ?? '');
    expect(textos[0]).toContain('primeira de verdade');
    expect(textos[1]).toContain('segunda de verdade');
    expect(textos[2]).toContain('mensagem sem data');
  });

  // O dado não distingue o que a Seraphine mandou por você do que você mesmo
  // mandou (`fromMe` é o mesmo para os dois): o selo não pode aparecer em
  // mensagem comum, senão rotula errado.
  it('não carimba "enviada pela Seraphine" em mensagem comum', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText('Confirmadíssimo! 19h no lugar de sempre')).toBeTruthy());
    expect(screen.queryByText(/enviada pela Seraphine/i)).toBeNull();
  });

  // O bridge nunca manda `ack` (routes/messages.ts mapeia só id/body/timestamp/
  // fromMe): um check sempre aceso mentiria que a mensagem chegou.
  it('não inventa estado de entrega nas enviadas', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(bolhas(container).length).toBe(3));
    expect(container.querySelector('.ms-whatsapp-ack')).toBeNull();
    expect(screen.queryByLabelText(/entregue|lida|enviada/i)).toBeNull();
  });

  it('mostra a hora da mensagem e um travessão quando não há data', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue([
      msg({ id: 'a', body: 'com data', at: '2026-07-31T22:32:00.000Z' }),
      msg({ id: 'sem', body: 'sem data', at: '' }),
    ]);
    const { container } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(bolhas(container).length).toBe(2));

    const horas = Array.from(container.querySelectorAll('.ms-whatsapp-hora')).map((h) => h.textContent);
    expect(horas[0]).toMatch(/^\d{2}:\d{2}$/);
    expect(horas[1]).toBe('—');
  });

  // Tela empurrada desenha o próprio cabeçalho: sem a seta, quem entra fica preso.
  it('tem o voltar do handoff e chama onBack ao tocar', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    const onBack = vi.fn();
    render(<WhatsAppThreadScreen id={CHAT} onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText('confirmado o jantar hoje?')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  // Nenhuma camada expõe envio ao app (o backend proxia só GETs de
  // status/qr/chats/messages): o composer aparece, mas desligado e dizendo por
  // quê — botão que finge enviar é pior que botão desabilitado.
  it('o composer aparece desligado e explica por quê', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText('confirmado o jantar hoje?')).toBeTruthy());

    const enviar = screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement;
    expect(enviar.disabled).toBe(true);
    expect((screen.getByLabelText(/mensagem/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/ainda não dá para responder por aqui/i)).toBeTruthy();
  });

  // Task 28 (minor acumulado da onda): a tese desta tela é não afirmar o que a
  // fonte não entrega, e ela a violava numa palavra. `inbox/api.ts:203-210`
  // descarta `hasMedia`/`type`, então corpo vazio é corpo vazio — pode ser áudio,
  // figurinha, ou uma mensagem apagada. Só "sem texto" é verdade.
  it('mensagem sem corpo diz que não tem texto, sem chamar de mídia', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue([msg({ id: 'm9', body: '' })]);
    render(<WhatsAppThreadScreen id={CHAT} />);

    await waitFor(() => expect(screen.getByText('sem texto')).toBeTruthy());
    expect(screen.queryByText(/mídia/i)).toBeNull();
  });

  it('troca de conversa recarrega a thread', async () => {
    vi.mocked(listWhatsAppMessages).mockResolvedValue(conversa());
    const { rerender } = render(<WhatsAppThreadScreen id={CHAT} />);
    await waitFor(() => expect(screen.getByText('confirmado o jantar hoje?')).toBeTruthy());

    vi.mocked(listWhatsAppMessages).mockResolvedValue([msg({ id: 'z', body: 'oi do outro chat' })]);
    rerender(<WhatsAppThreadScreen id="5511888888888@c.us" />);
    await waitFor(() => expect(screen.getByText('oi do outro chat')).toBeTruthy());
    expect(vi.mocked(listWhatsAppMessages)).toHaveBeenLastCalledWith('5511888888888@c.us');
  });
});
