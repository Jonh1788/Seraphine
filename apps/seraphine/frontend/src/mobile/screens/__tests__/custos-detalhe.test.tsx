import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* Esta tela mostra DINHEIRO, como a irmã (`custos.test.tsx`), e herda a mesma
   regra: um custo exibido errado é pior que um custo ausente. Além dos três
   estados da onda, os testes daqui prendem as quatro armadilhas próprias do
   frame de DETALHE:

     1. a lista de backends flat vem de `GET /telemetry/flat-backends` e a tela
        NÃO pode ter cópia local — enquanto ela não chega, nada é classificado
        (nem o `$0` verde, nem a ordenação): esqueleto;
     2. quando TODO o período é flat, ordenar por custo dá uma lista com tudo
        zerado, cuja ordem parece aleatória — aí a ordem é o volume de chamadas;
     3. a energia (`read_power`) não existe fora do Tauri. Ausência de medição
        NÃO é zero: zero afirma que não há consumo, o que é outra coisa;
     4. o card de sugestão é derivado dos dados. Sem dado suficiente, não há
        sugestão nenhuma — inventar conselho sobre dinheiro é pior que calar. */

vi.mock('../../../telemetry/api', () => ({
  fetchTelemetrySummary: vi.fn(),
  listFlatBackends: vi.fn(),
  readPower: vi.fn(),
}));

import { fetchTelemetrySummary, listFlatBackends, readPower } from '../../../telemetry/api';
import { CustosDetalheScreen } from '../CustosDetalheScreen';

/** A lista que o backend devolve hoje (`pricing.FLAT_BACKENDS`, Task 1). */
const FLAT = ['claude_max', 'cliproxy', 'local', 'ollama'];

const SEM_ENERGIA = { supported: false } as const;

/* Período misto: 1402 chamadas em cliproxy (flat) + 96 em openrouter ($2,84).
   O backend ordena por custo DESC — as fixtures respeitam isso. */
function resumo(over: Record<string, unknown> = {}) {
  return {
    days: 7,
    total: { input_tokens: 3_400_000, output_tokens: 812_000, cost_usd: 2.84, calls: 1498 },
    by_model: [
      { model: 'anthropic/claude-haiku-4.5', input_tokens: 900_000, output_tokens: 210_000, cost_usd: 1.92, calls: 68 },
      { model: 'google/gemini-3.5-flash', input_tokens: 500_000, output_tokens: 102_000, cost_usd: 0.92, calls: 28 },
      { model: 'claude-sonnet-4.6', input_tokens: 2_000_000, output_tokens: 500_000, cost_usd: 0, calls: 1402 },
    ],
    by_feature: [
      { feature: 'research', cost_usd: 1.84, calls: 40 },
      { feature: 'maestro', cost_usd: 1.0, calls: 56 },
      { feature: 'chat', cost_usd: 0, calls: 1300 },
      { feature: 'trilhas', cost_usd: 0, calls: 102 },
    ],
    by_backend: [
      { backend: 'openrouter', cost_usd: 2.84, calls: 96 },
      { backend: 'cliproxy', cost_usd: 0, calls: 1402 },
    ],
    ...over,
  } as never;
}

/* Período INTEIRO em backend flat: todo custo é 0 e a ordem que o backend
   mandou (custo DESC, empate resolvido pelo SQLite) não diz nada. */
function resumoTudoFlat(over: Record<string, unknown> = {}) {
  return resumo({
    total: { input_tokens: 1_000_000, output_tokens: 300_000, cost_usd: 0, calls: 1000 },
    by_model: [
      { model: 'ollama/llama3', input_tokens: 10, output_tokens: 5, cost_usd: 0, calls: 40 },
      { model: 'claude-sonnet-4.6', input_tokens: 10, output_tokens: 5, cost_usd: 0, calls: 900 },
      { model: 'ollama/qwen3', input_tokens: 10, output_tokens: 5, cost_usd: 0, calls: 60 },
    ],
    by_feature: [
      { feature: 'trilhas', cost_usd: 0, calls: 60 },
      { feature: 'chat', cost_usd: 0, calls: 800 },
      { feature: 'maestro', cost_usd: 0, calls: 140 },
    ],
    by_backend: [
      { backend: 'cliproxy', cost_usd: 0, calls: 900 },
      { backend: 'ollama', cost_usd: 0, calls: 100 },
    ],
    ...over,
  });
}

