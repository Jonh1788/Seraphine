import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const si = vi.hoisted(() => ({ phase: 'idle' as string }));

vi.mock('../api', () => ({
  listSessions: vi.fn(async () => []),
  listHosts: vi.fn(async () => []),
  readTranscript: vi.fn(async () => []),
  sendToAgent: vi.fn(), stopAgent: vi.fn(), respondPermission: vi.fn(),
  resumeSession: vi.fn(), forkSession: vi.fn(), checkHost: vi.fn(), listRemoteSessions: vi.fn(),
}));
vi.mock('../useAgentStream', () => ({ useAgentStream: () => [] }));
vi.mock('../selfImproveStore', () => {
  const hook = (sel: (s: unknown) => unknown) => sel({ phase: si.phase, history: [] });
  // zustand stores expose getState() as a static — MaestroView reads it in the tab initializer.
  (hook as unknown as { getState: () => unknown }).getState = () => ({ phase: si.phase, history: [] });
  return { useSelfImproveStore: hook };
});
vi.mock('../skillsStore', () => ({ useSkillsStore: (sel: (s: unknown) => unknown) => sel({ drafts: [] }) }));
vi.mock('../SelfImprove', () => ({ SelfImprove: () => <div>SELF_IMPROVE_TAB</div> }));
vi.mock('../SkillsPanel', () => ({ SkillsPanel: () => null }));
vi.mock('../Timeline', () => ({ Timeline: () => null }));
vi.mock('../NewAgentDialog', () => ({ NewAgentDialog: () => null }));

import { MaestroView } from '../MaestroView';

describe('MaestroView default tab vs empty state', () => {
  beforeEach(() => { si.phase = 'idle'; });

  it('phase=idle: opens on Sessões → empty state visible', () => {
    si.phase = 'idle';
    render(<MaestroView onBack={() => {}} />);
    expect(screen.queryByText('Nenhuma sessão selecionada')).toBeTruthy();
  });

  it('phase=ready (finished/awaiting-review, persisted): still opens on Sessões → empty state visible (the fix)', () => {
    si.phase = 'ready';
    render(<MaestroView onBack={() => {}} />);
    expect(screen.queryByText('Nenhuma sessão selecionada')).toBeTruthy();
  });

  it('phase=failed (persisted terminal): still opens on Sessões → empty state visible', () => {
    si.phase = 'failed';
    render(<MaestroView onBack={() => {}} />);
    expect(screen.queryByText('Nenhuma sessão selecionada')).toBeTruthy();
  });

  it('phase=working (actively in flight): opens on Melhorar — intent preserved', () => {
    si.phase = 'working';
    render(<MaestroView onBack={() => {}} />);
    expect(screen.queryByText('Nenhuma sessão selecionada')).toBeNull();
    expect(screen.queryByText('SELF_IMPROVE_TAB')).toBeTruthy();
  });
});
