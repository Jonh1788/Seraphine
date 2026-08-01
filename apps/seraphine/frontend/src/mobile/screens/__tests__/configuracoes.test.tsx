import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Mockamos os MÓDULOS de api, não o `fetch` — mesmo motivo que a tela de
// Memória documenta: um mock de fetch sem `headers` faz o helper estourar e o
// teste do caminho feliz passaria pelo caminho de erro sem perceber.
vi.mock('../../../google/api', () => ({ getAuthStatus: vi.fn(), startOAuth: vi.fn() }));
vi.mock('../../../memory/api', () => ({ listFacts: vi.fn() }));
vi.mock('../../../notifications/api', () => ({
  getNotificationSettings: vi.fn(),
  setNotificationType: vi.fn(),
}));
vi.mock('../../../research/api', () => ({ getChatModel: vi.fn() }));
vi.mock('../../../whatsapp/api', () => ({ fetchWhatsappChats: vi.fn() }));

import { getAuthStatus, startOAuth } from '../../../google/api';
import { listFacts } from '../../../memory/api';
import { getNotificationSettings, setNotificationType } from '../../../notifications/api';
import type { NotificationSettings } from '../../../notifications/api';
import { getChatModel } from '../../../research/api';
import { fetchWhatsappChats } from '../../../whatsapp/api';
import { useChatStore } from '../../../stores/chatStore';
import { useRealtimeStore } from '../../../stores/realtimeStore';
import type { Fact } from '../../../memory/types';
import tauriConf from '../../../../src-tauri/tauri.conf.json';
import { ConfiguracoesScreen } from '../ConfiguracoesScreen';

const fato = (id: string): Fact => ({
  id,
  text: `fato ${id}`,
  source: 'reflection',
  confidence: 0.9,
  created_at: '2026-07-01T10:00:00Z',
  superseded_by: null,
  last_used_at: null,
});

const nFatos = (n: number): Fact[] => Array.from({ length: n }, (_, i) => fato(`f${i}`));

/** O que `GET /notifications/settings` devolve de verdade (defaults da 094). */
const prefs = (over: Partial<NotificationSettings> = {}): NotificationSettings => ({
  quiet_hours_start: '23:00',
  quiet_hours_end: '07:00',
  dnd_apps: [],
  batching_enabled: true,
  per_type_enabled: {
    water: true,
    reminder_timed: true,
    opener: true,
    insight: true,
    day_review: true,
    weekly_reflection: true,
    task_deadline: true,
    whatsapp_mention: true,
    stalled_task: true,
  },
  ...over,
});

/** Estado "tudo respondeu e tudo está ligado". */
function comDado(): void {
  vi.mocked(getNotificationSettings).mockResolvedValue(prefs());
  vi.mocked(setNotificationType).mockImplementation(async (atual, tipo, ligado) => ({
    ...atual,
    per_type_enabled: { ...atual.per_type_enabled, [tipo]: ligado },
  }));
  vi.mocked(getChatModel).mockResolvedValue({ chat_model: 'cliproxy' });
  vi.mocked(getAuthStatus).mockResolvedValue({
    authed: true,
    email: 'jonathan@gmail.com',
    scopes: [],
  });
  vi.mocked(fetchWhatsappChats).mockResolvedValue([]);
  vi.mocked(listFacts).mockResolvedValue(nFatos(42));
}

/** Espera as quatro leituras assentarem. Sem isto, um teste que só mexe em
 *  estado local termina com as promessas ainda em voo e o React reclama de
 *  `act(...)` — ruído que esconde aviso de verdade. */
const assentar = (): Promise<void> =>
  waitFor(() => { expect(screen.getByText('42 itens')).toBeTruthy(); });

