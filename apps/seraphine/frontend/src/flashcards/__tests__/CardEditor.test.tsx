import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '../api';

// --- Mock the api module the editor consumes ---------------------------------
const createCard = vi.fn();
const editCard = vi.fn();
const generateCardImage = vi.fn();

vi.mock('../api', () => ({
  createCard: (...a: unknown[]) => createCard(...a),
  editCard: (...a: unknown[]) => editCard(...a),
  generateCardImage: (...a: unknown[]) => generateCardImage(...a),
}));

// Imported AFTER vi.mock so the mock is wired.
import { CardEditor } from '../CardEditor';

const sample: Card = {
  id: 'card-1',
  topic: 'Rust',
  front: 'O que é ownership?',
  back: 'Sistema de gerência de memória.',
  tags: ['rust', 'memória'],
  source_url: 'https://doc.rust-lang.org',
  source_title: 'The Book',
  image_url: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('CardEditor', () => {
  it('clicking "Gerar imagem" calls generateCardImage(card.id) and shows the returned image', async () => {
    generateCardImage.mockResolvedValue({
      card: { ...sample, image_url: 'https://cdn/img.png' },
    });
    const onSaved = vi.fn();
    const onClose = vi.fn();

    render(<CardEditor card={sample} onSaved={onSaved} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /Gerar imagem/i }));

    await waitFor(() => expect(generateCardImage).toHaveBeenCalledWith('card-1'));
    await waitFor(() => {
      const img = document.querySelector('img.flashcards__card-img') as HTMLImageElement | null;
      expect(img?.src).toContain('https://cdn/img.png');
    });
  });

  it('shows the thrown error message inline when image generation fails (e.g. over budget)', async () => {
    generateCardImage.mockRejectedValue(new Error('Orçamento de imagens esgotado'));
    render(<CardEditor card={sample} onSaved={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Gerar imagem/i }));

    await waitFor(() =>
      expect(screen.getByText('Orçamento de imagens esgotado')).toBeTruthy(),
    );
    expect(generateCardImage).toHaveBeenCalledWith('card-1');
  });

  it('Save calls editCard(card.id, patch) for an existing card and reports the saved card', async () => {
    const updated: Card = { ...sample, front: 'Pergunta editada' };
    editCard.mockResolvedValue({ card: updated });
    const onSaved = vi.fn();

    render(<CardEditor card={sample} onSaved={onSaved} onClose={vi.fn()} />);

    const front = screen.getByLabelText('Frente');
    fireEvent.change(front, { target: { value: 'Pergunta editada' } });

    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(editCard).toHaveBeenCalledTimes(1));
    const [id, patch] = editCard.mock.calls[0];
    expect(id).toBe('card-1');
    expect(patch).toMatchObject({
      front: 'Pergunta editada',
      back: sample.back,
      tags: ['rust', 'memória'],
      source_url: 'https://doc.rust-lang.org',
      image_url: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated));
  });

  it('Save calls createCard (not editCard) for a new card, seeded with newTopic', async () => {
    createCard.mockResolvedValue({ card: { ...sample, id: 'new-1' } });
    const onSaved = vi.fn();

    render(<CardEditor card={null} newTopic="Rust" onSaved={onSaved} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Frente'), { target: { value: 'F' } });
    fireEvent.change(screen.getByLabelText('Verso'), { target: { value: 'B' } });

    fireEvent.click(screen.getByRole('button', { name: /^Salvar$/i }));

    await waitFor(() => expect(createCard).toHaveBeenCalledTimes(1));
    expect(createCard.mock.calls[0][0]).toMatchObject({
      topic: 'Rust',
      front: 'F',
      back: 'B',
    });
    expect(editCard).not.toHaveBeenCalled();
  });

  it('disables image generation for a new (unsaved) card', () => {
    render(<CardEditor card={null} newTopic="Rust" onSaved={vi.fn()} onClose={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /Gerar imagem/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
