import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: `inbox/api.ts` compõe duas fontes
// (Gmail + bridge do WhatsApp) e um mock de fetch com `{ ok, json }` cru cairia
// no caminho de erro parecendo caminho feliz.
vi.mock('../../../inbox/api', () => ({
  listInboxDetailed: vi.fn(),
  listWhatsAppMessages: vi.fn(),
}));

import { listInboxDetailed } from '../../../inbox/api';
import type { InboxItem, InboxLoadResult } from '../../../inbox/types';
import { InboxScreen } from '../InboxScreen';

const email = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: 'm1',
  source: 'email',
  sender: 'GitHub <noreply@github.com>',
  preview: 'PR #142 aprovado — pronto pra merge',
  at: '2026-03-05T12:00:00Z',
  unread: true,
  ...over,
});

const zap = (over: Partial<InboxItem> = {}): InboxItem => ({
  id: '5511@c.us',
  source: 'whatsapp',
  sender: 'Ana',
  preview: 'confirmado o jantar hoje?',
  at: '2026-03-05T12:00:00Z',
  unread: true,
  ...over,
});

const ok = (items: InboxItem[]): InboxLoadResult => ({ items, errors: [] });

describe('InboxScreen', () => {
  beforeEach(() => {
    vi.mocked(listInboxDetailed).mockReset().mockResolvedValue(ok([]));
  });

  it('lista os dois canais com remetente, prévia e hora', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap(), email()]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    // o `From` do Gmail vem como "Nome <email>"; a linha mostra só o nome
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(screen.getByText('confirmado o jantar hoje?')).toBeTruthy();
    expect(screen.getByText('PR #142 aprovado — pronto pra merge')).toBeTruthy();
    // data antiga → dia/mês; hoje → hora:minuto (testado abaixo)
    expect(screen.getAllByText('05/03')).toHaveLength(2);
    expect(screen.getByText('2 não lidas')).toBeTruthy();
  });

  it('mostra hora:minuto quando a mensagem é de hoje', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap({ at: new Date().toISOString() })]));
    const { container } = render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    expect(container.querySelector('.ms-inbox-hora')?.textContent).toMatch(/^\d{2}:\d{2}$/);
  });

  it('mostra estado vazio, não some, quando não há nada na caixa', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText(/nenhum e-mail importante nem mensagem/i)).toBeTruthy());
  });

  it('mostra erro quando as duas fontes falham', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue({
      items: [],
      errors: [
        { source: 'email', message: 'HTTP 500' },
        { source: 'whatsapp', message: 'HTTP 502' },
      ],
    });
    render(<InboxScreen />);
    const erro = await screen.findByText(/não consegui carregar sua inbox/i);
    expect(erro.getAttribute('role')).toBe('alert');
  });

  it('mostra erro quando a api inteira rejeita', async () => {
    vi.mocked(listInboxDetailed).mockRejectedValue(new Error('rede'));
    render(<InboxScreen />);
    const erro = await screen.findByText(/não consegui carregar sua inbox/i);
    expect(erro.getAttribute('role')).toBe('alert');
  });

  // As duas direções da falha parcial: um nome de fonte fixo no código passaria
  // num sentido e mentiria no outro.
  it('WhatsApp fora do ar: mostra os e-mails E avisa qual fonte caiu', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue({
      items: [email()],
      errors: [{ source: 'whatsapp', message: 'HTTP 502' }],
    });
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('GitHub')).toBeTruthy());
    const aviso = screen.getByRole('alert');
    expect(aviso.textContent).toMatch(/whatsapp/i);
    expect(aviso.textContent).not.toMatch(/e-mail/i);
  });

  it('e-mail fora do ar: mostra o WhatsApp E avisa qual fonte caiu', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue({
      items: [zap()],
      errors: [{ source: 'email', message: 'HTTP 500' }],
    });
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    const aviso = screen.getByRole('alert');
    expect(aviso.textContent).toMatch(/e-mail/i);
    expect(aviso.textContent).not.toMatch(/whatsapp/i);
  });

  // As duas asserções vão no MESMO `waitFor`: durante o recarregamento a lista
  // vira esqueleto e "Ana" some sozinha, então esperar só pelo sumiço passaria
  // mesmo sem filtro nenhum. O que prova a filtragem é o estado em que o e-mail
  // está na tela E o WhatsApp não.
  it('o filtro E-mail remove as linhas de WhatsApp', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap(), email()]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'E-mail' }));
    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeTruthy();
      expect(screen.queryByText('Ana')).toBeNull();
    });
    // e a api é chamada só com a fonte pedida (não busca WhatsApp à toa)
    expect(vi.mocked(listInboxDetailed)).toHaveBeenCalledWith('email');
  });

  it('o filtro WhatsApp remove as linhas de e-mail', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap(), email()]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('GitHub')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }));
    await waitFor(() => {
      expect(screen.getByText('Ana')).toBeTruthy();
      expect(screen.queryByText('GitHub')).toBeNull();
    });
    expect(vi.mocked(listInboxDetailed)).toHaveBeenCalledWith('whatsapp');
  });

  it('item lido não mostra o ponto de não-lido e vem esmaecido', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([
      zap(),
      email({ sender: 'Nubank', preview: 'Fatura de junho fechada', unread: false }),
    ]));
    const { container } = render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Nubank')).toBeTruthy());
    expect(container.querySelectorAll('.ms-inbox-ponto')).toHaveLength(1);
    const lida = container.querySelector('.ms-inbox-row--lida');
    expect(lida?.textContent).toContain('Nubank');
    expect(lida?.querySelector('.ms-inbox-ponto')).toBeNull();
  });

  it('tocar numa linha do WhatsApp abre a conversa', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap()]));
    const onOpen = vi.fn();
    render(<InboxScreen onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'whatsapp', title: 'Ana' });
  });

  it('o card da Seraphine oferece responder e o Sim abre a conversa', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap()]));
    const onOpen = vi.fn();
    render(<InboxScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText(/respondo a Ana/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'whatsapp', title: 'Ana' });
  });

  it('o card da Seraphine não some quando não há nada para responder', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([email()]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText(/nada aguardando resposta/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Sim' })).toBeNull();
  });

  it('marcar tudo como lido apaga os pontos', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap(), email()]));
    const { container } = render(<InboxScreen />);
    await waitFor(() => expect(container.querySelectorAll('.ms-inbox-ponto')).toHaveLength(2));
    fireEvent.click(screen.getByLabelText('Marcar tudo como lido'));
    await waitFor(() => expect(container.querySelectorAll('.ms-inbox-ponto')).toHaveLength(0));
  });

  // O shell deixou de desenhar chrome (PushedScreen virou só corpo): sem a seta
  // aqui, quem entra na Inbox fica preso na tela.
  it('tem o voltar e chama onBack ao tocar', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap()]));
    const onBack = vi.fn();
    render(<InboxScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([zap()]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  it('enquanto carrega mostra esqueleto e nenhum texto de vazio', () => {
    vi.mocked(listInboxDetailed).mockReturnValue(new Promise(() => {}));
    const { container } = render(<InboxScreen />);
    expect(container.querySelectorAll('.ms-inbox-skel-linha').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nenhum e-mail importante/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // `InboxItem.id` só é único DENTRO da fonte: a chave da lista é `fonte:id`.
  it('dois itens de fontes diferentes com o mesmo id convivem na lista', async () => {
    const aviso = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(listInboxDetailed).mockResolvedValue(ok([
      zap({ id: 'x1', sender: 'Ana' }),
      email({ id: 'x1', sender: 'GitHub' }),
    ]));
    render(<InboxScreen />);
    await waitFor(() => expect(screen.getByText('Ana')).toBeTruthy());
    expect(screen.getByText('GitHub')).toBeTruthy();
    expect(aviso.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/i);
    aviso.mockRestore();
  });
});
