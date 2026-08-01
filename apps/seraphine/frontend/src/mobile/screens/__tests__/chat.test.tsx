import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// O chat não tem `api.ts`: a "api" dele é o WebSocket compartilhado, que a tela
// pega pelo `useAppRefs()`. É esse módulo que o teste troca por um duplo, mais
// o `tasks/api` que o botão Concluir do cartão inline usa.
const h = vi.hoisted(() => ({ refs: { wsRef: { current: null as unknown } } }));
vi.mock('../../../stores/RefsContext', () => ({ useAppRefs: () => h.refs }));
vi.mock('../../../tasks/api', () => ({ updateTaskStatus: vi.fn() }));
vi.mock('../../../chat/api', () => ({ fetchConversationTurns: vi.fn() }));

import { updateTaskStatus } from '../../../tasks/api';
import { fetchConversationTurns } from '../../../chat/api';
import { useRealtimeStore } from '../../../stores/realtimeStore';
import { ChatScreen } from '../ChatScreen';

/** A chave onde o id da conversa mora — a mesma que o desktop usa. */
const CONV_KEY = 'seraphine_conversation_id';

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

/** Um `tool_result` de sucesso com a metadata pedida. */
const ferramentaOk = (metadata: unknown, req = 'r1') =>
  ({ type: 'tool_result', request_id: req, ok: true, output: 'ok', error: null, metadata });

/**
 * O cartão de clima como o backend o monta — `<!--card-->` + classes `rich-card*`
 * (`seraphine/tools/weather.py:310`, `build_weather_html`). Vem PRONTO em
 * `metadata.html_card`; não há componente React nenhum do outro lado.
 * O `style="flex:1"` do div do meio está aqui de propósito: é o único atributo
 * de estilo que o backend emite, e o saneador tem de derrubá-lo.
 */
const CARTAO_CLIMA = '<!--card--><div class="rich-card rich-card--weather">'
  + '<div class="rich-card__header">'
  + '<div class="rich-card__icon rich-card__icon--weather">'
  + '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"'
  + ' fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/></svg>'
  + '</div>'
  + '<div style="flex:1">'
  + '<div class="rich-card__title">Ilhéus</div>'
  + '<div class="rich-card__subtitle">Parcialmente nublado · Sensação 30°C</div>'
  + '</div>'
  + '<div class="rich-card__big-value clr-warm">28°</div>'
  + '</div>'
  + '<hr class="rich-card__divider">'
  + '<div class="rich-card__section">Previsão</div>'
  + '<div class="rich-card__item">'
  + '<div class="rich-card__item-body"><div class="rich-card__item-title">Seg 13/04</div></div>'
  + '<div class="rich-card__item-value"><span class="clr-cool">21°</span></div>'
  + '</div>'
  + '</div><!--/card-->';

/** O título do estado vazio do handoff (tela 19), que a Task 28 embutiu aqui. */
const TITULO_VAZIO = 'Sobre o que a gente conversa primeiro?';

