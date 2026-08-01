import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Tela SELETOR DE MODELO (handoff v3, frame "Seletor de modelo").
 *
 * O risco distintivo desta tela não é visual, é de CONTRATO. O `<select>` do
 * desktop grava o que o usuário escolheu no `chat_model`, e esse valor é o que
 * roteia TODA conversa. Em 2026-07-31 o app prefixou de novo um id que já vinha
 * prefixado de `GET /deepsearch/models` — gravou
 * `openrouter:openrouter:google/gemini-2.5-flash`, o strip de um nível deixou
 * `openrouter:google/...` como model id, e a OpenRouter respondeu 400 "is not a
 * valid model ID": o chat inteiro parou, não só a tela.
 *
 * O teste do painel do desktop não pegou isso porque a fixture usava um id SEM
 * prefixo — ou seja, testava um contrato que a api não tem. A fixture daqui usa
 * ids como a api os devolve (`openrouter:<vendor>/<model>`), e o teste forte
 * compara o argumento de `putChatModel` com o id da fixture, caractere a
 * caractere. O `not.toMatch(/^openrouter:openrouter:/)` documenta a intenção,
 * mas quem trava é a igualdade.
 */

vi.mock('../../../research/api', () => ({
  getChatModel: vi.fn(),
  listModels: vi.fn(),
  getConfig: vi.fn(),
  putChatModel: vi.fn(),
}));

import { getChatModel, getConfig, listModels, putChatModel } from '../../../research/api';
import { SeletorModeloScreen } from '../SeletorModeloScreen';

/** Como `GET /deepsearch/models` responde de verdade: `service.list_models()`
 *  monta `{"id": f"openrouter:{m['id']}", "name": ...}`. O id JÁ VEM prefixado.
 *
 *  `openrouter:openrouter/auto` não é engano: o vendor do Auto Router na
 *  OpenRouter chama-se literalmente `openrouter`, então o id legítimo tem a
 *  palavra duas vezes — com dois-pontos na primeira e barra na segunda. É a
 *  armadilha para qualquer "dedupe" esperto que alguém venha a escrever. */
