import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgent, makeApproval, makeEvent, makeProject, makeRun } from './fixtures';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    ensureToken: vi.fn(),
    openGlobalSocket: vi.fn(() => () => undefined),
    decideApproval: vi.fn(),
    getOverview: vi.fn(),
    getRun: vi.fn(),
    listMessages: vi.fn(),
    listRunEvents: vi.fn(),
  };
});

import * as api from '../api';
import { ApiError } from '../api';
import { ApprovalCard } from '../components';
import { HomeScreen } from '../HomeScreen';
import { ConfirmProvider } from '../../ui';
import { expiryLine } from '../lib';
import { resetAgentsStore, useAgentsStore, pendingApprovalsOf } from '../store';
import type { Approval } from '../types';

const mocked = vi.mocked(api);
const DIGEST = 'd1'.repeat(32);

/** Put the approval in the store (the card decides through it) and render its card. */
function renderCard(over: Partial<Approval> = {}): void {
  const approval = makeApproval(over);
  useAgentsStore.setState({
    harnessState: 'ready',
    projects: [makeProject()],
    agents: [makeAgent()],
    approvals: { [approval.id]: approval },
  });
  mocked.getOverview.mockResolvedValue({ pending_approvals: [approval], active_runs: [], spend_today: [] });
  render(
    <ConfirmProvider>
      <ApprovalCard approval={approval} variant="thread" />
    </ConfirmProvider>,
  );
}

const click = (name: string | RegExp): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