describe('ConfiguracoesScreen', () => {
  beforeEach(() => {
    vi.mocked(getChatModel).mockReset();
    vi.mocked(getNotificationSettings).mockReset();
    vi.mocked(setNotificationType).mockReset();
    vi.mocked(getAuthStatus).mockReset();
    vi.mocked(startOAuth).mockReset();
    vi.mocked(fetchWhatsappChats).mockReset();
    vi.mocked(listFacts).mockReset();
    comDado();
    // Os três interruptores são estado de verdade em store global (singleton de
    // módulo): sem reset, o clique de um teste vaza para o próximo.
    useRealtimeStore.setState({ wakeWordEnabled: false });
    useChatStore.setState({ speak: true, think: false });
    try { localStorage.clear(); } catch { /* jsdom sempre tem, mas não custa */ }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── ESTADO 1: DADO ────────────────────────────────────────────────────────

  it('com dado, mostra os grupos, os valores lidos e a versão real', async () => {
    render(<ConfiguracoesScreen />);

    expect(screen.getByRole('heading', { name: 'Configurações' })).toBeTruthy();
    expect(screen.getByText('ASSISTENTE')).toBeTruthy();
    expect(screen.getByText('NOTIFICAÇÕES')).toBeTruthy();
    expect(screen.getByText('CONEXÕES')).toBeTruthy();
    expect(screen.getByText('DADOS')).toBeTruthy();

    // modelo: 'cliproxy' é o padrão do backend e lê como "Padrão"
    await waitFor(() => expect(screen.getByText('Padrão')).toBeTruthy());
    expect(screen.getByText('cliproxy ou OpenRouter')).toBeTruthy();

    // conexões: os dois selos saem de leitura real, não de literal
    const google = screen.getByText('Google Agenda').closest('.ms-config-linha')!;
    expect(google.textContent).toContain('conectado');
    expect(google.textContent).toContain('jonathan@gmail.com');
    const whats = screen.getByText('WhatsApp').closest('.ms-config-linha')!;
    expect(whats.textContent).toContain('conectado');

    // memória: a contagem é a da api, não o "42 itens" do mockup
    expect(screen.getByText('42 itens')).toBeTruthy();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── ESTADO 2: VAZIO ───────────────────────────────────────────────────────

  it('vazio desenha o que falta e NÃO é erro', async () => {
    vi.mocked(listFacts).mockResolvedValue([]);
    vi.mocked(getAuthStatus).mockResolvedValue({ authed: false, email: null, scopes: [] });
    render(<ConfiguracoesScreen />);

    await waitFor(() => expect(screen.getByText(/nenhum item guardado ainda/i)).toBeTruthy());
    const google = screen.getByText('Google Agenda').closest('.ms-config-linha')!;
    expect(google.textContent).toContain('não conectado');
    // desconectado é acionável de verdade: o botão existe porque startOAuth existe
    expect(screen.getByRole('button', { name: 'Conectar Google Agenda' })).toBeTruthy();

    // o vazio não pode ser anunciado como falha
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── ESTADO 3: ERRO ────────────────────────────────────────────────────────

  it('erro nomeia o que falhou num alerta só, e os interruptores continuam de pé', async () => {
    vi.mocked(getChatModel).mockRejectedValue(new Error('rede'));
    vi.mocked(getNotificationSettings).mockRejectedValue(new Error('HTTP 503'));
    vi.mocked(getAuthStatus).mockRejectedValue(new Error('rede'));
    vi.mocked(fetchWhatsappChats).mockRejectedValue(new Error('rede'));
    vi.mocked(listFacts).mockRejectedValue(new Error('rede'));
    render(<ConfiguracoesScreen />);

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    const alerta = screen.getByRole('alert');
    expect(alerta.textContent).toContain('modelo');
    expect(alerta.textContent).toContain('notificações');
    expect(alerta.textContent).toContain('Google Agenda');
    expect(alerta.textContent).toContain('WhatsApp');
    expect(alerta.textContent).toContain('memória');

    // nenhuma linha some por causa da falha
    expect(screen.getByText('Modelo')).toBeTruthy();
    expect(screen.getByText('Memória')).toBeTruthy();

    // e nada de selo verde: falha de rede não é "conectado"
    const google = screen.getByText('Google Agenda').closest('.ms-config-linha')!;
    expect(google.textContent).not.toContain('conectado');
    const whats = screen.getByText('WhatsApp').closest('.ms-config-linha')!;
    expect(whats.textContent).not.toContain('conectado');
    expect(whats.textContent).toContain('sem resposta da ponte');

    // o que é local não depende da rede
    fireEvent.click(screen.getByRole('switch', { name: 'Responder com voz' }));
    expect(useChatStore.getState().speak).toBe(false);
  });

  it('falha de uma fonte não contamina as outras', async () => {
    vi.mocked(getChatModel).mockRejectedValue(new Error('rede'));
    render(<ConfiguracoesScreen />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('modelo');
    expect(screen.getByRole('alert').textContent).not.toContain('memória');
    expect(screen.getByText('42 itens')).toBeTruthy();
  });

  // ── RISCO DISTINTIVO 1: a frase do wake word ──────────────────────────────

  // O handoff escreve "oi Sera". O classificador embarcado
  // (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`, limiar 0.92) foi treinado
  // em "Ei Seraphine": a string é contrato com o modelo, não texto de UI. Esta
  // é a tela onde a pessoa vai reler o que dizer — anunciar a frase errada
  // ensina um gesto que não aciona nada.
  it('anuncia "Ei Seraphine" e em lugar nenhum a frase do mockup', async () => {
    const { container } = render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('Padrão')).toBeTruthy());

    const tudo = container.textContent || '';
    expect(tudo).toContain('Ei Seraphine');
    expect(tudo).not.toMatch(/oi Sera/i);

    // as duas metades da linha: o nome que se lê e o rótulo que o VoiceOver dita
    const sw = screen.getByRole('switch', { name: 'Wake word "Ei Seraphine"' });
    expect(sw).toBeTruthy();
    expect(sw.getAttribute('aria-label')).not.toMatch(/oi Sera/i);
  });

  it('todo interruptor dita exatamente o nome que se vê', async () => {
    render(<ConfiguracoesScreen />);
    await assentar();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(4);
    for (const sw of switches) {
      const linha = sw.closest('.ms-config-linha')!;
      const nome = linha.querySelector('.ms-config-nome')!.textContent;
      expect(sw.getAttribute('aria-label')).toBe(nome);
    }
  });

  // ── os interruptores gravam onde o app lê ─────────────────────────────────

  it('cada interruptor escreve no estado que o app realmente consulta', async () => {
    render(<ConfiguracoesScreen />);
    await assentar();

    fireEvent.click(screen.getByRole('switch', { name: 'Wake word "Ei Seraphine"' }));
    expect(useRealtimeStore.getState().wakeWordEnabled).toBe(true);
    expect(localStorage.getItem('seraphine.wakeWord')).toBe('true');

    fireEvent.click(screen.getByRole('switch', { name: 'Responder com voz' }));
    expect(useChatStore.getState().speak).toBe(false);

    fireEvent.click(screen.getByRole('switch', { name: 'Pensar antes de responder' }));
    expect(useChatStore.getState().think).toBe(true);
  });

  it('o interruptor reflete o estado que já estava gravado', async () => {
    useRealtimeStore.setState({ wakeWordEnabled: true });
    useChatStore.setState({ speak: false, think: true });
    render(<ConfiguracoesScreen />);
    await assentar();

    expect(screen.getByRole('switch', { name: 'Wake word "Ei Seraphine"' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch', { name: 'Responder com voz' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Pensar antes de responder' }).getAttribute('aria-checked')).toBe('true');
  });

  // ── NOTIFICAÇÕES: o outro "proposta" do README que existe de verdade ──────

  // O README do handoff marca "Não perturbe" e "Lembretes" como proposta. Os
  // dois existem desde a 094 (`quiet_hours_*` e `per_type_enabled`), como
  // "Modelo" existia — mesmo erro, segunda ocorrência.
  it('mostra a janela real do Não perturbe e o interruptor real de Lembretes', async () => {
    render(<ConfiguracoesScreen />);

    await waitFor(() => expect(screen.getByText('23h – 7h')).toBeTruthy());
    const lembretes = screen.getByRole('switch', { name: 'Lembretes' });
    expect(lembretes.getAttribute('aria-checked')).toBe('true');
    expect(vi.mocked(getNotificationSettings)).toHaveBeenCalled();
  });

  it('a janela reflete o que está gravado, minuto quebrado inclusive', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      prefs({ quiet_hours_start: '22:30', quiet_hours_end: '06:45' }),
    );
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('22h30 – 6h45')).toBeTruthy());
  });

  it('sem janela gravada, diz que não há — e isso não é erro', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      prefs({ quiet_hours_start: '', quiet_hours_end: '' }),
    );
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('não definido')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('o interruptor de Lembretes grava pela camada que preserva os outros tipos', async () => {
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Lembretes' })).toBeTruthy());

    fireEvent.click(screen.getByRole('switch', { name: 'Lembretes' }));

    await waitFor(() => expect(vi.mocked(setNotificationType)).toHaveBeenCalledTimes(1));
    const [enviado, tipo, ligado] = vi.mocked(setNotificationType).mock.calls[0];
    expect(tipo).toBe('reminder_timed');
    expect(ligado).toBe(false);
    // o mapa inteiro vai junto — o backend SUBSTITUI `per_type_enabled`
    expect(Object.keys(enviado.per_type_enabled)).toContain('stalled_task');
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Lembretes' }).getAttribute('aria-checked')).toBe('false'),
    );
  });

  // Um interruptor que fica ligado sem ter sido salvo é a mentira mais cara
  // desta tela: da próxima vez que a pessoa abrir, ele estará como antes.
  it('PATCH que falha volta o interruptor e diz que não salvou', async () => {
    vi.mocked(setNotificationType).mockRejectedValue(new Error('HTTP 500'));
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Lembretes' })).toBeTruthy());

    fireEvent.click(screen.getByRole('switch', { name: 'Lembretes' }));

    await waitFor(() => expect(screen.getByText(/não consegui salvar/i)).toBeTruthy());
    expect(screen.getByRole('switch', { name: 'Lembretes' }).getAttribute('aria-checked')).toBe('true');
    // falha de salvar é da linha, não da tela: quem grita é o aviso do topo
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sem a chave do tipo no payload, não inventa interruptor', async () => {
    vi.mocked(getNotificationSettings).mockResolvedValue(
      prefs({ per_type_enabled: { water: true } }),
    );
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('23h – 7h')).toBeTruthy());

    expect(screen.queryByRole('switch', { name: 'Lembretes' })).toBeNull();
    expect(screen.getByText('Lembretes')).toBeTruthy();
    expect(screen.getByText(/este backend não expõe/i)).toBeTruthy();
  });

  it('leitura das preferências que falha não desenha interruptor nenhum', async () => {
    vi.mocked(getNotificationSettings).mockRejectedValue(new Error('HTTP 503'));
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    expect(screen.queryByRole('switch', { name: 'Lembretes' })).toBeNull();
    expect(screen.queryByText('23h – 7h')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('notificações');
  });

  // ── RISCO DISTINTIVO 2: "Modelo" não é proposta ───────────────────────────

  it('a linha Modelo abre o seletor e mostra o modelo salvo quando não é o padrão', async () => {
    vi.mocked(getChatModel).mockResolvedValue({ chat_model: 'openrouter:anthropic/claude-sonnet-4' });
    const onOpen = vi.fn();
    render(<ConfiguracoesScreen onOpen={onOpen} />);

    await waitFor(() => expect(screen.getByText('openrouter:anthropic/claude-sonnet-4')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Modelo/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'seletor-modelo' }));
  });

  // `/memory/facts` devolve LISTA, não contagem: com a lista no teto, "N itens"
  // afirmaria um total que a resposta não sustenta.
  it('contagem no teto do pedido vira "N+", não um total inventado', async () => {
    vi.mocked(listFacts).mockImplementation(async (params) => nFatos(params?.limit ?? 0));
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText(/\d+\+ itens/)).toBeTruthy());
  });

  it('a linha Memória abre a tela de memória', async () => {
    const onOpen = vi.fn();
    render(<ConfiguracoesScreen onOpen={onOpen} />);
    await waitFor(() => expect(screen.getByText('42 itens')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /^Memória/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: 'memoria' }));
  });

  it('sem onOpen as linhas de destino não aparecem como botão morto', async () => {
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('42 itens')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Modelo/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Memória/ })).toBeNull();
    // mas o dado continua legível
    expect(screen.getByText('Modelo')).toBeTruthy();
    expect(screen.getByText('Padrão')).toBeTruthy();
  });

  // ── RISCO DISTINTIVO 3: a versão ──────────────────────────────────────────

  it('o rodapé traz a versão do tauri.conf.json, não o literal do mockup', async () => {
    const { container } = render(<ConfiguracoesScreen />);
    await assentar();
    expect(screen.getByText(`Seraphine ${tauriConf.version}`)).toBeTruthy();
    expect(container.textContent).not.toContain('2.4.0');
  });

  // ── RISCO DISTINTIVO 4: o que NÃO tem estado por trás não é desenhado ─────

  it('não desenha controle sem estado por trás', async () => {
    const { container } = render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('Padrão')).toBeTruthy());
    const tudo = container.textContent || '';

    for (const ausente of [
      'Personalidade',        // não existe nada de persona no backend nem no front
      'Calorosa',
      'Streak em risco',      // não existe nem no backend: sem chave em per_type_enabled
      'YouTube Music',        // não há vínculo de conta: é AppleScript no Chrome do Mac
      'Apagar histórico',     // não há DELETE de conversas no backend
      'Sincronizado com o Mac',
    ]) {
      expect(tudo).not.toContain(ausente);
    }
  });

  // ── carregamento é esqueleto, nunca valor chutado ────────────────────────

  it('enquanto lê, mostra esqueleto sem texto — não pisca "conectado"', () => {
    const nunca = () => new Promise<never>(() => {});
    vi.mocked(getChatModel).mockImplementation(nunca);
    vi.mocked(getNotificationSettings).mockImplementation(nunca);
    vi.mocked(getAuthStatus).mockImplementation(nunca);
    vi.mocked(fetchWhatsappChats).mockImplementation(nunca);
    vi.mocked(listFacts).mockImplementation(nunca);

    const { container } = render(<ConfiguracoesScreen />);
    const tudo = container.textContent || '';
    expect(tudo).not.toContain('conectado');
    expect(tudo).not.toContain('Padrão');
    expect(tudo).not.toContain('itens');

    // Um interruptor desenhado antes de saber o próprio estado mostraria
    // "desligado" — os três daqui são locais e já sabem; o de Lembretes não.
    expect(screen.getAllByRole('switch')).toHaveLength(3);
    expect(tudo).not.toContain('23h');

    // Contar interruptores não basta: tirar o ramo de esqueleto faz a linha
    // cair no ramo de "chave ausente" e ANUNCIAR uma indisponibilidade que
    // ainda não se sabe se existe. Enquanto lê, a linha diz só o próprio nome.
    for (const nome of ['Lembretes', 'Não perturbe']) {
      const linha = screen.getByText(nome).closest('.ms-config-linha')!;
      expect(`${nome}: ${linha.textContent}`).toBe(`${nome}: ${nome}`);
      expect(linha.querySelector('.ms-config-skel')).toBeTruthy();
    }

    const skels = container.querySelectorAll('.ms-config-skel');
    expect(skels.length).toBeGreaterThan(0);
    for (const s of skels) expect(s.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // ── conectar o Google é ação de verdade ──────────────────────────────────

  it('conectar o Google pede o consentimento real e abre a url que voltou', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue({ authed: false, email: null, scopes: [] });
    vi.mocked(startOAuth).mockResolvedValue({ consent_url: 'https://accounts.google.com/o/oauth2/x' });
    const abrir = vi.fn();
    vi.stubGlobal('open', abrir);

    render(<ConfiguracoesScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google Agenda' }));

    await waitFor(() => expect(vi.mocked(startOAuth)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(abrir).toHaveBeenCalled());
    expect(abrir.mock.calls[0][0]).toBe('https://accounts.google.com/o/oauth2/x');
    vi.unstubAllGlobals();
  });

  // O consentimento acontece FORA do app (Safari). Voltar para a Seraphine é o
  // sinal de que vale reler o estado — e o ouvinte tem de morrer com a tela.
  it('reler ao voltar para o app, e parar de reler depois de desmontada', async () => {
    const { unmount } = render(<ConfiguracoesScreen />);
    await waitFor(() => expect(vi.mocked(getAuthStatus)).toHaveBeenCalledTimes(1));

    fireEvent.focus(window);
    await waitFor(() => expect(vi.mocked(getAuthStatus)).toHaveBeenCalledTimes(2));

    unmount();
    fireEvent.focus(window);
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(getAuthStatus)).toHaveBeenCalledTimes(2);
  });

  // ── voltar ────────────────────────────────────────────────────────────────

  it('tem o voltar do handoff e chama onBack', async () => {
    const onBack = vi.fn();
    render(<ConfiguracoesScreen onBack={onBack} />);
    await assentar();
    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    render(<ConfiguracoesScreen />);
    await waitFor(() => expect(screen.getByText('Padrão')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  // ── o CSS é dono do alvo de toque e do prefixo ───────────────────────────

  describe('CSS da tela', () => {
    const lerCss = (): string => readFileSync(resolve(__dirname, '../ConfiguracoesScreen.css'), 'utf8');

    /** O corpo `{...}` da regra cujo seletor TERMINA exatamente em `sel` — com
     *  `indexOf` cru, pedir `.ms-config-switch` casaria antes com
     *  `.ms-config-switch__bola` e o teste leria o bloco errado. */
    const blocoDe = (sel: string): string => {
      const css = lerCss();
      const i = css.indexOf(`${sel} {`);
      if (i === -1) return '';
      const abre = css.indexOf('{', i);
      const fecha = css.indexOf('}', abre);
      return abre === -1 || fecha === -1 ? '' : css.slice(abre, fecha);
    };

    // jsdom não faz layout: o que dá para afirmar é a cascata, como o
    // `alvo-de-toque.test.tsx` do shell já afirma para o ‹ de Voltar. Os
    // controles pequenos desta tela (interruptor 44×26, botão de conectar)
    // ficam abaixo de 44pt de ALTURA; quem garante o dedo é um pseudo.
    it('garante 44×44 nos controles menores que isso', () => {
      for (const sel of ['.ms-config-switch::after', '.ms-config-botao::after']) {
        const bloco = blocoDe(sel);
        expect(`${sel}: ${bloco ? 'existe' : 'ausente'}`).toBe(`${sel}: existe`);
        expect(bloco).toMatch(/position:\s*absolute/);
        expect(bloco).toMatch(/width:\s*44px/);
        expect(bloco).toMatch(/height:\s*44px/);
      }
    });

    it('toda classe e todo keyframe levam o prefixo da tela', () => {
      const css = lerCss();
      const meu = (n: string): boolean => n === 'ms-config' || n.startsWith('ms-config-');
      for (const [, nome] of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        expect(`classe ${nome}`).toBe(`classe ${meu(nome) ? nome : 'ms-config-' + nome}`);
      }
      for (const [, nome] of css.matchAll(/@keyframes\s+([\w-]+)/g)) {
        expect(`keyframe ${nome}`).toBe(`keyframe ${meu(nome) ? nome : 'ms-config-' + nome}`);
      }
    });

    it('as medidas do handoff estão no CSS, não inventadas', () => {
      expect(blocoDe('.ms-config-switch')).toMatch(/width:\s*44px/);
      expect(blocoDe('.ms-config-switch')).toMatch(/height:\s*26px/);
      expect(blocoDe('.ms-config-switch__bola')).toMatch(/width:\s*22px/);
      expect(blocoDe('.ms-config-divisoria')).toMatch(/margin-left:\s*57px/);
      expect(blocoDe('.ms-config-card')).toMatch(/border-radius:\s*18px/);
      expect(blocoDe('.ms-config-icone')).toMatch(/border-radius:\s*9px/);
      expect(blocoDe('.ms-config-grupo-rotulo')).toMatch(/letter-spacing:\s*0?\.06em/);
    });
  });
});