const MODELOS = [
  { id: 'openrouter:anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
  { id: 'openrouter:anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5' },
  { id: 'openrouter:google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'openrouter:deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'openrouter:openrouter/auto', name: 'Auto Router' },
];

const CONFIG_COM_CHAVE = {
  fanout_model: 'cliproxy',
  synth_model: 'cliproxy',
  openrouter_key_set: true,
};

interface Cenario {
  chatModel?: string;
  modelos?: { id: string; name: string }[];
  chaveSalva?: boolean;
}

function comDado({ chatModel = 'cliproxy', modelos = MODELOS, chaveSalva = true }: Cenario = {}) {
  vi.mocked(getChatModel).mockResolvedValue({ chat_model: chatModel });
  vi.mocked(listModels).mockResolvedValue({ cliproxy: [], openrouter: modelos });
  vi.mocked(getConfig).mockResolvedValue({ ...CONFIG_COM_CHAVE, openrouter_key_set: chaveSalva });
  // O backend ecoa o que gravou (e normaliza na escrita — rede de segurança).
  vi.mocked(putChatModel).mockImplementation(async (id: string) => ({ chat_model: id }));
}

const linha = (nome: string | RegExp) => screen.getByRole('button', { name: nome });

describe('SeletorModeloScreen', () => {
  beforeEach(() => {
    vi.mocked(getChatModel).mockReset();
    vi.mocked(listModels).mockReset();
    vi.mocked(getConfig).mockReset();
    vi.mocked(putChatModel).mockReset();
  });

  /* ── estado 1: dado ─────────────────────────────────────────────── */

  it('mostra o card do Padrão com o selo flat $0 e a lista agrupada por provedor', async () => {
    comDado();
    render(<SeletorModeloScreen />);

    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    // Card do Padrão: selecionado, e o único selo de custo que a api sustenta.
    const padrao = linha(/Padrão/);
    expect(padrao.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/flat \$0 · sem custo por chamada/)).toBeTruthy();

    // Cabeçalhos do handoff, nesta ordem, e o rótulo âmbar do grupo.
    const grupos = Array.from(document.querySelectorAll('.ms-seletor-grupo__rotulo')).map(
      (n) => n.textContent,
    );
    expect(grupos).toEqual(['ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OUTROS']);
    expect(screen.getByText('custo medido')).toBeTruthy();

    // Todo modelo do catálogo aparece pelo nome, com o selo "medido".
    for (const m of MODELOS) expect(linha(new RegExp(m.name)).textContent).toContain('medido');
    expect(screen.getAllByText('medido')).toHaveLength(MODELOS.length);

    // Preço por modelo a api NÃO expõe: nenhum valor em dólar pode aparecer na
    // lista do OpenRouter (o "flat $0" do Padrão é o único cifrão da tela, e
    // ele é um fato do roteamento, não um preço inventado por modelo).
    expect(document.querySelector('.ms-seletor-lista')?.textContent).not.toMatch(/\$/);

    // O esqueleto some quando o dado chega.
    expect(screen.queryByTestId('seletor-modelo-esqueleto')).toBeNull();
  });

  it('agrupa cada modelo pelo vendor do id, com o ponto de cor do provedor', async () => {
    comDado();
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    const doGrupo = (rotulo: string) =>
      Array.from(
        document
          .querySelector(`[data-grupo-rotulo="${rotulo}"]`)
          ?.querySelectorAll('.ms-seletor-modelo__nome') ?? [],
      ).map((n) => n.textContent);

    expect(doGrupo('ANTHROPIC')).toEqual(['Claude Sonnet 4.6', 'Claude Haiku 4.5']);
    expect(doGrupo('GOOGLE')).toEqual(['Gemini 3.5 Flash']);
    expect(doGrupo('DEEPSEEK')).toEqual(['DeepSeek V4 Flash']);
    // Vendor `openrouter` não é um dos três nomeados: cai em OUTROS.
    expect(doGrupo('OUTROS')).toEqual(['Auto Router']);

    const ponto = (rotulo: string) =>
      document.querySelector(`[data-grupo-rotulo="${rotulo}"] .ms-seletor-grupo__ponto`);
    expect(ponto('ANTHROPIC')?.className).toContain('ms-seletor-grupo__ponto--anthropic');
    expect(ponto('GOOGLE')?.className).toContain('ms-seletor-grupo__ponto--google');
    expect(ponto('DEEPSEEK')?.className).toContain('ms-seletor-grupo__ponto--deepseek');
    expect(ponto('OUTROS')?.className).toContain('ms-seletor-grupo__ponto--outros');
  });

  it('durante o carregamento mostra esqueleto sem texto, nunca um modelo provisório', async () => {
    comDado();
    render(<SeletorModeloScreen />);

    const skel = screen.getByTestId('seletor-modelo-esqueleto');
    expect(skel.getAttribute('aria-hidden')).toBe('true');
    expect(skel.textContent).toBe('');
    // Nada de "Padrão selecionado" antes de saber qual é o modelo gravado.
    expect(screen.queryByRole('button', { name: /Padrão/ })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // Deixa a leitura assentar dentro do teste (senão o React resolve os
    // estados depois do fim dele e o act(...) reclama, com razão).
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());
  });

  /* ── o contrato: o id gravado é o id que veio da api ─────────────── */

  it('grava exatamente o id que a api devolveu, sem prefixar de novo', async () => {
    comDado();
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('GOOGLE')).toBeTruthy());

    fireEvent.click(linha(/Gemini 3\.5 Flash/));

    await waitFor(() => expect(vi.mocked(putChatModel)).toHaveBeenCalled());
    const gravado = vi.mocked(putChatModel).mock.calls[0][0];

    // O forte: igualdade caractere a caractere com o id da fixture.
    expect(gravado).toBe('openrouter:google/gemini-3.5-flash');
    expect(gravado).toBe(MODELOS[2].id);
    // A intenção, escrita: o bug de 2026-07-31 não pode voltar por outra porta.
    expect(gravado).not.toMatch(/^openrouter:openrouter:/);
  });

  it('preserva o id do Auto Router, onde a palavra openrouter aparece duas vezes', async () => {
    comDado();
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('OUTROS')).toBeTruthy());

    fireEvent.click(linha(/Auto Router/));

    await waitFor(() => expect(vi.mocked(putChatModel)).toHaveBeenCalled());
    // Um "dedupe" de prefixo mutilaria este id; ele é legítimo assim.
    expect(vi.mocked(putChatModel).mock.calls[0][0]).toBe('openrouter:openrouter/auto');
  });

  it('grava `cliproxy` ao voltar para o Padrão, sem prefixo nenhum', async () => {
    comDado({ chatModel: 'openrouter:google/gemini-3.5-flash' });
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('GOOGLE')).toBeTruthy());

    fireEvent.click(linha(/Padrão/));

    await waitFor(() => expect(vi.mocked(putChatModel)).toHaveBeenCalled());
    expect(vi.mocked(putChatModel).mock.calls[0][0]).toBe('cliproxy');
  });

  it('marca como selecionado o modelo do OpenRouter que está gravado, e não o Padrão', async () => {
    comDado({ chatModel: 'openrouter:anthropic/claude-haiku-4.5' });
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    expect(linha(/Claude Haiku 4\.5/).getAttribute('aria-pressed')).toBe('true');
    // Ausência afirmada: o Padrão NÃO pode aparecer marcado ao mesmo tempo.
    expect(linha(/Padrão/).getAttribute('aria-pressed')).toBe('false');
  });

  it('mostra o modelo gravado que sumiu do catálogo, em vez de fingir que o Padrão está ativo', async () => {
    comDado({ chatModel: 'openrouter:foo/modelo-que-sumiu' });
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    expect(screen.getByText('openrouter:foo/modelo-que-sumiu')).toBeTruthy();
    expect(screen.getByText(/não está no catálogo/i)).toBeTruthy();
    expect(linha(/Padrão/).getAttribute('aria-pressed')).toBe('false');
  });

  /* ── busca ──────────────────────────────────────────────────────── */

  it('filtra a lista pela busca e afirma quando nada corresponde', async () => {
    comDado();
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    const busca = screen.getByLabelText('Buscar modelo');
    fireEvent.change(busca, { target: { value: 'gemini' } });

    expect(screen.getByText('Gemini 3.5 Flash')).toBeTruthy();
    // Ausência afirmada: os que não casam somem, e o cabeçalho vazio também.
    expect(screen.queryByText('Claude Sonnet 4.6')).toBeNull();
    expect(screen.queryByText('Auto Router')).toBeNull();
    expect(screen.queryByText('ANTHROPIC')).toBeNull();
    expect(screen.queryByText('OUTROS')).toBeNull();
    expect(screen.getByText('GOOGLE')).toBeTruthy();

    // Busca sem resultado: mensagem honesta, e não é erro.
    fireEvent.change(busca, { target: { value: 'zzz' } });
    expect(screen.getByText(/Nenhum modelo corresponde a "zzz"/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('acha o modelo pelo id, não só pelo nome, e ignora acento no Padrão', async () => {
    comDado();
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());

    const busca = screen.getByLabelText('Buscar modelo');
    fireEvent.change(busca, { target: { value: 'deepseek-v4' } });
    expect(screen.getByText('DeepSeek V4 Flash')).toBeTruthy();

    // "padrao" sem acento encontra "Padrão".
    fireEvent.change(busca, { target: { value: 'padrao' } });
    expect(linha(/Padrão/)).toBeTruthy();
    expect(screen.queryByText('Gemini 3.5 Flash')).toBeNull();
  });

  /* ── estado 2: vazio ────────────────────────────────────────────── */

  it('catálogo vazio sem chave: diz o porquê, mantém o Padrão e não é erro', async () => {
    comDado({ modelos: [], chaveSalva: false });
    render(<SeletorModeloScreen />);

    await waitFor(() => expect(linha(/Padrão/)).toBeTruthy());
    expect(screen.getByText(/chave da OpenRouter não está configurada/i)).toBeTruthy();
    // Vazio não é erro.
    expect(screen.queryByRole('alert')).toBeNull();
    // Ausência afirmada: nenhum grupo de provedor é desenhado sem modelo.
    expect(document.querySelectorAll('.ms-seletor-grupo__rotulo')).toHaveLength(0);
    expect(screen.queryByText('medido')).toBeNull();
  });

  it('catálogo vazio COM chave salva não repete a mensagem da chave ausente', async () => {
    comDado({ modelos: [], chaveSalva: true });
    render(<SeletorModeloScreen />);

    await waitFor(() => expect(linha(/Padrão/)).toBeTruthy());
    expect(screen.getByText(/catálogo do OpenRouter voltou vazio/i)).toBeTruthy();
    expect(screen.queryByText(/chave da OpenRouter não está configurada/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /* ── estado 3: erro ─────────────────────────────────────────────── */

  it('falha ao carregar: um alerta só, com botão de tentar de novo', async () => {
    vi.mocked(getChatModel).mockRejectedValue(new Error('HTTP 503'));
    vi.mocked(listModels).mockResolvedValue({ cliproxy: [], openrouter: MODELOS });
    vi.mocked(getConfig).mockResolvedValue(CONFIG_COM_CHAVE);

    render(<SeletorModeloScreen />);

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toMatch(/não consegui/i);
    // Sem saber o modelo gravado, marcar qualquer opção seria mentira.
    expect(screen.queryByRole('button', { name: /Padrão/ })).toBeNull();
    expect(screen.queryByText('Claude Sonnet 4.6')).toBeNull();

    // Tentar de novo refaz a leitura.
    comDado();
    fireEvent.click(screen.getByRole('button', { name: /Tentar de novo/i }));
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falha ao salvar: avisa e devolve a seleção anterior, sem deixar o app mentir', async () => {
    comDado();
    vi.mocked(putChatModel).mockRejectedValue(new Error('HTTP 500'));
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('GOOGLE')).toBeTruthy());

    fireEvent.click(linha(/Gemini 3\.5 Flash/));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/não consegui trocar o modelo/i);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // A seleção volta para o que o backend de fato tem gravado.
    expect(linha(/Padrão/).getAttribute('aria-pressed')).toBe('true');
    expect(linha(/Gemini 3\.5 Flash/).getAttribute('aria-pressed')).toBe('false');
  });

  it('avisa quando o backend grava um valor diferente do escolhido', async () => {
    comDado();
    // Normalização na escrita (rede de segurança do backend): o eco diverge.
    vi.mocked(putChatModel).mockResolvedValue({ chat_model: 'openrouter:google/outro' });
    render(<SeletorModeloScreen />);
    await waitFor(() => expect(screen.getByText('GOOGLE')).toBeTruthy());

    fireEvent.click(linha(/Gemini 3\.5 Flash/));

    await waitFor(() => expect(screen.getByText(/o backend gravou/i)).toBeTruthy());
    // O aviso nomeia os DOIS: o que escolhi e o que ficou gravado. Só o segundo
    // não bastaria — a diferença é a informação.
    const aviso = screen.getByText(/o backend gravou/i);
    expect(aviso.textContent).toContain('openrouter:google/gemini-3.5-flash');
    expect(aviso.textContent).toContain('openrouter:google/outro');
    // Divergência do eco é informação, não falha: não vira alerta.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /* ── navegação ──────────────────────────────────────────────────── */

  it('o botão de voltar usa o rótulo compartilhado e chama onBack', async () => {
    comDado();
    const onBack = vi.fn();
    render(<SeletorModeloScreen onBack={onBack} />);

    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText('ANTHROPIC')).toBeTruthy());
  });
});