beforeEach(() => {
  resetAgentsStore();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('ApprovalCard risk', () => {
  it.each([
    ['low', 'Risco baixo'],
    ['medium', 'Risco médio'],
    ['high', 'Risco alto'],
  ] as const)('shows the label for %s risk next to the title', (level, label) => {
    renderCard({ risk_level: level });
    const title = screen.getByText('Voltar a loja para a versão anterior');
    expect(within(title.parentElement as HTMLElement).getByText(label)).toBeTruthy();
  });

  it('lists the risk reasons under the command and keeps the whole command visible', () => {
    const long = `Get-ChildItem ${'C:\\muito\\longo\\'.repeat(40)}`;
    renderCard({
      risk_level: 'high',
      command: long,
      risk_reasons: ['Apaga arquivos sem volta.', 'Mexe fora da pasta do projeto.'],
    });
    expect(screen.getByText('Apaga arquivos sem volta.')).toBeTruthy();
    expect(screen.getByText('Mexe fora da pasta do projeto.')).toBeTruthy();
    expect(screen.getByText(long).textContent).toBe(long);
    expect(screen.getByText(long).tagName).toBe('PRE');
  });

  it('shows no reasons list when there are none', () => {
    renderCard({ risk_level: 'low', risk_reasons: [] });
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('renders an approval from before approvals v2 (no new fields) as medium risk without expiry', () => {
    const legacy: Record<string, unknown> = { ...makeApproval() };
    for (const key of ['risk_level', 'risk_reasons', 'command_digest', 'expires_at', 'decided_by', 'decision_note']) delete legacy[key];
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], approvals: { ap1: legacy as unknown as Approval } });
    render(<ApprovalCard approval={legacy as unknown as Approval} />);
    expect(screen.getByText('Risco médio')).toBeTruthy();
    expect(screen.queryByText(/Expira/)).toBeNull();
    expect(screen.getByText('git revert HEAD && ./deploy.sh')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
  });

  it('an approval_request event without the new fields becomes a renderable card', () => {
    mocked.getRun.mockResolvedValue(makeRun());
    mocked.getOverview.mockResolvedValue({ pending_approvals: [], active_runs: [], spend_today: [] });
    useAgentsStore.setState({ harnessState: 'ready', agents: [makeAgent()], runs: { r1: makeRun() } });
    useAgentsStore.getState().handleEvent(
      makeEvent({
        id: 9,
        kind: 'approval_request',
        payload: { approval_id: 'old1', title: 'Rodar o teste', command: 'pytest -q', reason: 'quero testar' },
      }),
    );
    const approval = useAgentsStore.getState().approvals.old1;
    render(<ApprovalCard approval={approval} />);
    expect(screen.getByText('Risco médio')).toBeTruthy();
    expect(screen.getByText('pytest -q')).toBeTruthy();
  });
});

describe('ApprovalCard expiry line', () => {
  it('formats today and not-today with the shared time helper', () => {
    const now = new Date(2026, 0, 1, 9, 0);
    expect(expiryLine(new Date(2026, 0, 1, 14, 30).toISOString(), now)).toBe('Expira às 14:30');
    expect(expiryLine(new Date(2026, 0, 2, 14, 30).toISOString(), now)).toBe('Expira amanhã às 14:30');
    expect(expiryLine(new Date(2026, 0, 5, 8, 5).toISOString(), now)).toBe('Expira em 05/01 às 08:05');
    expect(expiryLine(new Date(2026, 0, 1, 8, 0).toISOString(), now)).toBe('Expirou às 08:00');
    expect(expiryLine(null, now)).toBe('');
  });

  it('shows the line on the card', () => {
    renderCard({ expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(screen.getByText(/^Expira /)).toBeTruthy();
  });
});

describe('ApprovalCard deciding', () => {
  it('low risk: one click on Aprovar sends the digest', async () => {
    mocked.decideApproval.mockResolvedValue(makeApproval({ status: 'approved' }));
    renderCard({ risk_level: 'low' });
    click('Aprovar');
    await waitFor(() => expect(mocked.decideApproval).toHaveBeenCalledTimes(1));
    expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'approve', {
      digest: DIGEST,
      confirmHighRisk: undefined,
      note: undefined,
    });
  });

  it('high risk: the first click only asks again; the second sends confirm_high_risk', async () => {
    mocked.decideApproval.mockResolvedValue(makeApproval({ status: 'approved' }));
    renderCard({ risk_level: 'high', risk_reasons: ['Apaga arquivos.'] });
    click('Aprovar');
    expect(mocked.decideApproval).not.toHaveBeenCalled();
    expect(screen.getByText('Este comando tem risco alto. Ele será executado no seu computador.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
    click('Aprovar mesmo assim');
    await waitFor(() => expect(mocked.decideApproval).toHaveBeenCalledTimes(1));
    expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'approve', {
      digest: DIGEST,
      confirmHighRisk: true,
      note: undefined,
    });
  });

  it('Voltar leaves the confirmation without sending anything', () => {
    renderCard({ risk_level: 'high' });
    click('Aprovar');
    click('Voltar');
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    expect(mocked.decideApproval).not.toHaveBeenCalled();
  });

  it('Negar decides at once', async () => {
    mocked.decideApproval.mockResolvedValue(makeApproval({ status: 'denied', decided_by: 'owner' }));
    renderCard();
    click('Negar');
    await waitFor(() =>
      expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'deny', { digest: DIGEST, confirmHighRisk: undefined, note: undefined }),
    );
  });

  it('Negar com motivo sends the text as note (max 500 characters, visible label)', async () => {
    mocked.decideApproval.mockResolvedValue(makeApproval({ status: 'denied', decision_note: 'Use o outro script.' }));
    renderCard();
    click('Negar com motivo');
    const field = screen.getByLabelText(/Motivo para negar/) as HTMLTextAreaElement;
    expect(field.maxLength).toBe(500);
    const send = screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(field, { target: { value: 'Use o outro script.' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(mocked.decideApproval).toHaveBeenCalledTimes(1));
    expect(mocked.decideApproval).toHaveBeenCalledWith('ap1', 'deny', {
      digest: DIGEST,
      confirmHighRisk: undefined,
      note: 'Use o outro script.',
    });
  });

  it('disables both actions while sending and a double click sends one request', async () => {
    let finish: (a: Approval) => void = () => undefined;
    mocked.decideApproval.mockReturnValue(new Promise<Approval>((r) => (finish = r)));
    renderCard({ risk_level: 'low' });
    const approve = screen.getByRole('button', { name: 'Aprovar' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(mocked.decideApproval).toHaveBeenCalledTimes(1);
    const busy = await screen.findByRole('button', { name: 'Aprovando…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Negar' }) as HTMLButtonElement).disabled).toBe(true);
    finish(makeApproval({ status: 'approved' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Aprovando…' })).toBeNull());
  });
});

describe('ApprovalCard errors from deciding', () => {
  it.each([
    ['digest_mismatch', 'O pedido mudou desde que esta tela foi carregada. Confira o comando de novo.'],
    ['high_risk_unconfirmed', 'Este comando tem risco alto e precisa de uma segunda confirmação. Toque em "Aprovar mesmo assim".'],
    ['approval_expired', 'Este pedido expirou. Peça ao agente para tentar de novo.'],
    ['already_decided', 'Este pedido já foi respondido. Nada mais a fazer aqui.'],
    ['run_not_waiting', 'O agente não está mais esperando esta resposta. Peça a ele para tentar de novo.'],
  ])('%s shows its sentence on the card', async (code, text) => {
    mocked.decideApproval.mockRejectedValue(new ApiError(409, 'msg do servidor', code));
    renderCard({ risk_level: 'low' });
    click('Aprovar');
    const sentence = await screen.findByText(text);
    expect(sentence.getAttribute('role')).toBe('alert');
    expect(screen.queryByText(code)).toBeNull();
    expect(screen.queryByText('msg do servidor')).toBeNull();
  });

  it('digest_mismatch reloads the approvals', async () => {
    mocked.decideApproval.mockRejectedValue(new ApiError(409, 'x', 'digest_mismatch'));
    renderCard({ risk_level: 'high' });
    mocked.getOverview.mockClear();
    click('Aprovar');
    click('Aprovar mesmo assim');
    await screen.findByText(/O pedido mudou/);
    expect(mocked.getOverview).toHaveBeenCalled();
  });

  it('a final answer (already decided) stops offering the buttons', async () => {
    mocked.decideApproval.mockRejectedValue(new ApiError(409, 'x', 'already_decided'));
    renderCard({ risk_level: 'low' });
    click('Aprovar');
    await screen.findByText(/já foi respondido/);
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
  });

  it('an unknown failure keeps the server text and the buttons', async () => {
    mocked.decideApproval.mockRejectedValue(new Error('sem rede'));
    renderCard({ risk_level: 'low' });
    click('Aprovar');
    expect(await screen.findByText('sem rede')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
  });
});

describe('decided states', () => {
  const show = (over: Partial<Approval>): void => {
    useAgentsStore.setState({ agents: [makeAgent()] });
    render(<ApprovalCard approval={makeApproval(over)} />);
  };

  it('approved', () => {
    show({ status: 'approved', decided_by: 'owner' });
    expect(screen.getByRole('status').textContent).toBe('Você aprovou. Forja está seguindo com isso.');
  });
  it('denied by the owner, with and without a note', () => {
    show({ status: 'denied', decided_by: 'owner' });
    expect(screen.getByRole('status').textContent).toBe('Você negou. Forja parou aqui e nada foi alterado.');
    cleanup();
    show({ status: 'denied', decided_by: 'owner', decision_note: 'Use o outro script.' });
    expect(screen.getByRole('status').textContent).toBe(
      'Você negou. Forja parou aqui e nada foi alterado. Motivo: Use o outro script.',
    );
  });
  it('denied automatically', () => {
    show({ status: 'denied', decided_by: 'harness', decision_note: 'Mexe nos dados da Seraphine.' });
    expect(screen.getByRole('status').textContent).toBe('Recusado automaticamente: Mexe nos dados da Seraphine.');
  });
  it('expired', () => {
    show({ status: 'expired', decided_by: 'harness' });
    expect(screen.getByRole('status').textContent).toBe('Expirou sem resposta. Nada foi executado.');
  });
});

describe('store: expired result', () => {
  it('removes the approval from the pending list live and from the home screen', async () => {
    mocked.getRun.mockResolvedValue(makeRun());
    mocked.listMessages.mockResolvedValue([]);
    useAgentsStore.setState({
      harnessState: 'ready',
      agents: [makeAgent()],
      projects: [makeProject()],
      runs: { r1: makeRun({ status: 'waiting_approval' }) },
      approvals: { ap1: makeApproval() },
    });
    render(
      <ConfirmProvider>
        <HomeScreen />
      </ConfirmProvider>,
    );
    expect(screen.getByRole('button', { name: 'Aprovar' })).toBeTruthy();
    useAgentsStore.getState().handleEvent(
      makeEvent({
        id: 20,
        kind: 'approval_result',
        payload: { approval_id: 'ap1', decision: 'expired', title: 'Voltar a loja', decided_by: 'harness', note: null },
      }),
    );
    expect(useAgentsStore.getState().approvals.ap1.status).toBe('expired');
    expect(pendingApprovalsOf(useAgentsStore.getState().approvals)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull());
    expect(screen.getByText('Nada espera sua decisão agora.')).toBeTruthy();
  });
});
