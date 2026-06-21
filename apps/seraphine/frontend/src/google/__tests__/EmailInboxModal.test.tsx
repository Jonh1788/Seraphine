import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EmailInboxModal } from '../EmailInboxModal';

vi.mock('../api', () => ({
  listImportantEmails: vi.fn(async () => []),
  getEmail: vi.fn(async (id: string) => ({
    id,
    from: 'Banco Inter <no@inter.com>',
    to: 'me@x.com',
    subject: 'Fatura vence hoje',
    body: 'corpo do email urgente',
    date: '2026-06-21T12:00:00Z',
  })),
  markEmailAsRead: vi.fn(),
  markEmailsAsReadBatch: vi.fn(),
}));

describe('EmailInboxModal deep-link', () => {
  beforeEach(() => vi.clearAllMocks());

  it('auto-fetches and expands the deep-linked message', async () => {
    render(<EmailInboxModal open messageId="m1" onClose={() => {}} ws={null} />);
    const api = await import('../api');
    await waitFor(() => expect(api.getEmail).toHaveBeenCalledWith('m1'));
    // The synthesized row renders with the fetched subject, expanded body.
    await waitFor(() => expect(screen.getByText('Fatura vence hoje')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('corpo do email urgente')).toBeTruthy());
  });

  it('does not crash with no messageId', () => {
    render(<EmailInboxModal open onClose={() => {}} ws={null} />);
    expect(screen.getByText('Emails importantes nao lidos')).toBeTruthy();
  });
});