function resumoVazio(over: Record<string, unknown> = {}) {
  return resumo({
    total: { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0 },
    by_model: [],
    by_feature: [],
    by_backend: [],
    ...over,
  });
}

function comDado(r: never = resumo()) {
  vi.mocked(fetchTelemetrySummary).mockResolvedValue(r);
  vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
  vi.mocked(readPower).mockResolvedValue(SEM_ENERGIA);
}

const q = (c: HTMLElement, sel: string) => c.querySelector<HTMLElement>(sel);
const todos = (c: HTMLElement, sel: string) => Array.from(c.querySelectorAll<HTMLElement>(sel));
const textos = (c: HTMLElement, sel: string) => todos(c, sel).map((e) => e.textContent);

const secFunc = (c: HTMLElement) => q(c, '.ms-custosdet-func')!;
const secModelos = (c: HTMLElement) => q(c, '.ms-custosdet-modelos')!;
const secEnergia = (c: HTMLElement) => q(c, '.ms-custosdet-energia')!;

describe('CustosDetalheScreen', () => {
  beforeEach(() => {
    vi.mocked(fetchTelemetrySummary).mockReset();
    vi.mocked(listFlatBackends).mockReset();
    vi.mocked(readPower).mockReset();
  });

  /* ── estado 1: dado ─────────────────────────────────────────────── */

  it('mostra as funcionalidades como colunas: custo em cima, nome embaixo', async () => {
    comDado();
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(4));
    expect(screen.getByText('Onde foi o custo')).toBeTruthy();
    expect(screen.getByText('Últimos 7 dias')).toBeTruthy();
    expect(screen.getByText('$2,84 no total')).toBeTruthy();

    // ordem por custo, com o nome ABAIXO do valor dentro de cada coluna
    expect(todos(secFunc(container), '.ms-custosdet-col').map((c) => c.dataset.nome))
      .toEqual(['research', 'maestro', 'chat', 'trilhas']);
    const primeira = todos(secFunc(container), '.ms-custosdet-col')[0];
    const filhos = Array.from(primeira.children).map((e) => e.className);
    expect(filhos[0]).toMatch(/ms-custosdet-col__custo/);
    expect(filhos[filhos.length - 1]).toMatch(/ms-custosdet-col__nome/);
    expect(textos(secFunc(container), '.ms-custosdet-col__custo'))
      .toEqual(['$1,84', '$1,00', '$0', '$0']);

    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('o maior gasto vai de âmbar e as colunas de $0 vão de verde', async () => {
    comDado();
    const { container } = render(<CustosDetalheScreen />);
    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(4));

    const cols = todos(secFunc(container), '.ms-custosdet-col');
    // âmbar SÓ no maior gasto — inclusive não no segundo colocado
    expect(cols.filter((c) => c.className.includes('ms-custosdet-col--ambar')).map((c) => c.dataset.nome))
      .toEqual(['research']);
    expect(cols.filter((c) => c.className.includes('ms-custosdet-col--zero')).map((c) => c.dataset.nome))
      .toEqual(['chat', 'trilhas']);
    // altura proporcional ao custo; $0 não ganha altura inventada
    expect(todos(secFunc(container), '.ms-custosdet-col__barra').map((b) => b.style.height))
      .toEqual(['100%', '54.3%', '0%', '0%']);
  });

  it('por modelo: barras horizontais com ponto do provedor, custo e N×', async () => {
    comDado();
    const { container } = render(<CustosDetalheScreen />);
    await waitFor(() => expect(todos(container, '.ms-custosdet-linha').length).toBe(3));

    const linhas = todos(secModelos(container), '.ms-custosdet-linha');
    expect(linhas.map((l) => l.dataset.modelo))
      .toEqual(['anthropic/claude-haiku-4.5', 'google/gemini-3.5-flash', 'claude-sonnet-4.6']);
    expect(textos(secModelos(container), '.ms-custosdet-linha__custo')).toEqual(['$1,92', '$0,92', '$0']);
    // milhar em pt-BR, como no handoff ("1.402×")
    expect(textos(secModelos(container), '.ms-custosdet-linha__chamadas')).toEqual(['68×', '28×', '1.402×']);
    expect(todos(secModelos(container), '.ms-custosdet-linha__fill').map((f) => f.style.width))
      .toEqual(['100%', '47.9%', '0%']);
    expect(linhas.every((l) => !!q(l, '.ms-custosdet-linha__ponto'))).toBe(true);
  });

  it('o ponto é do PROVEDOR: mesmo provedor, mesma cor; outro provedor, outra', async () => {
    comDado(resumo({
      by_model: [
        { model: 'anthropic/claude-haiku-4.5', input_tokens: 1, output_tokens: 1, cost_usd: 1.92, calls: 68 },
        { model: 'anthropic/claude-opus-4.5', input_tokens: 1, output_tokens: 1, cost_usd: 0.5, calls: 4 },
        { model: 'google/gemini-3.5-flash', input_tokens: 1, output_tokens: 1, cost_usd: 0.42, calls: 28 },
      ],
    }) as never);
    const { container } = render(<CustosDetalheScreen />);
    await waitFor(() => expect(todos(container, '.ms-custosdet-linha').length).toBe(3));

    const linhas = todos(secModelos(container), '.ms-custosdet-linha');
    expect(linhas.map((l) => l.dataset.provedor)).toEqual(['anthropic', 'anthropic', 'google']);
    const cor = (l: HTMLElement) => q(l, '.ms-custosdet-linha__ponto')!.style.background;
    expect(cor(linhas[0])).toBe(cor(linhas[1]));
    expect(cor(linhas[0])).not.toBe(cor(linhas[2]));
    expect(cor(linhas[0])).toBeTruthy();
  });

  /* ── período inteiro flat: ordenar por custo daria lista aleatória ─ */

  it('período todo flat ordena por volume de chamadas, não por custo', async () => {
    comDado(resumoTudoFlat() as never);
    const { container } = render(<CustosDetalheScreen />);
    await waitFor(() => expect(todos(container, '.ms-custosdet-linha').length).toBe(3));

    // o backend mandou llama3, sonnet, qwen3 (custo DESC com tudo zerado)
    expect(todos(secModelos(container), '.ms-custosdet-linha').map((l) => l.dataset.modelo))
      .toEqual(['claude-sonnet-4.6', 'ollama/qwen3', 'ollama/llama3']);
    expect(todos(secModelos(container), '.ms-custosdet-linha__fill').map((f) => f.style.width))
      .toEqual(['100%', '6.7%', '4.4%']);
    // e as colunas seguem a mesma métrica
    expect(todos(secFunc(container), '.ms-custosdet-col').map((c) => c.dataset.nome))
      .toEqual(['chat', 'maestro', 'trilhas']);
    expect(todos(secFunc(container), '.ms-custosdet-col__barra').map((b) => b.style.height))
      .toEqual(['100%', '17.5%', '7.5%']);

    // a tela DIZ por que a ordem mudou, em vez de deixar o usuário adivinhar
    expect(screen.getByText(/ordenada por volume de chamadas/i)).toBeTruthy();
    // e a afirmação de flat cobre o período inteiro, com os nomes que vieram
    expect(screen.getByText(/todas as 1\.000 chamadas do período rodaram sem custo marginal \(cliproxy · ollama\)/i)).toBeTruthy();
    // com tudo zerado, ninguém é "o maior gasto"
    expect(q(container, '.ms-custosdet-col--ambar')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── a lista flat é do backend, nunca da tela ────────────────────── */

  it('enquanto a lista flat não chegou, não classifica — esqueleto', async () => {
    vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumo());
    vi.mocked(readPower).mockResolvedValue({ supported: true, cpu_mw: 3200, gpu_mw: 1800, package_mw: 6400 });
    vi.mocked(listFlatBackends).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CustosDetalheScreen />);

    // a energia (que não depende da lista) chega; os blocos de custo, não
    await waitFor(() => expect(todos(container, '.ms-custosdet-medidor').length).toBe(3));
    expect(q(container, '[data-testid="custosdet-func-esqueleto"]')).toBeTruthy();
    expect(q(container, '[data-testid="custosdet-modelos-esqueleto"]')).toBeTruthy();
    expect(todos(container, '.ms-custosdet-col').length).toBe(0);
    expect(todos(container, '.ms-custosdet-linha').length).toBe(0);
    expect(secFunc(container).textContent).not.toMatch(/\$/);
    expect(secModelos(container).textContent).not.toMatch(/\$/);
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('se a lista flat falha, mostra os valores gravados SEM a marcação de flat', async () => {
    comDado();
    vi.mocked(listFlatBackends).mockRejectedValue(new Error('rede'));
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(4));
    expect(screen.getByText(/não consegui confirmar quais backends não têm custo marginal/i)).toBeTruthy();
    // os números gravados seguem visíveis...
    expect(textos(secFunc(container), '.ms-custosdet-col__custo')).toEqual(['$1,84', '$1,00', '$0', '$0']);
    // ...mas o `$0` NÃO é pintado de "sem custo marginal", que é o que não sabemos
    expect(q(container, '.ms-custosdet-col--zero')).toBeNull();
    expect(q(container, '.ms-custosdet-linha__custo--flat')).toBeNull();
    expect(screen.queryByText(/sem custo marginal \(/i)).toBeNull();
    // falha secundária não é o alerta da tela
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('a lista do backend é a única fonte: sem ollama, ollama deixa de ser flat', async () => {
    comDado(resumoTudoFlat() as never);
    vi.mocked(listFlatBackends).mockResolvedValue(['claude_max', 'cliproxy']);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-linha').length).toBe(3));
    // com ollama fora da lista, o período deixa de ser "todo flat": a
    // afirmação encolhe para as 900 do cliproxy e não fala mais do período
    expect(screen.getByText('900 chamadas do período rodaram sem custo marginal (cliproxy).')).toBeTruthy();
    expect(screen.queryByText(/todas as .* chamadas do período/i)).toBeNull();
    // a ORDEM, que sai dos números exibidos e não da lista, não muda
    expect(screen.getByText(/ordenada por volume de chamadas/i)).toBeTruthy();
    expect(todos(secModelos(container), '.ms-custosdet-linha').map((l) => l.dataset.modelo))
      .toEqual(['claude-sonnet-4.6', 'ollama/qwen3', 'ollama/llama3']);
  });

  it('período todo em backend flat, mas com custo gravado, não vira a afirmação de flat', async () => {
    /* A Task 1 mudou a lista: linhas gravadas ANTES dela carregam custo em
       backend que hoje é flat. Dizer "todas as chamadas rodaram sem custo
       marginal" ao lado de um cifrão visível seria a tela se contradizendo. */
    comDado(resumoTudoFlat({
      by_model: [
        { model: 'ollama/llama3', input_tokens: 10, output_tokens: 5, cost_usd: 5.0, calls: 40 },
        { model: 'claude-sonnet-4.6', input_tokens: 10, output_tokens: 5, cost_usd: 0, calls: 900 },
      ],
      by_feature: [
        { feature: 'chat', cost_usd: 0, calls: 800 },
        { feature: 'trilhas', cost_usd: 5.0, calls: 60 },
      ],
    }) as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-linha').length).toBe(2));
    expect(screen.queryByText(/todas as .* chamadas do período/i)).toBeNull();
    expect(screen.queryByText(/ordenada por volume de chamadas/i)).toBeNull();
    // há dinheiro na tela: a ordem volta a ser a do custo
    expect(todos(secFunc(container), '.ms-custosdet-col').map((c) => c.dataset.nome))
      .toEqual(['trilhas', 'chat']);
    expect(screen.getByText('$5,00 no total')).toBeTruthy();
    // e o que a lista sustenta continua sendo dito, sem o "todas"
    expect(screen.getByText('1.000 chamadas do período rodaram sem custo marginal (cliproxy · ollama).')).toBeTruthy();
  });

  /* ── estado 2: vazio ────────────────────────────────────────────── */

  it('período sem chamadas diz isso nos dois blocos, e não é erro', async () => {
    comDado(resumoVazio() as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(screen.getAllByText(/nenhuma chamada nos últimos 7 dias/i).length).toBe(2));
    expect(todos(container, '.ms-custosdet-col').length).toBe(0);
    expect(todos(container, '.ms-custosdet-linha').length).toBe(0);
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── estado 3: erro ─────────────────────────────────────────────── */

  it('falha do resumo mostra UM alerta e nenhum número inventado', async () => {
    vi.mocked(fetchTelemetrySummary).mockRejectedValue(new Error('HTTP 500'));
    vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
    vi.mocked(readPower).mockResolvedValue(SEM_ENERGIA);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getAllByRole('alert').length).toBe(1);
    expect(screen.getByText(/não consegui carregar o detalhe de custos/i)).toBeTruthy();
    expect(secFunc(container).textContent).not.toMatch(/\$/);
    expect(secModelos(container).textContent).not.toMatch(/\$/);
    // erro não é vazio: não afirmar "nenhuma chamada", que seria outra mentira
    expect(screen.queryByText(/nenhuma chamada nos últimos/i)).toBeNull();
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
  });

  it('o "tentar de novo" do erro refaz a busca', async () => {
    vi.mocked(fetchTelemetrySummary).mockRejectedValue(new Error('HTTP 500'));
    vi.mocked(listFlatBackends).mockResolvedValue(FLAT);
    vi.mocked(readPower).mockResolvedValue(SEM_ENERGIA);
    render(<CustosDetalheScreen />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    vi.mocked(fetchTelemetrySummary).mockResolvedValue(resumo());
    fireEvent.click(screen.getByRole('button', { name: /tentar de novo/i }));

    await waitFor(() => expect(screen.getByText('$2,84 no total')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('carregando é esqueleto, sem texto de vazio e sem número', async () => {
    vi.mocked(fetchTelemetrySummary).mockReturnValue(new Promise(() => {}));
    vi.mocked(listFlatBackends).mockReturnValue(new Promise(() => {}));
    vi.mocked(readPower).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CustosDetalheScreen />);

    expect(q(container, '[data-testid="custosdet-func-esqueleto"]')).toBeTruthy();
    expect(q(container, '[data-testid="custosdet-modelos-esqueleto"]')).toBeTruthy();
    expect(q(container, '[data-testid="custosdet-energia-esqueleto"]')).toBeTruthy();
    expect(screen.queryByText(/nenhuma chamada/i)).toBeNull();
    expect(container.textContent).not.toMatch(/\$\d/);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── energia (Mac local) ────────────────────────────────────────── */

  it('energia disponível mostra CPU, GPU e Pacote em watts, com o "ao vivo"', async () => {
    comDado();
    vi.mocked(readPower).mockResolvedValue({ supported: true, cpu_mw: 3200, gpu_mw: 1800, package_mw: 6400 });
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-medidor').length).toBe(3));
    expect(todos(secEnergia(container), '.ms-custosdet-medidor').map((m) => m.dataset.medidor))
      .toEqual(['CPU', 'GPU', 'Pacote']);
    // mW/1000, uma casa, vírgula
    expect(textos(secEnergia(container), '.ms-custosdet-medidor__valor')).toEqual(['3,2W', '1,8W', '6,4W']);
    expect(q(container, '.ms-custosdet-vivo')).toBeTruthy();
    expect(screen.getByText('ao vivo')).toBeTruthy();
  });

  it('sem suporte, diz o porquê — e NUNCA um zero', async () => {
    comDado();
    vi.mocked(readPower).mockResolvedValue(SEM_ENERGIA);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(screen.getByText(/energia indisponível/i)).toBeTruthy());
    const energia = secEnergia(container);
    expect(todos(energia, '.ms-custosdet-medidor').length).toBe(0);
    // zero é um VALOR: afirma que não há consumo. Nenhum dígito no card.
    expect(energia.textContent).not.toMatch(/\d/);
    expect(q(container, '.ms-custosdet-vivo')).toBeNull();
    // ausência de energia não é erro da tela
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(secFunc(container).textContent).toMatch(/\$/);
  });

  it('enquanto a primeira amostra não chega, esqueleto — não "indisponível"', async () => {
    comDado();
    vi.mocked(readPower).mockReturnValue(new Promise(() => {}));
    const { container } = render(<CustosDetalheScreen />);

    // o resto da tela carrega; a energia ainda não sabe de nada
    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(4));
    const energia = secEnergia(container);
    expect(q(energia, '[data-testid="custosdet-energia-esqueleto"]')).toBeTruthy();
    expect(energia.textContent).not.toMatch(/indisponível/i);
    expect(todos(energia, '.ms-custosdet-medidor').length).toBe(0);
    expect(energia.textContent).not.toMatch(/\d/);
  });

  it('medidor sem leitura mostra "—", não 0,0 W', async () => {
    comDado();
    // `gpu_mw` ausente é o campo que o `powermetrics` não parseou (o comando o
    // serializa como `null`); `package_mw` não-finito é a defesa contra um
    // emissor que não passe por JSON. Nenhum dos dois pode virar "0,0 W".
    vi.mocked(readPower).mockResolvedValue({ supported: true, cpu_mw: 3200, package_mw: Number.NaN });
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-medidor').length).toBe(3));
    expect(textos(secEnergia(container), '.ms-custosdet-medidor__valor')).toEqual(['3,2W', '—', '—']);
    expect(secEnergia(container).textContent).not.toMatch(/0,0|NaN/);
  });

  /* ── sugestão derivada dos dados ─────────────────────────────────── */

  it('a sugestão sai dos próprios dados: a funcionalidade mais cara', async () => {
    comDado();
    const onOpen = vi.fn();
    const { container } = render(<CustosDetalheScreen onOpen={onOpen} />);

    await waitFor(() => expect(q(container, '.ms-custosdet-sugestao')).toBeTruthy());
    const card = q(container, '.ms-custosdet-sugestao')!;
    expect(card.textContent).toMatch(/research/);
    expect(card.textContent).toMatch(/\$1,84/);
    expect(card.textContent).toMatch(/\$2,84/);
    expect(card.textContent).toMatch(/65%/);

    fireEvent.click(screen.getByRole('button', { name: /trocar modelo/i }));
    expect(onOpen).toHaveBeenCalledWith({ key: 'seletor-modelo', title: 'Modelo' });

    fireEvent.click(screen.getByRole('button', { name: /agora não/i }));
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
  });

  it('sem custo nenhum, não inventa sugestão', async () => {
    comDado(resumoTudoFlat() as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(3));
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
  });

  it('uma funcionalidade só não dá sugestão: não há o que comparar', async () => {
    comDado(resumo({
      by_feature: [{ feature: 'chat', cost_usd: 2.84, calls: 1498 }],
    }) as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(1));
    expect(q(container, '.ms-custosdet-sugestao')).toBeNull();
  });

  it('sem onOpen, o botão que navega não é desenhado (nada de botão morto)', async () => {
    comDado();
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(q(container, '.ms-custosdet-sugestao')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /trocar modelo/i })).toBeNull();
    expect(screen.getByRole('button', { name: /agora não/i })).toBeTruthy();
  });

  /* ── leitura defensiva do payload ───────────────────────────────── */

  it('linha fora do formato não vira NaN nem some calada — fica de fora e é dita', async () => {
    comDado(resumo({
      by_feature: [
        { feature: 'research', cost_usd: 1.84, calls: 40 },
        { feature: 'maestro', cost_usd: 1.0, calls: 56 },
        // um `cost_usd` que chega como string é o erro que a Task 2 já viu no
        // bloco de teto: aqui ele viraria `$NaN` colado num total errado
        { feature: 'wiki', cost_usd: '0.50', calls: 12 },
      ],
    }) as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(2));
    expect(container.textContent).not.toMatch(/NaN/);
    expect(screen.getByText(/uma linha do período veio num formato que não reconheço/i)).toBeTruthy();
    // e o total é o das linhas que EU consegui ler — não a soma com um buraco
    expect(screen.getByText('$2,84 no total')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  /* ── truncação das colunas ──────────────────────────────────────── */

  it('com muitas funcionalidades, mostra as maiores e SOMA o resto em vez de sumir com ele', async () => {
    comDado(resumo({
      by_feature: [
        { feature: 'research', cost_usd: 1.84, calls: 40 },
        { feature: 'maestro', cost_usd: 1.0, calls: 56 },
        { feature: 'wiki', cost_usd: 0.5, calls: 12 },
        { feature: 'email', cost_usd: 0.4, calls: 20 },
        { feature: 'trilhas', cost_usd: 0.3, calls: 8 },
        { feature: 'chat', cost_usd: 0.2, calls: 900 },
        { feature: 'notas', cost_usd: 0.1, calls: 4 },
      ],
    }) as never);
    const { container } = render(<CustosDetalheScreen />);

    await waitFor(() => expect(todos(container, '.ms-custosdet-col').length).toBe(5));
    expect(todos(secFunc(container), '.ms-custosdet-col').map((c) => c.dataset.nome))
      .toEqual(['research', 'maestro', 'wiki', 'email', 'trilhas']);
    expect(screen.getByText(/\+2 outras · \$0,30 · 904×/)).toBeTruthy();
    // o total do cabeçalho é o do PERÍODO, não o das cinco colunas desenhadas:
    // um total que ignora o que foi truncado esconde gasto duas vezes
    expect(screen.getByText('$4,34 no total')).toBeTruthy();
  });

  /* ── navegação e forma ──────────────────────────────────────────── */

  it('o ‹ do cabeçalho chama onBack, e sem onBack não quebra', async () => {
    comDado();
    const onBack = vi.fn();
    const { unmount } = render(<CustosDetalheScreen onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('$2,84 no total')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();

    render(<CustosDetalheScreen />);
    await waitFor(() => expect(screen.getByText('$2,84 no total')).toBeTruthy());
    expect(() => fireEvent.click(screen.getByLabelText('Voltar'))).not.toThrow();
  });

  it('não usa emoji — os ícones são SVG', async () => {
    comDado();
    const { container } = render(<CustosDetalheScreen />);
    await waitFor(() => expect(screen.getByText('$2,84 no total')).toBeTruthy());

    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/u;
    expect(emoji.test(container.textContent ?? '')).toBe(false);
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