beforeEach(() => {
  h.refs.wsRef.current = null;
  localStorage.clear();
  vi.mocked(updateTaskStatus).mockReset();
  vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
  vi.mocked(fetchConversationTurns).mockReset();
  vi.mocked(fetchConversationTurns).mockResolvedValue([]);
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
    expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
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
    expect(screen.queryByText(TITULO_VAZIO)).toBeNull();
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

  // O engine corta o stream de tokens no primeiro pedaço que traz `tool_calls`
  // (`conversation/engine.py:1122`): quando o modelo vai DIRETO à ferramenta, o
  // `tool_result` chega sem nenhum `token` antes dele. É o próprio caso do
  // handoff — "Feito! ... Também adicionei como tarefa" é texto pós-ferramenta.
  it('mostra o cartão quando a ferramenta roda antes de ela falar', () => {
    const { ws } = montar();
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
      metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending', due_time: '08:00' } },
    });
    expect(screen.getByText('Pagar aluguel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
  });

  it('o texto que vem depois da ferramenta entra na MESMA bolha do cartão', () => {
    const { ws, container } = montar();
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
      metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending' } },
    });
    ws.emite(token('Feito! Também adicionei como tarefa.'));

    const falas = container.querySelectorAll('.ms-chat-linha--sera');
    expect(falas).toHaveLength(1);
    expect(falas[0].textContent).toContain('Feito! Também adicionei como tarefa.');
    expect(falas[0].textContent).toContain('Pagar aluguel');
  });

  it('o cartão não gruda na resposta anterior: entra depois da pergunta nova', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockResolvedValue([
      { id: 't0', conversation_id: 'conv-1', role: 'assistant', content: 'resposta de ontem', created_at: '2026-07-30T10:00:00' },
    ]);
    const { ws, container } = montar();
    await screen.findByText('resposta de ontem');

    escrever(container, 'me lembra do aluguel');
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
      metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending' } },
    });

    const linhas = [...container.querySelectorAll('.ms-chat-linha')];
    const daPergunta = linhas.findIndex((l) => l.textContent?.includes('me lembra do aluguel'));
    const doCartao = linhas.findIndex((l) => l.textContent?.includes('Pagar aluguel'));
    expect(daPergunta).toBeGreaterThanOrEqual(0);
    // O cartão vem DEPOIS da pergunta que o gerou, nunca colado na fala de ontem.
    expect(doCartao).toBeGreaterThan(daPergunta);
    expect(linhas[0].textContent).toContain('resposta de ontem');
    expect(linhas[0].textContent).not.toContain('Pagar aluguel');
  });

  it('deixa rastro quando a ferramenta falha, em vez de engolir', () => {
    const { ws } = montar();
    ws.emite(token('Deixa comigo.'));
    ws.emite({
      type: 'tool_result', request_id: 'r1', ok: false, output: null,
      error: 'agenda fora do ar', metadata: null,
    });
    const rastro = screen.getByText(/agenda fora do ar/i);
    expect(rastro.getAttribute('role')).toBe('alert');
  });

  it('não edita o texto do usuário: colchetes dele são dele', () => {
    const { ws, container } = montar();
    escrever(container, 'me manda o [array] em JSON');
    expect(screen.getByText('me manda o [array] em JSON')).toBeTruthy();
    expect(ws.enviadas[0].content).toBe('me manda o [array] em JSON');
  });

  it('mês estourado não diz que sobrou dinheiro', () => {
    const { ws } = montar();
    ws.emite(token('Passou.'));
    ws.emite({
      type: 'tool_result', request_id: 'r2', ok: true, output: 'ok', error: null,
      metadata: { dashboard_data: { income: 3000, expenses: 3340, balance: -340 } },
    });
    expect(screen.getByText(/R\$ 340 acima/)).toBeTruthy();
    expect(screen.queryByText(/livre/)).toBeNull();
    expect(screen.queryByText(/-340/)).toBeNull();
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

  // O Chat é as DUAS coisas: aba (a tab bar é a saída, e o handoff não desenha
  // seta) e alvo de push — as Finanças o abrem com `onOpen({key:'chat'})`, e o
  // ramo empurrado do PhoneShell não monta tab bar nenhuma. O `PushedScreen`
  // não desenha mais chrome, então sem seta própria a tela é beco sem saída.
  // `onBack` só chega no ramo empurrado: é ele que separa os dois casos.
  it('empurrada: tem exatamente um voltar, e ele chama o onBack', () => {
    const onBack = vi.fn();
    montar({ onBack });
    const voltas = screen.getAllByRole('button', { name: 'Voltar' });
    expect(voltas).toHaveLength(1);
    fireEvent.click(voltas[0]);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('na aba: nenhum voltar — quem tira dali é a tab bar', () => {
    montar();
    expect(screen.queryAllByRole('button', { name: 'Voltar' })).toHaveLength(0);
  });

  it('empurrada: não repete a compensação de padding do contêiner de aba', () => {
    // `.mshell__content` tem padding (12px + safe-area, 16px nas laterais) e a
    // tela o cancela com margem negativa. `.mpushed__body` não tem nenhum
    // desses: a mesma conta passaria 12px por cima do notch e vazaria 16px
    // para fora dos dois lados.
    const { container } = montar({ onBack: () => {} });
    expect(container.querySelector('.ms-chat--empurrada')).toBeTruthy();
    expect(container.querySelector('.ms-chat')).toBeTruthy();
  });

  it('na aba: mantém a compensação, que ali é a conta certa', () => {
    const { container } = montar();
    expect(container.querySelector('.ms-chat')).toBeTruthy();
    expect(container.querySelector('.ms-chat--empurrada')).toBeNull();
  });

  it('não pede histórico quando ainda não há conversa salva', () => {
    montar();
    expect(fetchConversationTurns).not.toHaveBeenCalled();
    expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
  });

  it('troca a presença por um alerta quando o socket cai', () => {
    const { ws } = montar();
    ws.conexao('connected');
    expect(screen.getByText(/conectada/i)).toBeTruthy();
    ws.conexao('disconnected');
    const alerta = screen.getByText(/sem conexão/i);
    expect(alerta.getAttribute('role')).toBe('alert');
    expect(screen.queryByText(/conectada/i)).toBeNull();
  });

  /* A frase do handoff afirma escuta PASSIVA — coisa diferente de socket aberto.
     Quem escuta é o `useWakeWord`, que exige `wakeWordEnabled` (padrão desligado)
     e o whisper do Mac; no iPhone praticamente nunca roda. Dizer "ouvindo" só
     porque o socket subiu é a mesma falha do "pronta" hardcoded da tela vazia. */
  describe('presença não promete escuta que não existe', () => {
    afterEach(() => { useRealtimeStore.setState({ wakeWordEnabled: false }); });

    it('socket de pé e wake word desligada: diz conectada, não "ouvindo"', () => {
      useRealtimeStore.setState({ wakeWordEnabled: false });
      const { ws } = montar();
      ws.conexao('connected');
      expect(screen.getByText('conectada')).toBeTruthy();
      expect(screen.queryByText(/ouvindo/i)).toBeNull();
    });

    it('com a wake word ligada, aí sim diz que está ouvindo', () => {
      useRealtimeStore.setState({ wakeWordEnabled: true });
      const { ws } = montar();
      ws.conexao('connected');
      expect(screen.getByText(/ouvindo/)).toBeTruthy();
      expect(screen.queryByText('conectada')).toBeNull();
    });

    /* A frase entre aspas não é texto de UI: é contrato com o classificador
       embarcado (`src-tauri/models/wakeword/ei_seraphine_v9.onnx`, limiar 0.92),
       treinado em "Ei Seraphine". Anunciar outra frase ensina o usuário a dizer
       o que não dispara nada — falha silenciosa, sem erro na tela. Por isso as
       duas metades: a frase certa aparece E a errada não sobrevive. */
    it('anuncia a frase em que o modelo foi treinado, não outra', () => {
      useRealtimeStore.setState({ wakeWordEnabled: true });
      const { ws } = montar();
      ws.conexao('connected');
      const linha = screen.getByText(/ouvindo/i).textContent ?? '';
      expect(linha).toMatch(/ei seraphine/i);
      expect(linha).not.toMatch(/oi sera\b/i);
    });
  });

  /* O RACIOCÍNIO NÃO É RESPOSTA.
     O desktop separa `<think>…</think>` (e o `<|channel>thought` da Gemma) desde
     sempre, num parser privado do `ChatView.tsx`. O telefone não tinha como
     alcançá-lo e renderizava o fluxo cru: a bolha começava com "O usuário quer
     saber a previsão…", tags e tudo, antes da frase de verdade. O parser mudou-se
     para `chat/thinking.ts` e as duas telas leem a MESMA definição — copiá-lo
     para o mobile daria dois parsers da mesma string, que é como a lista de
     backends flat já pôs um número errado na tela desta casa. */
  describe('o raciocínio do modelo não vaza na bolha', () => {
    it('esconde o bloco <think> e mostra só a resposta', () => {
      const { ws } = montar();
      ws.emite(token('<think>O usuário quer saber a previsão do tempo.</think>Hoje faz 24°.'));
      expect(screen.getByText('Hoje faz 24°.')).toBeTruthy();
      expect(screen.queryByText(/previsão do tempo/)).toBeNull();
      // e nem as tags cruas
      expect(document.body.textContent).not.toMatch(/<\/?think>/);
    });

    it('o formato de canal da Gemma some do mesmo jeito', () => {
      const { ws } = montar();
      ws.emite(token('<|channel>thought\nDeixa eu ver a agenda.<channel|>Você tem 2 eventos.'));
      expect(screen.getByText('Você tem 2 eventos.')).toBeTruthy();
      expect(screen.queryByText(/Deixa eu ver a agenda/)).toBeNull();
      expect(document.body.textContent).not.toMatch(/channel/);
    });

    it('enquanto só houve raciocínio, a bolha DIZ que está pensando', () => {
      // Sem isto a bolha fica muda: o bloco abriu, nada saiu em voz alta, e uma
      // bolha vazia é indistinguível de uma que travou.
      const { ws } = montar();
      ws.emite(token('<think>Preciso checar o clima'));
      const aviso = screen.getByText('pensando…');
      expect(aviso.getAttribute('role')).toBe('status');
      expect(screen.queryByText(/Preciso checar o clima/)).toBeNull();
    });

    it('chegando a resposta, o aviso de "pensando" sai de cena', () => {
      const { ws } = montar();
      ws.emite(token('<think>Preciso checar o clima'));
      expect(screen.getByText('pensando…')).toBeTruthy();
      ws.emite(token('</think>Está 24° e sem chuva.'));
      expect(screen.getByText('Está 24° e sem chuva.')).toBeTruthy();
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('texto sem raciocínio nenhum passa intacto', () => {
      const { ws } = montar();
      ws.emite(token('Bom dia! Como você está?'));
      expect(screen.getByText('Bom dia! Como você está?')).toBeTruthy();
      expect(screen.queryByText('pensando…')).toBeNull();
    });
  });

  /* A RESPOSTA É MARKDOWN, e ia como texto puro.
     Na conversa real chegou `**hoje e dos próximos dias**` com os asteriscos à
     mostra: a ênfase que o modelo pediu virava ruído. O desktop renderiza
     markdown desde sempre; o telefone não importava nada. */
  describe('markdown da bolha', () => {
    it('negrito vira negrito, e os asteriscos somem', () => {
      const { ws, container } = montar();
      ws.emite(token('a previsão é de **hoje e dos próximos dias**'));
      const forte = container.querySelector('.ms-chat-bolha__texto strong');
      expect(forte?.textContent).toBe('hoje e dos próximos dias');
      expect(container.textContent).not.toContain('**');
    });

    it('lista vira lista', () => {
      const { ws, container } = montar();
      ws.emite(token('leve:\n- guarda-chuva\n- casaco'));
      const itens = container.querySelectorAll('.ms-chat-bolha__texto li');
      expect([...itens].map((i) => i.textContent)).toEqual(['guarda-chuva', 'casaco']);
    });

    it('HTML cru do MODELO sai como TEXTO, não como marcação', () => {
      // A decisão central: sem `rehype-raw`. O conteúdo vem do modelo, e uma
      // `<div>` que ele escrevesse não pode virar árvore de verdade dentro da
      // bolha. Mesma escolha da tela de Lição de teoria, e aqui pesa mais.
      const { ws, container } = montar();
      ws.emite(token('cuidado: <div class="rich-card">nao sou cartao</div>'));
      expect(container.querySelector('.ms-chat-bolha__texto .rich-card')).toBeNull();
      expect(container.querySelector('.ms-chat-bolha__texto div div')).toBeNull();
      expect(container.textContent).toContain('nao sou cartao');
    });

    it('o texto sem marcação nenhuma continua chegando inteiro', () => {
      const { ws, container } = montar();
      ws.emite(token('Ilhéus tá com 24°C e chuva nas proximidades.'));
      expect(container.querySelector('.ms-chat-bolha__texto')?.textContent)
        .toBe('Ilhéus tá com 24°C e chuva nas proximidades.');
    });

    it('a bolha do USUÁRIO não passa por markdown', () => {
      // O que ele digitou vai para a tela como foi digitado — asterisco de
      // ênfase que ele escreveu é asterisco que ele quis ver.
      const { container } = montar();
      escrever(container, 'manda **isso** literal');
      const minha = container.querySelector('.ms-chat-bolha--voce');
      expect(minha?.textContent).toBe('manda **isso** literal');
      expect(minha?.querySelector('strong')).toBeNull();
    });
  });

  /* O CARTÃO QUE O BACKEND MANDA PRONTO.
     O cartão de clima do desktop não é componente React: é HTML cru montado em
     `weather.py` e entregue em `metadata.html_card`, com as classes `rich-card*`.
     O celular descartava o campo e mostrava só o texto.

     RENDERIZAR ISSO NÃO CONTRADIZ o `rehype-raw` recusado na bolha: a distinção
     é a ORIGEM. O markdown da bolha vem do MODELO — entrada que o conteúdo lido
     (e-mail, página, mensagem de terceiro) pode induzir. O `html_card` é montado
     pelo NOSSO backend. São confianças diferentes.
     Mas o canal tem contrato, e o contrato já está furado hoje: `city` entra no
     HTML por f-string sem escape (`weather.py:316`) e `city` vem dos ARGS DO
     MODELO. Por isso o cartão passa por um saneador de lista branca antes de
     virar árvore — senão a porta que a bolha fechou reabriria pelos fundos. */
  describe('cartão pronto do backend', () => {
    it('o cartão de clima aparece, em vez de só o texto', () => {
      const { ws, container } = montar();
      ws.emite(token('Leva guarda-chuva!'));
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));

      expect(container.querySelector('.ms-chat-cartao .rich-card--weather')).toBeTruthy();
      expect(screen.getByText('Ilhéus')).toBeTruthy();
      expect(screen.getByText('28°')).toBeTruthy();
      expect(screen.getByText('Seg 13/04')).toBeTruthy();
      // e o cartão fica na MESMA fala do comentário dela.
      expect(container.querySelectorAll('.ms-chat-linha--sera')).toHaveLength(1);
    });

    it('o cartão nasce mesmo quando a ferramenta corre antes de ela falar', () => {
      // Caso comum: o engine corta o stream no pedaço que traz `tool_calls`.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      expect(container.querySelector('.rich-card--weather')).toBeTruthy();
    });

    it('a bolha continua recusando o HTML do MODELO, cartão ou não', () => {
      // As duas afirmações no mesmo teste de propósito: é o par que prova que a
      // permissão é do CANAL e não do formato.
      const { ws, container } = montar();
      ws.emite(token('cuidado: <div class="rich-card rich-card--weather">falso</div>'));
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));

      expect(container.querySelector('.ms-chat-bolha__texto .rich-card')).toBeNull();
      expect(container.textContent).toContain('falso');
      expect(container.querySelector('.ms-chat-cartao .rich-card--weather')).toBeTruthy();
    });

    it('o saneador derruba script, manipulador de evento e style do cartão', () => {
      // `city` é interpolado sem escape e vem dos args do modelo: este é o
      // caminho por onde HTML do modelo chegaria vestido de cartão nosso.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({
        html_card: '<div class="rich-card rich-card--weather">'
          + '<div class="rich-card__title">'
          + '<img src="x" onerror="window.__furou = 1">Ilhéus</div>'
          + '<script>window.__furou = 2</script>'
          + '<div style="position:fixed;inset:0">tapa a tela</div>'
          + '<a href="javascript:alert(1)">link</a>'
          + '</div>',
      }));

      const cartao = container.querySelector('.ms-chat-cartao') as HTMLElement;
      expect(cartao).toBeTruthy();
      expect(cartao.querySelector('img')).toBeNull();
      expect(cartao.querySelector('script')).toBeNull();
      expect(cartao.querySelector('a')).toBeNull();
      expect(cartao.innerHTML).not.toContain('onerror');
      expect(cartao.innerHTML).not.toContain('javascript:');
      expect(cartao.querySelector('[style]')).toBeNull();
      // e o que é legítimo sobrevive.
      expect(cartao.querySelector('.rich-card__title')?.textContent).toContain('Ilhéus');
    });

    it('o saneador não deixa comentário passar para a segunda análise', () => {
      // MUTAÇÃO M11. Comentário não DESENHA nada, então nenhuma asserção sobre
      // o que se vê o pega — e a primeira leva de testes olhava só para isso.
      // Só que o cartão faz uma volta parse → `innerHTML` → parse (o React
      // reanalisa o que o saneador serializou), e é exatamente aí que mora o
      // mXSS: um comentário mal fechado reabre a árvore na segunda análise, com
      // o saneador já fora do caminho. A afirmação tem de ser sobre o FIO —
      // o HTML serializado —, e não sobre o texto renderizado.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({
        html_card: '<div class="rich-card"><!--<div>--><div class="rich-card__title">Ilhéus</div></div>',
      }));
      const cartao = container.querySelector('.ms-chat-cartao') as HTMLElement;
      expect(cartao.innerHTML).not.toContain('<!--');
      expect(cartao.querySelector('.rich-card__title')?.textContent).toBe('Ilhéus');
    });

    it('dois cartões no mesmo turno aparecem os dois', () => {
      // MUTAÇÃO M22. `anexar` põe os dois na MESMA bolha; trocar a lista em vez
      // de somar apagaria o primeiro sem ruído. Um turno de "e em Itabuna?"
      // roda a ferramenta duas vezes, e o cartão de Ilhéus sumiria.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }, 'r1'));
      ws.emite(ferramentaOk({
        html_card: '<div class="rich-card rich-card--weather">'
          + '<div class="rich-card__title">Itabuna</div></div>',
      }, 'r2'));
      expect(container.querySelectorAll('.ms-chat-cartao')).toHaveLength(2);
      expect(screen.getByText('Ilhéus')).toBeTruthy();
      expect(screen.getByText('Itabuna')).toBeTruthy();
    });

    it('o ícone SVG do cartão sobrevive ao saneador', () => {
      // Os ícones do backend são SVG inline (`svg_icons.py`) — a casa não usa
      // emoji. Uma lista branca que só pensasse em `div` os apagaria.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      const svg = container.querySelector('.ms-chat-cartao svg');
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(container.querySelector('.ms-chat-cartao svg circle')).toBeTruthy();
    });

    it('o cartão sobrevive ao restauro da conversa', async () => {
      // O engine grava o `html_card` no próprio texto do turno
      // (`engine.py:1300`) para o transcrito não perder o cartão. Sem lê-lo, o
      // `limpar()` apagava o bloco e a conversa restaurada ficava só com o texto.
      localStorage.setItem(CONV_KEY, 'conv-1');
      vi.mocked(fetchConversationTurns).mockResolvedValue([
        {
          id: 't0', conversation_id: 'conv-1', role: 'assistant',
          content: `Leva guarda-chuva!\n${CARTAO_CLIMA}`,
          created_at: '2026-07-30T10:00:00',
        },
      ]);
      const { container } = montar();
      await screen.findByText('Leva guarda-chuva!');

      expect(container.querySelector('.ms-chat-cartao .rich-card--weather')).toBeTruthy();
      expect(screen.getByText('Ilhéus')).toBeTruthy();
      // e a marcação não vaza como texto.
      expect(container.textContent).not.toContain('rich-card__title');
      expect(container.textContent).not.toContain('<!--card-->');
    });

    it('cartão pronto NÃO entra quando já há cartão estruturado', async () => {
      // `financial.py:236` manda `html_card` E `dashboard_data` no mesmo
      // `tool_result`. Desenhar os dois seria a mesma informação duas vezes —
      // é a regra que o desktop já aplica (`ChatView.tsx:779`).
      const { ws, container } = montar();
      ws.emite(ferramentaOk({
        dashboard_data: { income: 3500, expenses: 2340, balance: 1160 },
        html_card: '<div class="rich-card rich-card--finance">'
          + '<div class="rich-card__title">Resumo do mês</div></div>',
      }));
      expect(screen.getByText('67% usado')).toBeTruthy();
      expect(container.querySelector('.ms-chat-cartao')).toBeNull();
      expect(screen.queryByText('Resumo do mês')).toBeNull();
    });

    it('bolha só com cartão não é lida como turno perdido', () => {
      const { ws } = montar();
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      ws.emite({ type: 'turn_end', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.getByText('Ilhéus')).toBeTruthy();
      expect(screen.queryByText(/não veio resposta desta vez/)).toBeNull();
    });

    it('cartão que o saneador esvazia DIZ que não deu, em vez de sumir', () => {
      const { ws, container } = montar();
      ws.emite(ferramentaOk({ html_card: '<script>alert(1)</script>' }));
      expect(container.querySelector('.ms-chat-cartao')).toBeNull();
      expect(screen.getByText(/não consegui desenhar o cartão/i)).toBeTruthy();
    });
  });

  /* A ESPERA — E ELA DURA O TURNO INTEIRO, NÃO ATÉ O PRIMEIRO SINAL.
     Medido no aparelho: um turno que roda ferramentas leva ~30s, e nesse tempo
     a tela era IDÊNTICA a ociosa. Quem está do outro lado conclui que a pergunta
     se perdeu e manda de novo; foi assim que a conversa real ficou com quatro
     falas do usuário seguidas, que pareciam turnos mortos e não eram.

     A primeira correção parava no PRIMEIRO sinal do turno — inclusive num
     `tool_result`. Só que o `turn_end` do engine é ÚNICO e vem no fim de tudo
     (`engine.py:1430`): entre a primeira ferramenta e a resposta ainda cabem
     rodadas inteiras de modelo e mais ferramentas. Nos 30s medidos (clima +
     aviso na casa), a tela voltava a ficar muda depois dos primeiros 5. */
  describe('espera pela resposta', () => {
    it('mandou: a conversa diz que está pensando', () => {
      const { container } = montar();
      escrever(container, 'oi');
      expect(screen.getByText('pensando…').getAttribute('role')).toBe('status');
    });

    it('a espera SEGUE depois da primeira ferramenta, porque o turno segue', () => {
      const { ws, container } = montar();
      escrever(container, 'como vai estar o tempo amanhã?');
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      // o cartão já é progresso visível…
      expect(container.querySelector('.rich-card--weather')).toBeTruthy();
      // …e a tela continua dizendo que não acabou.
      expect(screen.getByText('pensando…')).toBeTruthy();
    });

    it('a espera só acaba no fim do turno', () => {
      const { ws, container } = montar();
      escrever(container, 'como vai estar o tempo amanhã?');
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      ws.emite(token('Vai chover à tarde.'));
      ws.emite({ type: 'turn_end', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.getByText('Vai chover à tarde.')).toBeTruthy();
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('some de vista enquanto a resposta está sendo escrita', () => {
      // O cursor da bolha já diz que ela está falando; um "pensando…" embaixo
      // do texto que aparece seria uma segunda voz dizendo a mesma coisa.
      const { ws, container } = montar();
      escrever(container, 'oi');
      ws.emite(token('Oi! Tudo'));
      expect(screen.queryByText('pensando…')).toBeNull();
      expect(screen.getByText('Oi! Tudo')).toBeTruthy();
    });

    it('aprovação pendente é DITA, com o nome da ferramenta', () => {
      // `tool_request` é o único quadro do fio que traz o nome da ferramenta —
      // e ele só é emitido para as que exigem confirmação (`engine.py:1216`).
      // No telefone não há painel de aprovação: sem esta frase o turno ficaria
      // travado 300s (`APPROVAL_TIMEOUT_SECONDS`) dizendo "pensando…".
      const { ws, container } = montar();
      escrever(container, 'marca dentista quinta 15h');
      ws.emite({
        type: 'tool_request', request_id: 'r1',
        tool: 'calendar_create_event', args: {}, requires_confirmation: true,
      });
      expect(screen.getByText(/esperando sua aprovação para criar um evento na agenda/i)).toBeTruthy();
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('ferramenta que o telefone não conhece é dita pelo nome do fio', () => {
      const { container, ws } = montar();
      escrever(container, 'roda isso');
      ws.emite({
        type: 'tool_request', request_id: 'r1',
        tool: 'ferramenta_nova', args: {}, requires_confirmation: true,
      });
      expect(screen.getByText(/esperando sua aprovação para ferramenta_nova/i)).toBeTruthy();
    });

    it('a aprovação é dita MESMO com ela já falando', () => {
      // MUTAÇÃO M16. O caso é o normal, não o raro: ela diz "deixa comigo!" e
      // só então pede a ferramenta. A bolha fica `streaming` até o `turn_end`,
      // que nesse caminho não vem — o engine está parado esperando o sim, por
      // até 300s. Escondido atrás do cursor, o pedido de aprovação nunca
      // apareceria e o telefone travaria calado.
      const { ws, container } = montar();
      escrever(container, 'marca dentista quinta 15h');
      ws.emite(token('Deixa comigo!'));
      ws.emite({
        type: 'tool_request', request_id: 'r1',
        tool: 'calendar_create_event', args: {}, requires_confirmation: true,
      });
      expect(screen.getByText('Deixa comigo!')).toBeTruthy();
      expect(screen.getByText(/esperando sua aprovação para criar um evento na agenda/i)).toBeTruthy();
    });

    it('ferramenta sozinha não inventa uma espera que a tela não abriu', () => {
      // MUTAÇÃO M20. A espera é sempre de um turno QUE ESTA TELA MANDOU: é a
      // única que ela sabe terminar. Um `tool_result` que chega sem isso —
      // turno começado por outra tela no mesmo socket — abriria um "pensando…"
      // sem `turn_end` à vista, e ele ficaria lá para sempre.
      const { ws, container } = montar();
      ws.emite(ferramentaOk({ html_card: CARTAO_CLIMA }));
      expect(container.querySelector('.rich-card--weather')).toBeTruthy();
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('a aprovação some quando a ferramenta responde', () => {
      const { ws, container } = montar();
      escrever(container, 'marca dentista quinta 15h');
      ws.emite({
        type: 'tool_request', request_id: 'r1',
        tool: 'calendar_create_event', args: {}, requires_confirmation: true,
      });
      ws.emite(ferramentaOk(null));
      expect(screen.queryByText(/esperando sua aprovação/i)).toBeNull();
      expect(screen.getByText('pensando…')).toBeTruthy();
    });

    it('some no erro — senão a tela pensaria para sempre', () => {
      const { ws, container } = montar();
      escrever(container, 'oi');
      ws.emite({ type: 'error', message: 'o modelo caiu' });
      expect(screen.queryByText('pensando…')).toBeNull();
      expect(screen.getByText(/o modelo caiu/)).toBeTruthy();
    });

    it('some quando o turno é cancelado', () => {
      const { ws, container } = montar();
      escrever(container, 'oi');
      ws.emite({ type: 'turn_cancelled', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('some quando a conexão cai — o turno morreu com ela', () => {
      // O backend cancela o turno no `websocket.disconnect` (`routes.py:1035`).
      // Sem isto a tela pensaria para sempre ao lado de "sem conexão".
      const { ws, container } = montar();
      escrever(container, 'oi');
      ws.conexao('disconnected');
      expect(screen.queryByText('pensando…')).toBeNull();
      expect(screen.getByText('sem conexão')).toBeTruthy();
    });

    it('sem socket, nada é mandado e nada fica pensando', () => {
      // `enviarTexto` devolve false sem `ws`: prometer espera por uma mensagem
      // que não saiu seria a mentira ao contrário.
      const { container } = render(<ChatScreen />);
      escrever(container, 'oi');
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('em repouso, ninguém está pensando', () => {
      const { ws } = montar();
      ws.emite(token('Bom dia!'));
      expect(screen.queryByText('pensando…')).toBeNull();
    });
  });

  /* A BOLHA VAZIA É UM TURNO PERDIDO.
     Na conversa real apareceram duas falas do usuário seguidas, sem resposta no
     meio. Uma bolha da Seraphine que fecha sem NADA dentro é indistinguível de
     "ela ignorou a pergunta" — e a tela é a única que sabe a diferença. */
  describe('turno que fecha sem uma palavra', () => {
    it('só raciocínio e fim de turno: a bolha diz o que houve, em vez de ficar vazia', () => {
      const { ws } = montar();
      ws.emite(token('<think>ia responder o clima</think>'));
      ws.emite({ type: 'turn_end', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.getByText(/pensei, mas não cheguei a responder/)).toBeTruthy();
      expect(screen.queryByText(/ia responder o clima/)).toBeNull();
      // e UMA frase só: "pensando…" ao lado de "não cheguei a responder" seriam
      // duas afirmações contraditórias na mesma bolha.
      expect(screen.queryByText('pensando…')).toBeNull();
    });

    it('resposta que só tinha marcação também não vira bolha muda', () => {
      // `limpar` come `[anim:…]` e comentários de cartão. Sobrando nada, o
      // resultado era uma bolha em branco.
      const { ws } = montar();
      ws.emite(token('[anim:acenar]'));
      ws.emite({ type: 'turn_end', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.getByText(/não veio resposta desta vez/)).toBeTruthy();
    });

    it('enquanto o turno está aberto, vazio é ESPERA e não falha', () => {
      const { ws } = montar();
      ws.emite(token('<think>pensando ainda'));
      expect(screen.getByText('pensando…')).toBeTruthy();
      expect(screen.queryByText(/não cheguei a responder/)).toBeNull();
    });

    it('bolha com cartão e sem texto não é muda', () => {
      // O cartão de tarefa É a resposta nesse turno; dizer "não veio resposta"
      // ao lado dele seria contradizer o que está na tela.
      const { ws } = montar();
      ws.emite({
        type: 'tool_result', request_id: 'r1', ok: true, output: 'ok', error: null,
        metadata: { task: { id: 7, title: 'Pagar aluguel', status: 'pending' } },
      });
      ws.emite({ type: 'turn_end', conversation_id: 'c1', turn_id: 't1' });
      expect(screen.getByText('Pagar aluguel')).toBeTruthy();
      expect(screen.queryByText(/não veio resposta desta vez/)).toBeNull();
    });
  });
});

// Task 28 — a integração com o estado vazio do handoff (tela 19). Antes disto a
// `ChatVazioScreen` era inalcançável e as quatro sugestões eram botões mortos.
describe('ChatScreen — o vazio do handoff embutido', () => {
  const SUGESTOES = [
    'Organiza minha semana',
    'Me ajuda a controlar gastos',
    'Quero criar um hábito novo',
    'Me ensina algo novo',
  ];

  it('desenha o orb de 88px, o título e as quatro sugestões na conversa vazia', () => {
    const { container } = montar();
    expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
    expect(SUGESTOES.map((t) => screen.getByRole('button', { name: t }).textContent)).toEqual(SUGESTOES);
    // o orb grande do vazio, além do de 38px do cabeçalho da tela
    const orbs = Array.from(container.querySelectorAll<HTMLElement>('.morb')).map((o) => o.style.width);
    expect(orbs).toContain('88px');
  });

  // O que a integração existe para consertar: a sugestão vira mensagem. Um laço
  // e não um clique só — um handler que ignorasse o texto passaria no caso único.
  it.each(SUGESTOES)('tocar em "%s" manda esse texto pelo socket', (texto) => {
    const { ws } = montar();
    fireEvent.click(screen.getByRole('button', { name: texto }));

    expect(ws.enviadas).toHaveLength(1);
    expect(ws.enviadas[0].type).toBe('user_message');
    expect(ws.enviadas[0].content).toBe(texto);
    // e vira bolha do usuário na hora, como se tivesse sido digitada
    expect(screen.getByText(texto, { selector: '.ms-chat-bolha--voce' })).toBeTruthy();
    // o vazio sai de cena: a conversa começou
    expect(screen.queryByText(TITULO_VAZIO)).toBeNull();
  });

  // A armadilha nº 1 do despacho: montar a TELA vazia inteira traria um segundo
  // cabeçalho e um segundo composer para dentro do chat. Só o miolo entra.
  it('não duplica cabeçalho nem composer', () => {
    montar();
    expect(screen.getAllByPlaceholderText('Mensagem…')).toHaveLength(1);
    expect(screen.getAllByText('Seraphine')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Enviar' })).toHaveLength(1);
  });

  /* O defeito que apareceu no simulador: o composer aparecia logo abaixo da
     quarta sugestão, com um vão morto até a tab bar. A causa foi de ALTURA do
     contêiner, mas o que precisa ficar travado é a ESTRUTURA — o composer é o
     último filho da coluna da tela, irmão da conversa, e não mora dentro da
     área que rola. Enquanto isso valer, ele acompanha o fim da coluna. */
  it('o composer é o último filho da tela, fora da área que rola', () => {
    const { container } = montar();
    const raiz = container.querySelector('.ms-chat') as HTMLElement;
    const composer = container.querySelector('.ms-chat__composer') as HTMLElement;

    expect(raiz.lastElementChild).toBe(composer);
    expect(composer.parentElement).toBe(raiz);
    // dentro da conversa não há composer nenhum…
    expect(container.querySelector('.ms-chat__thread .ms-chat__composer')).toBeNull();
    // …e o vazio está lá dentro, que é onde ele deve rolar junto com as bolhas
    expect(container.querySelector('.ms-chat__thread .ms-chatvazio__miolo')).toBeTruthy();
    // e o vazio não arrasta consigo um composer próprio
    expect(container.querySelectorAll('.ms-chatvazio__composer')).toHaveLength(0);
    expect(container.querySelectorAll('form')).toHaveLength(1);
  });

  /* O outro defeito: o orb de 88px saía cortado no topo. A tela rolava até o
     fim ao montar — e numa conversa vazia não existe "fim" para onde rolar. */
  it('não rola a conversa quando não há bolha nenhuma', () => {
    const rolou = vi.fn();
    const antes = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = rolou;
    try {
      const { ws } = montar();
      expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
      expect(rolou).not.toHaveBeenCalled();

      // chegando a primeira fala, aí sim: o fim passa a existir
      ws.emite(token('oi!'));
      expect(rolou).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = antes;
    }
  });

  // A armadilha nº 4: a tela vazia afirmava "pronta" com bolinha verde sem saber
  // nada de conexão. Aqui a presença é a do socket, inclusive no vazio.
  it('não afirma "pronta": no vazio a presença ainda é a do socket', () => {
    const { ws } = montar();
    ws.conexao('connected');
    expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
    expect(screen.queryByText('pronta')).toBeNull();
    expect(screen.getByText('conectada')).toBeTruthy();

    ws.conexao('disconnected');
    // vazio E sem conexão convivem: um é sobre a conversa, o outro sobre a rede
    expect(screen.getByText(TITULO_VAZIO)).toBeTruthy();
    expect(screen.getByText(/sem conexão/i).getAttribute('role')).toBe('alert');
  });

  it('não põe o separador de dia acima de uma conversa que não começou', () => {
    const { ws, container } = montar();
    expect(container.querySelector('.ms-chat__dia')).toBeNull();

    ws.emite(token('oi!'));
    expect(container.querySelector('.ms-chat__dia')).toBeTruthy();
  });

  it('some quando a conversa falha: erro no lugar do vazio, nunca os dois', () => {
    vi.useFakeTimers();
    h.refs.wsRef.current = null;
    render(<ChatScreen />);
    act(() => { vi.advanceTimersByTime(5000); });

    expect(screen.getByText(/não consegui abrir a conversa/i)).toBeTruthy();
    expect(screen.queryByText(TITULO_VAZIO)).toBeNull();
  });

  it('some quando o histórico falha: quem manda é o erro, não o convite', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockRejectedValue(new Error('HTTP 503'));
    montar();

    await screen.findByText(/não consegui carregar a conversa anterior/i);
    expect(screen.queryByText(TITULO_VAZIO)).toBeNull();
  });
});

// A aba Chat desmonta ao trocar de aba: sem restaurar, voltar para ela apagava
// a conversa inteira da tela. É o que o `ChatTab` (que esta tela substituiu)
// fazia certo, pela `ChatView`.
describe('ChatScreen — restaura o transcrito', () => {
  const turno = (id: string, role: string, content: string) => ({
    id, conversation_id: 'conv-1', role, content, created_at: '2026-07-31T09:41:00',
  });

  it('traz de volta a conversa salva ao montar', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockResolvedValue([
      turno('t1', 'user', 'me lembra de pagar o aluguel amanhã cedo'),
      turno('t2', 'assistant', 'Feito! Lembrete pra amanhã às 08:00.'),
    ]);
    const { container } = montar();

    expect(await screen.findByText('me lembra de pagar o aluguel amanhã cedo')).toBeTruthy();
    expect(screen.getByText('Feito! Lembrete pra amanhã às 08:00.')).toBeTruthy();
    expect(fetchConversationTurns).toHaveBeenCalledWith('conv-1');
    // Os papéis do servidor viram os dois lados da tela, não um lado só.
    expect(container.querySelector('.ms-chat-bolha--voce')).toBeTruthy();
    expect(container.querySelector('.ms-chat-bolha--sera')).toBeTruthy();
    expect(screen.queryByText(TITULO_VAZIO)).toBeNull();
  });

  it('remonta o cartão de tarefa que ficou gravado no turno', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockResolvedValue([
      turno('t2', 'assistant',
        'Adicionei como tarefa.\n<!--task-data:{"id":7,"title":"Pagar aluguel","due_time":"08:00"}-->'),
    ]);
    montar();

    expect(await screen.findByText('Pagar aluguel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
    // A marcação some do texto: o cartão a substitui, não a duplica.
    expect(screen.getByText('Adicionei como tarefa.')).toBeTruthy();
    expect(screen.queryByText(/task-data/)).toBeNull();
  });

  it('não despeja o HTML do cartão salvo dentro da bolha: desenha o cartão', async () => {
    // A afirmação original era "nada disso aparece" — escrita quando o telefone
    // ainda descartava cartão. O que ela protegia continua valendo e é o que
    // sobrou aqui: a MARCAÇÃO não pode virar texto na bolha. O conteúdo, sim,
    // aparece — como cartão, que é onde ele deveria estar desde o começo.
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockResolvedValue([
      turno('t2', 'assistant',
        'Seu painel:\n<!--card--><div class="rich-card"><b>Receitas</b></div><!--/card-->'),
    ]);
    const { container } = montar();

    expect(await screen.findByText('Seu painel:')).toBeTruthy();
    expect(container.querySelector('.ms-chat-bolha__texto')?.textContent).toBe('Seu painel:');
    expect(container.textContent).not.toContain('rich-card');
    expect(container.textContent).not.toContain('<!--card-->');
    expect(container.querySelector('.ms-chat-cartao .rich-card b')?.textContent).toBe('Receitas');
  });

  it('mostra erro próprio quando o histórico não carrega, e deixa conversar', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    vi.mocked(fetchConversationTurns).mockRejectedValue(new Error('HTTP 503'));
    const { ws, container } = montar();

    const erro = await screen.findByText(/não consegui carregar a conversa anterior/i);
    expect(erro.getAttribute('role')).toBe('alert');
    // O ao vivo continua de pé: a falha é do histórico, não do socket.
    escrever(container, 'e o orçamento, como tá?');
    expect(ws.enviadas).toHaveLength(1);
  });

  it('deixa mandar mensagem — e mostra a bolha — com o histórico ainda voltando', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    let entrega: (t: unknown[]) => void = () => {};
    vi.mocked(fetchConversationTurns).mockReturnValue(
      new Promise((r) => { entrega = r as (t: unknown[]) => void; }) as never,
    );
    const { ws, container } = montar();

    // Ainda restaurando: o composer aceita, então a bolha TEM que aparecer —
    // digitar e ver a própria mensagem sumir é pior que um campo desabilitado.
    escrever(container, 'e o orçamento, como tá?');
    expect(ws.enviadas).toHaveLength(1);
    expect(screen.getByText('e o orçamento, como tá?')).toBeTruthy();

    await act(async () => { entrega([]); });
    expect(screen.getByText('e o orçamento, como tá?')).toBeTruthy();
  });

  it('o que chegou ao vivo não é atropelado quando o histórico volta depois', async () => {
    localStorage.setItem(CONV_KEY, 'conv-1');
    let entrega: (t: unknown[]) => void = () => {};
    vi.mocked(fetchConversationTurns).mockReturnValue(
      new Promise((r) => { entrega = r as (t: unknown[]) => void; }) as never,
    );
    const { ws } = montar();
    ws.emite(token('resposta ao vivo', 'turno-ao-vivo'));

    await act(async () => { entrega([turno('t1', 'user', 'pergunta antiga')]); });
    expect(screen.getByText('pergunta antiga')).toBeTruthy();
    expect(screen.getByText('resposta ao vivo')).toBeTruthy();
  });
});
