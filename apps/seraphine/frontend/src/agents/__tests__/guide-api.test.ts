/** Phase 6c part 1: validators of messages, proposals (each kind, each status) and versions, the new calls and the `version` tolerance. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api';
import { makeAgent } from './fixtures';
import { makeGuideMessage, makeGuideReply, makeVersion, wireProposal } from './guide-fixtures';
import { makeRoutine } from './routines-fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let calls: { url: string; init?: RequestInit }[] = [];
function serve(answer: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/agents/bootstrap')) return jsonResponse({ token: 'tok' });
      calls.push({ url: String(url), init });
      return jsonResponse(answer, status);
    }),
  );
}
const body = (i: number): unknown => JSON.parse(String(calls[i].init?.body));

beforeEach(() => {
  api.resetToken();
  calls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('conversation message validator', () => {
  it('reads both authors and gives an owner message an empty `proposal_ids`', () => {
    expect(api.checkGuideMessage(makeGuideReply(), 'x')).toEqual(makeGuideReply());
    const { proposal_ids: _gone, ...owner } = makeGuideMessage();
    expect(api.checkGuideMessage(owner, 'x').proposal_ids).toEqual([]);
  });

  it('refuses an unknown author, a missing body and a mistyped list', () => {
    expect(() => api.checkGuideMessage({ ...makeGuideMessage(), author: 'agent' }, 'x')).toThrow();
    expect(() => api.checkGuideMessage({ ...makeGuideMessage(), body: undefined }, 'x')).toThrow();
    expect(() => api.checkGuideMessage({ ...makeGuideMessage(), proposal_ids: 'pr1' }, 'x')).toThrow();
    expect(() => api.checkGuideMessage({ ...makeGuideMessage(), created_at: 3 }, 'x')).toThrow();
    expect(() => api.checkGuideMessage('oi', 'x')).toThrow();
  });
});

describe('proposal validator', () => {
  it('reads an update_agent proposal with before, target and dates', () => {
    const p = api.checkProposal(wireProposal('update_agent'), 'x');
    expect(p.payload).toEqual({ kind: 'update_agent', agent_id: 'lia', changes: { instructions: 'Responda sempre de forma direta e curta.' } });
    expect(p.before).toEqual({ instructions: 'Ajude com lembretes e listas, falando simples.' });
    expect(p.target).toEqual({ agent_id: 'lia' });
    expect(p.status).toBe('pending');
    expect(p.expires_at).toBe('2026-11-13T12:00:05Z');
    expect(p.decided_at).toBeNull();
  });

  it('reads create_agents (1 to 5 drafts with their routines), create_routine and update_routine', () => {
    const create = api.checkProposal(wireProposal('create_agents'), 'x');
    expect(create.payload.kind === 'create_agents' && create.payload.agents.map((a) => a.name)).toEqual(['Bia', 'Caio']);
    expect(create.payload.kind === 'create_agents' && create.payload.agents[0].routines?.[0].title).toBe('Resumo da semana');
    expect(create.before).toBeNull();
    const routine = api.checkProposal(wireProposal('create_routine'), 'x');
    expect(routine.payload).toMatchObject({ kind: 'create_routine', agent_id: 'lia', routine: { title: 'Revisão do dia', schedule: { kind: 'weekdays', time: '18:00' }, report: 'news' } });
    const update = api.checkProposal(wireProposal('update_routine'), 'x');
    expect(update.payload).toEqual({ kind: 'update_routine', routine_id: 'rt1', changes: { schedule: { kind: 'weekdays', time: '07:00' } } });
    expect(update.before).toEqual({ schedule: { kind: 'weekdays', time: '08:00' }, schedule_text: 'Todo dia útil às 08:00' });
    const toggle = api.checkProposal(wireProposal('update_routine', { payload: { routine_id: 'rt1', changes: { enabled: false } } }), 'x');
    expect(toggle.payload).toMatchObject({ changes: { enabled: false } });
  });

  it('keeps the output-only `schedule_text` of a routine proposal (payload and before) and does not require it', () => {
    const p = api.checkProposal(
      wireProposal('update_routine', {
        payload: { routine_id: 'rt1', schedule_text: 'Todo dia útil às 07:00', changes: { schedule: { kind: 'weekdays', time: '07:00' } } },
        before: { schedule: { kind: 'weekdays', time: '08:00' }, schedule_text: 'Todo dia útil às 08:00' },
      }),
      'x',
    );
    expect(p.payload).toMatchObject({ changes: { schedule_text: 'Todo dia útil às 07:00' } });
    expect(p.before?.schedule_text).toBe('Todo dia útil às 08:00');
    const c = api.checkProposal(wireProposal('create_routine', { payload: { agent_id: 'lia', title: 'x', prompt: 'y', schedule: { kind: 'daily', time: '07:00' }, schedule_text: 'Todo dia às 07:00' } }), 'x');
    expect(c.payload.kind === 'create_routine' && c.payload.routine.schedule_text).toBe('Todo dia às 07:00');
  });

  it('accepts every status and keeps `detail` and `result`', () => {
    for (const status of ['pending', 'applied', 'dismissed', 'expired', 'stale', 'failed']) {
      expect(api.checkProposal(wireProposal('update_agent', { status }), 'x').status).toBe(status);
    }
    const applied = api.checkProposal(
      wireProposal('create_agents', { status: 'applied', decided_at: '2026-11-12T13:00:00Z', result: { agent_ids: ['a1'], routine_ids: ['r1'], failed: [{ name: 'Caio', detail: 'Já existe um agente com esse nome.' }] } }),
      'x',
    );
    expect(applied.result).toEqual({ agent_ids: ['a1'], routine_ids: ['r1'], failed: [{ name: 'Caio', detail: 'Já existe um agente com esse nome.' }] });
    const stale = api.checkProposal(wireProposal('update_agent', { status: 'stale', detail: 'O agente mudou depois desta proposta.' }), 'x');
    expect(stale.detail).toBe('O agente mudou depois desta proposta.');
    // The backend sends a `detail` only for a state that has a reason: its absence reads as ''.
    const { detail: _gone, ...noDetail } = wireProposal('update_agent');
    expect(api.checkProposal(noDetail, 'x').detail).toBe('');
  });

  it('refuses an unknown kind or status and a payload that is not the shape of its kind', () => {
    expect(() => api.checkProposal(wireProposal('update_agent', { kind: 'delete_agent' }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { status: 'maybe' }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { title: undefined }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { payload: { agent_id: 'lia', changes: {} } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { payload: { agent_id: 'lia', changes: { suggestions: 'muitas' } } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { payload: { changes: { name: 'Bia' } } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('create_agents', { payload: { agents: [] } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('create_routine', { payload: { agent_id: 'lia', title: 'x', prompt: 'y' } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_routine', { payload: { routine_id: 'rt1', changes: { schedule: { kind: 'daily' } } } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_routine', { payload: { routine_id: 'rt1', changes: { enabled: 'sim' } } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { result: { agent_ids: 'a1' } }), 'x')).toThrow();
    expect(() => api.checkProposal(wireProposal('update_agent', { expires_at: 12 }), 'x')).toThrow();
    expect(() => api.checkProposal(null, 'x')).toThrow();
  });
});

describe('version validator', () => {
  it('reads a version with every field and refuses an unknown author of the change or field', () => {
    const v = makeVersion({ version: 3, changed_by: 'guide', note: 'Mudança pedida na conversa com a Seraphine.', changed_fields: ['name', 'instructions'] });
    expect(api.checkAgentVersion(v, 'x')).toEqual(v);
    for (const by of ['owner', 'guide', 'pack', 'restore']) expect(api.checkAgentVersion({ ...v, changed_by: by }, 'x').changed_by).toBe(by);
    expect(() => api.checkAgentVersion({ ...v, changed_by: 'robot' }, 'x')).toThrow();
    expect(() => api.checkAgentVersion({ ...v, changed_fields: ['color'] }, 'x')).toThrow();
    expect(() => api.checkAgentVersion({ ...v, version: '3' }, 'x')).toThrow();
    expect(() => api.checkAgentVersion({ ...v, suggestions: 'uma' }, 'x')).toThrow();
    const { note: _gone, ...noNote } = v;
    expect(() => api.checkAgentVersion(noNote, 'x')).toThrow();
  });
});

describe('agent `version`', () => {
  it('reads as 0 when an older backend does not send it, and a wrong type is a contract break', () => {
    const { version: _gone, ...older } = makeAgent();
    expect(api.checkAgent(older, 'x').version).toBe(0);
    expect(api.checkAgent({ ...older, version: 4 }, 'x').version).toBe(4);
    expect(() => api.checkAgent({ ...older, version: '4' }, 'x')).toThrow();
    expect(() => api.checkAgent({ ...older, version: -1 }, 'x')).toThrow();
  });
});

describe('the calls', () => {
  it('lists the conversation (GET with a limit) and parses messages and proposals', async () => {
    serve({ messages: [makeGuideMessage(), makeGuideReply()], proposals: [wireProposal('update_agent')] });
    const res = await api.listGuideMessages();
    expect(calls[0].url).toContain('/agents/guide/messages?limit=200');
    expect(calls[0].init?.method).toBe('GET');
    expect(res.messages.map((m) => m.id)).toEqual(['gm1', 'gm2']);
    expect(res.proposals[0].payload.kind).toBe('update_agent');
  });

  it('refuses an answer that is not the documented shape', async () => {
    serve({ messages: 'nada', proposals: [] });
    await expect(api.listGuideMessages()).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('sends a message with `about` only when it is given, and parses message, reply and proposals', async () => {
    const answer = { message: makeGuideMessage(), reply: makeGuideReply(), proposals: [wireProposal('update_agent')] };
    serve(answer);
    const res = await api.sendGuideMessage({ body: 'Sobre Lia: deixe mais direta', about: { agent_id: 'lia' } });
    expect(calls[0].url).toContain('/agents/guide/messages');
    expect(calls[0].init?.method).toBe('POST');
    expect(body(0)).toEqual({ body: 'Sobre Lia: deixe mais direta', about: { agent_id: 'lia' } });
    expect(res.reply.author).toBe('seraphine');
    expect(res.proposals).toHaveLength(1);
    serve(answer);
    calls = [];
    await api.sendGuideMessage({ body: 'oi' });
    expect(body(0)).toEqual({ body: 'oi' });
    serve(answer);
    calls = [];
    await api.sendGuideMessage({ body: 'oi', about: {} });
    expect(body(0)).toEqual({ body: 'oi' });
  });

  it('keeps the code of a 503 and of a 409 on the error', async () => {
    serve({ detail: 'A Seraphine não respondeu a tempo.', code: 'guide_unavailable' }, 503);
    await expect(api.sendGuideMessage({ body: 'oi' })).rejects.toMatchObject({ status: 503, code: 'guide_unavailable', detail: 'A Seraphine não respondeu a tempo.' });
    serve({ detail: { message: 'Ocupada', code: 'guide_busy' } }, 409);
    await expect(api.sendGuideMessage({ body: 'oi' })).rejects.toMatchObject({ status: 409, code: 'guide_busy' });
  });

  it('clears the conversation with DELETE', async () => {
    serve({ ok: true });
    await expect(api.clearGuideConversation()).resolves.toBeUndefined();
    expect(calls[0].init?.method).toBe('DELETE');
    serve({ ok: false });
    await expect(api.clearGuideConversation()).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('applies a proposal and parses the proposal with the agents and routines it touched', async () => {
    serve({ proposal: wireProposal('create_agents', { status: 'applied' }), agents: [makeAgent({ id: 'a1', name: 'Bia' })], routines: [makeRoutine({ id: 'r1' })] });
    const res = await api.applyProposal('pr 1');
    expect(calls[0].url).toContain('/agents/guide/proposals/pr%201/apply');
    expect(calls[0].init?.method).toBe('POST');
    expect(res.proposal.status).toBe('applied');
    expect(res.agents[0].version).toBe(0);
    expect(res.routines[0].id).toBe('r1');
    serve({ proposal: wireProposal('update_agent'), agents: [makeAgent()] });
    await expect(api.applyProposal('pr1')).rejects.toMatchObject({ name: 'ApiError' });
  });

  it('dismisses a proposal', async () => {
    serve({ proposal: wireProposal('update_agent', { status: 'dismissed' }) });
    const p = await api.dismissProposal('pr1');
    expect(calls[0].url).toContain('/agents/guide/proposals/pr1/dismiss');
    expect(p.status).toBe('dismissed');
  });

  it('lists the versions of an agent and restores one', async () => {
    serve({ versions: [makeVersion({ version: 2, note: 'Voltou para a versão 1.', changed_by: 'restore' }), makeVersion()] });
    const versions = await api.listAgentVersions('lia');
    expect(calls[0].url).toContain('/agents/defs/lia/versions');
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    serve({ def: makeAgent({ id: 'lia', version: 3 }), version: makeVersion({ version: 3, changed_by: 'restore' }) });
    calls = [];
    const res = await api.restoreAgentVersion('lia', 1);
    expect(calls[0].url).toContain('/agents/defs/lia/versions/1/restore');
    expect(calls[0].init?.method).toBe('POST');
    expect(res.def.version).toBe(3);
    expect(res.version.changed_by).toBe('restore');
  });

  it('a 404 on the conversation or on the versions is an ApiError with status 404 (an older backend)', async () => {
    serve({ detail: 'Not Found' }, 404);
    await expect(api.listGuideMessages()).rejects.toMatchObject({ status: 404 });
    await expect(api.listAgentVersions('lia')).rejects.toMatchObject({ status: 404 });
  });
});
