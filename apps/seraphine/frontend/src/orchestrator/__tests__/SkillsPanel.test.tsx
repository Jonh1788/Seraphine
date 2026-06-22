import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDraft } from '../types';

// Mock the store module wholesale so the test never pulls in the real
// skillsStore -> ../api -> @tauri-apps/api import chain (which throws in jsdom).
// useSkillsStore is consumed as a selector hook: useSkillsStore((s) => ...).
const publish = vi.fn();
const discard = vi.fn();
let state: { drafts: SkillDraft[]; publish: typeof publish; discard: typeof discard };

vi.mock('../skillsStore', () => ({
  useSkillsStore: <T,>(selector: (s: typeof state) => T): T => selector(state),
}));

// Imported AFTER vi.mock so the mock is wired.
import { SkillsPanel } from '../SkillsPanel';

function draft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    id: 'd1',
    name: 'Deploy via push to vps',
    slug: 'deploy-via-push-to-vps',
    skillMd: '--- name: Deploy ---\n## Procedure\nrun git push vps main',
    confidence: 0.82,
    sourceAgentId: 'agent-12345678',
    createdAt: 1_700_000_000_000,
    status: 'draft',
    ...over,
  };
}

beforeEach(() => {
  publish.mockReset().mockResolvedValue(undefined);
  discard.mockReset();
  state = { drafts: [], publish, discard };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SkillsPanel', () => {
  it('shows the empty state when there are no drafts', () => {
    render(<SkillsPanel />);
    expect(screen.getByText(/Nenhuma skill aprendida ainda/i)).toBeTruthy();
  });

  it('lists a draft with its name, confidence and skill markdown', () => {
    state.drafts = [draft()];
    render(<SkillsPanel />);
    expect(screen.getByText('Deploy via push to vps')).toBeTruthy();
    expect(screen.getByText(/82%/)).toBeTruthy();
    expect(screen.getByText(/run git push vps main/)).toBeTruthy();
  });

  it('Publicar calls publish(id) for the draft', async () => {
    state.drafts = [draft({ id: 'abc' })];
    render(<SkillsPanel />);
    fireEvent.click(screen.getByText('Publicar'));
    await waitFor(() => expect(publish).toHaveBeenCalledWith('abc'));
  });

  it('Descartar calls discard(id) for the draft', () => {
    state.drafts = [draft({ id: 'xyz' })];
    render(<SkillsPanel />);
    fireEvent.click(screen.getByText('Descartar'));
    expect(discard).toHaveBeenCalledWith('xyz');
  });

  it('hides discarded drafts and shows the publishedPath for published ones', () => {
    state.drafts = [
      draft({ id: 'pub', status: 'published', publishedPath: '/home/u/.claude/skills/deploy/SKILL.md' }),
      draft({ id: 'gone', status: 'discarded' }),
    ];
    render(<SkillsPanel />);
    // Published entry shows its path and no action buttons.
    expect(screen.getByText('/home/u/.claude/skills/deploy/SKILL.md')).toBeTruthy();
    expect(screen.queryByText('Publicar')).toBeNull();
    expect(screen.queryByText('Descartar')).toBeNull();
  });
});
