/* A tela mostrando o estado certo — o teste que o bug original teria reprovado.
 *
 * Integração de verdade: só `../api` é falsificado. `useSessions` (o poller) e
 * `deriveStatus` (a regra) rodam de verdade, então isto falha se a fiação entre
 * eles e as linhas da lista se soltar.
 *
 * O ponto central: `useAgentStream` devolve [] — NENHUMA sessão é "própria".
 * Era exatamente isso que a regra antiga exigia para dizer RODANDO, e por isso
 * uma sessão de terminal, escrevendo agora, aparecia como OCIOSA.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const MIN = 60 * 1000;
const HORA = 60 * MIN;

const agora = Date.now();

const SESSOES = [
  // Escreveu há 10s. Nunca apareceu num init — não é própria.
  { session_id: 'aaaa1111-viva', slug: 'repo-vivo', cwd: '/repos/vivo', last_modified_ms: agora - 10_000 },
  // Parada há 1h, mas o último turno fechou com end_turn.
  { session_id: 'bbbb2222-vez', slug: 'repo-suavez', cwd: '/repos/suavez', last_modified_ms: agora - HORA },
  // Parada há 2 dias e interrompida no meio de uma ferramenta.
  { session_id: 'cccc3333-fria', slug: 'repo-ociosa', cwd: '/repos/ociosa', last_modified_ms: agora - 48 * HORA },
];

const TRANSCRIPTS: Record<string, unknown[]> = {
  'repo-vivo': [{ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] } }],
  'repo-suavez': [{ type: 'assistant', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'pronto, dá uma olhada' }] } }],
  'repo-ociosa': [{ type: 'assistant', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit' }] } }],
};

vi.mock('../api', () => ({
  listSessions: vi.fn(async () => SESSOES),
  listHosts: vi.fn(async () => []),
  readTranscript: vi.fn(async (slug: string) => TRANSCRIPTS[slug] ?? []),
  sendToAgent: vi.fn(), stopAgent: vi.fn(), respondPermission: vi.fn(),
  resumeSession: vi.fn(), forkSession: vi.fn(), checkHost: vi.fn(), listRemoteSessions: vi.fn(),
}));
// Sem stream vivo: nenhuma sessão é própria, nenhuma tem evento de permissão.
vi.mock('../useAgentStream', () => ({ useAgentStream: () => [] }));

const aprovacoes = vi.hoisted(() => ({
  enabled: false, pending: [] as unknown[], busy: null, rules: [] as unknown[],
  init: async () => {}, setEnabled: async () => {}, resolve: async () => {}, saveRules: async () => {},
}));
vi.mock('../approvalsStore', () => ({
  useApprovalsStore: (sel: (s: unknown) => unknown) => sel(aprovacoes),
}));
vi.mock('../selfImproveStore', () => {
  const hook = (sel: (s: unknown) => unknown) => sel({ phase: 'idle', history: [] });
  (hook as unknown as { getState: () => unknown }).getState = () => ({ phase: 'idle', history: [] });
  return { useSelfImproveStore: hook };
});
vi.mock('../skillsStore', () => ({ useSkillsStore: (sel: (s: unknown) => unknown) => sel({ drafts: [] }) }));
vi.mock('../SelfImprove', () => ({ SelfImprove: () => null }));
vi.mock('../SkillsPanel', () => ({ SkillsPanel: () => null }));
vi.mock('../Timeline', () => ({ Timeline: () => null }));
vi.mock('../NewAgentDialog', () => ({ NewAgentDialog: () => null }));

import { MaestroView } from '../MaestroView';

/** A linha da lista que contém este cwd. */
function linha(cwd: string): HTMLElement {
  const el = screen.getByText(cwd).closest('.maestro__row');
  if (!el) throw new Error(`sem linha para ${cwd}`);
  return el as HTMLElement;
}

describe('MaestroView: o status das linhas vem de deriveStatus', () => {
  it('sessão que acabou de escrever e NÃO é própria aparece como RODANDO', async () => {
    render(<MaestroView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('/repos/vivo')).toBeTruthy());

    // A regra antiga exigia `owned` aqui e cairia em OCIOSA. Este é o bug.
    expect(linha('/repos/vivo').textContent).toContain('RODANDO');
    expect(linha('/repos/vivo').className).toContain('maestro__row--running');
    // E continua marcada como observada — o selo não usa a mesma regra.
    expect(linha('/repos/vivo').textContent).toContain('observada');
  });

  it('sessão parada há 1h que fechou limpo aparece como SUA VEZ, com a classe própria', async () => {
    render(<MaestroView onBack={() => {}} />);
    await waitFor(() => expect(linha('/repos/suavez').textContent).toContain('SUA VEZ'));
    expect(linha('/repos/suavez').className).toContain('maestro__row--yourturn');
  });

  it('sessão velha e interrompida continua OCIOSA', async () => {
    render(<MaestroView onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('/repos/ociosa')).toBeTruthy());
    expect(linha('/repos/ociosa').textContent).toContain('OCIOSA');
    expect(linha('/repos/ociosa').className).toContain('maestro__row--idle');
  });

  it('o subtítulo conta rodando, aguardando e sua vez', async () => {
    render(<MaestroView onBack={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText('3 sessões · 1 rodando · 0 aguardando você · 1 na sua vez')).toBeTruthy());
  });

  it('o resumo da última atividade vem do poller, não de um efeito da tela', async () => {
    render(<MaestroView onBack={() => {}} />);
    await waitFor(() => expect(linha('/repos/suavez').textContent).toContain('pronto, dá uma olhada'));
    expect(linha('/repos/vivo').textContent).toContain('→ Bash');
  });
});
