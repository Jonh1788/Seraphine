import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mockamos o MÓDULO de api, não o `fetch`: um mock de fetch com `{ ok, json }`
// sem `headers` faz o helper do `notes/api.ts` — que lê `res.headers.get(...)`
// — estourar, e o teste passaria pelo caminho de erro achando que testou o
// caminho feliz.
vi.mock('../../../notes/api', () => ({ listNotes: vi.fn(), createNote: vi.fn() }));

import { listNotes, createNote } from '../../../notes/api';
import type { Note } from '../../../notes/types';
import { NotasScreen } from '../NotasScreen';

const nota = (over: Partial<Note> = {}): Note => ({
  id: 'n1',
  title: 'Arquitetura do relé',
  content: 'O relé em Rust fala com o ESP32 por HTTP; a allowlist mora no host.',
  tags: ['casa', 'rust'],
  created_at: '2026-07-20T10:00:00Z',
  updated_at: '2026-07-20T10:00:00Z',
  backlinks: [],
  linked_tasks: [],
  ...over,
});

const tres = (): Note[] => [
  nota(),
  nota({ id: 'n2', title: 'Ideias de trilha', content: 'Uma trilha sobre embeddings.', tags: [] }),
  nota({ id: 'n3', title: 'Leituras', content: 'Karpathy sobre wikis mantidos por LLM.', tags: ['leitura'] }),
];

describe('NotasScreen', () => {
  beforeEach(() => {
    vi.mocked(listNotes).mockReset().mockResolvedValue([]);
    vi.mocked(createNote).mockReset();
  });

  it('lista as notas com título, prévia, etiquetas e a contagem no cabeçalho', async () => {
    vi.mocked(listNotes).mockResolvedValue(tres());
    render(<NotasScreen />);

    await waitFor(() => expect(screen.getByText('Arquitetura do relé')).toBeTruthy());
    expect(screen.getByText('Ideias de trilha')).toBeTruthy();
    expect(screen.getByText(/o relé em rust fala com o esp32/i)).toBeTruthy();
    expect(screen.getByText('casa')).toBeTruthy();
    expect(screen.getByText('3 notas')).toBeTruthy();
  });

  it('mostra estado vazio, não some, quando não há nota nenhuma', async () => {
    vi.mocked(listNotes).mockResolvedValue([]);
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText(/você ainda não escreveu nenhuma nota/i)).toBeTruthy());
  });

  it('mostra erro quando a api de notas falha', async () => {
    vi.mocked(listNotes).mockRejectedValue(new Error('rede'));
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar suas notas/i)).toBeTruthy());
    expect(screen.getByText(/não consegui carregar suas notas/i).getAttribute('role')).toBe('alert');
  });

  it('digitar na busca rebusca no servidor com o termo', async () => {
    vi.mocked(listNotes).mockResolvedValue(tres());
    render(<NotasScreen />);
    await waitFor(() => expect(vi.mocked(listNotes)).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/buscar nas notas/i), { target: { value: 'relé' } });
    await waitFor(() =>
      expect(vi.mocked(listNotes)).toHaveBeenCalledWith('relé', expect.any(Number)),
    );
  });

  it('busca sem resultado diz que nada casa, em vez de sumir', async () => {
    vi.mocked(listNotes).mockResolvedValue(tres());
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText('Arquitetura do relé')).toBeTruthy());

    vi.mocked(listNotes).mockResolvedValue([]);
    fireEvent.change(screen.getByLabelText(/buscar nas notas/i), { target: { value: 'xpto' } });
    await waitFor(() => expect(screen.getByText(/nada nas notas casa com “xpto”/i)).toBeTruthy());
    // o vazio da busca não pode ser o vazio de "nunca escreveu nada"
    expect(screen.queryByText(/você ainda não escreveu nenhuma nota/i)).toBeNull();
  });

  // O shell não desenha chrome (PushedScreen é só corpo): sem a seta aqui,
  // quem entra em Notas fica preso na tela.
  it('tem o voltar do handoff e chama onBack ao tocar', async () => {
    vi.mocked(listNotes).mockResolvedValue(tres());
    const onBack = vi.fn();
    render(<NotasScreen onBack={onBack} />);
    fireEvent.click(await screen.findByLabelText('Voltar'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('sem onBack não mostra o voltar nem quebra a tela', async () => {
    vi.mocked(listNotes).mockResolvedValue(tres());
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText('Arquitetura do relé')).toBeTruthy());
    expect(screen.queryByLabelText('Voltar')).toBeNull();
  });

  // O "+" só existe porque `notes/api.ts` tem `createNote`. Botão que não
  // escreve seria pior que botão ausente.
  it('o + abre o compositor e Salvar cria a nota e recarrega a lista', async () => {
    vi.mocked(listNotes).mockResolvedValue([]);
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText(/você ainda não escreveu nenhuma nota/i)).toBeTruthy());

    // fechado por padrão: a tela abre mostrando notas, não um formulário
    expect(screen.queryByLabelText(/título da nota/i)).toBeNull();

    fireEvent.click(screen.getByLabelText('Nova nota'));
    const titulo = screen.getByLabelText(/título da nota/i);
    const corpo = screen.getByLabelText(/conteúdo da nota/i);

    // sem título não há o que salvar
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(titulo, { target: { value: 'Ideia solta' } });
    fireEvent.change(corpo, { target: { value: 'Wake word em PT-BR.' } });

    const criada = nota({ id: 'n9', title: 'Ideia solta', content: 'Wake word em PT-BR.', tags: [] });
    vi.mocked(createNote).mockResolvedValue(criada);
    vi.mocked(listNotes).mockResolvedValue([criada]);

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(vi.mocked(createNote)).toHaveBeenCalledWith({
        title: 'Ideia solta',
        content: 'Wake word em PT-BR.',
      }),
    );
    // a nota nova aparece na lista e o compositor se fecha
    await waitFor(() => expect(screen.getByText('Ideia solta')).toBeTruthy());
    expect(screen.queryByLabelText(/título da nota/i)).toBeNull();
  });

  it('falha ao salvar mostra erro e não joga fora o que foi escrito', async () => {
    vi.mocked(listNotes).mockResolvedValue([]);
    vi.mocked(createNote).mockRejectedValue(new Error('rede'));
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText(/você ainda não escreveu nenhuma nota/i)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Nova nota'));
    fireEvent.change(screen.getByLabelText(/título da nota/i), { target: { value: 'Não perde' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(screen.getByText(/não consegui salvar sua nota/i)).toBeTruthy());
    expect(screen.getByText(/não consegui salvar sua nota/i).getAttribute('role')).toBe('alert');
    expect((screen.getByLabelText(/título da nota/i) as HTMLInputElement).value).toBe('Não perde');
  });

  it('nota sem conteúdo diz que está vazia, em vez de virar cartão mudo', async () => {
    vi.mocked(listNotes).mockResolvedValue([nota({ id: 'n4', title: 'Só o título', content: '', tags: [] })]);
    render(<NotasScreen />);
    await waitFor(() => expect(screen.getByText('Só o título')).toBeTruthy());
    expect(screen.getByText(/ainda sem conteúdo/i)).toBeTruthy();
  });
});
