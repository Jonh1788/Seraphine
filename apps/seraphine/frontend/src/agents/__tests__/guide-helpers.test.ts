/** Phase 6c part 1: the pure helpers (states, deadline, before/after rows, summaries, suggestions, history wording). */
import { describe, expect, it } from 'vitest';
import {
  aboutLabel,
  agentChangeRows,
  changedByWords,
  changedFieldsLine,
  deadlineLine,
  effectiveStatus,
  guideSuggestions,
  pendingProposalCount,
  pendingProposalsLine,
  pendingProposalsSubtitle,
  proposalSummary,
  routineChangeRows,
  versionDiffRows,
} from '../guide';
import { makeAgent } from './fixtures';
import { makeProposal, makeVersion } from './guide-fixtures';
import { makeRoutine } from './routines-fixtures';

const NOW = new Date(2026, 10, 12, 10, 0, 0);
const at = (d: number, h: number, m = 0): string => new Date(2026, 10, d, h, m, 0).toISOString();

describe('states and deadline', () => {
  it('a pending proposal past its deadline reads as expired on this clock', () => {
    const p = makeProposal('update_agent', { expires_at: at(12, 9) });
    expect(effectiveStatus(p, NOW)).toBe('expired');
    expect(effectiveStatus({ ...p, expires_at: at(13, 14) }, NOW)).toBe('pending');
    expect(effectiveStatus({ ...p, status: 'applied', expires_at: at(12, 9) }, NOW)).toBe('applied');
  });

  it('words the deadline with the date helper and says nothing once decided', () => {
    expect(deadlineLine(makeProposal('update_agent', { expires_at: at(13, 14) }), NOW)).toBe('Vale até amanhã às 14:00');
    expect(deadlineLine(makeProposal('update_agent', { expires_at: at(12, 18) }), NOW)).toBe('Vale até hoje às 18:00');
    expect(deadlineLine(makeProposal('update_agent', { status: 'applied', expires_at: at(13, 14) }), NOW)).toBe('');
    expect(deadlineLine(makeProposal('update_agent', { expires_at: null }), NOW)).toBe('');
  });

  it('counts only the proposals that wait, in the singular and the plural', () => {
    const list = {
      a: makeProposal('update_agent', { id: 'a', expires_at: at(13, 14) }),
      b: makeProposal('update_agent', { id: 'b', status: 'dismissed' }),
      c: makeProposal('update_agent', { id: 'c', expires_at: at(12, 9) }),
      d: makeProposal('create_routine', { id: 'd', expires_at: at(14, 9) }),
    };
    expect(pendingProposalCount(list, NOW)).toBe(2);
    expect(pendingProposalsLine(1)).toBe('A Seraphine tem 1 proposta esperando');
    expect(pendingProposalsLine(3)).toBe('A Seraphine tem 3 propostas esperando');
    expect(pendingProposalsSubtitle(1)).toBe('uma proposta da Seraphine espera sua decisão');
    expect(pendingProposalsSubtitle(2)).toBe('2 propostas da Seraphine esperam sua decisão');
  });
});

describe('before and after rows', () => {
  it('shows each changed agent field with its before taken from the proposal', () => {
    const p = makeProposal('update_agent', {
      payload: { agent_id: 'lia', changes: { name: 'Beatriz', suggestions: ['Uma', 'Duas'] } },
      before: { name: 'Bia', suggestions: ['Antiga'] },
    });
    if (p.payload.kind !== 'update_agent') throw new Error('kind');
    const rows = agentChangeRows(p.payload.changes, p.before);
    expect(rows.map((r) => r.label)).toEqual(['Nome', 'Sugestões']);
    expect(rows[0]).toMatchObject({ before: ['Bia'], after: ['Beatriz'], list: false });
    expect(rows[1]).toMatchObject({ before: ['Antiga'], after: ['Uma', 'Duas'], list: true });
  });

  it('keeps `before` unknown (null) when the proposal does not carry it', () => {
    const rows = agentChangeRows({ role: 'Viagens' }, null);
    expect(rows[0].before).toBeNull();
  });

  it('words a schedule change with the two sentences, computing the one it lacks', () => {
    const p = makeProposal('update_routine', {
      payload: { routine_id: 'rt1', changes: { schedule: { kind: 'weekly', time: '07:00', days: [4] }, enabled: true } },
      before: { schedule: { kind: 'weekdays', time: '08:00' }, enabled: false },
    });
    if (p.payload.kind !== 'update_routine') throw new Error('kind');
    const rows = routineChangeRows(p.payload.changes, p.before);
    expect(rows.map((r) => r.label)).toEqual(['Horário', 'Situação']);
    expect(rows[0].before).toEqual(['Todo dia útil às 08:00']);
    expect(rows[0].after).toEqual(['Toda sexta às 07:00']);
    expect(rows[1]).toMatchObject({ before: ['Pausada'], after: ['Ligada'] });
  });

  it('prefers the sentence the backend sent over the one computed here', () => {
    const rows = routineChangeRows({ schedule: { kind: 'daily', time: '07:00' }, schedule_text: 'Todo dia às 07:00 (horário do PC)' }, { schedule_text: 'Todo dia útil às 08:00' });
    expect(rows[0].after).toEqual(['Todo dia às 07:00 (horário do PC)']);
    expect(rows[0].before).toEqual(['Todo dia útil às 08:00']);
  });

  it('compares a version with the one below it, only on the fields it changed', () => {
    const v1 = makeVersion({ version: 1 });
    const v2 = makeVersion({ version: 2, name: 'Beatriz', instructions: 'Seja direta.', changed_fields: ['name', 'instructions'] });
    const rows = versionDiffRows(v2, v1);
    expect(rows.map((r) => r.key)).toEqual(['name', 'instructions']);
    expect(rows[0]).toMatchObject({ before: ['Lia'], after: ['Beatriz'] });
    expect(rows[1].before).toEqual([v1.instructions]);
    expect(versionDiffRows(v1, null)).toEqual([]);
  });
});

describe('sentences', () => {
  const lia = makeAgent({ id: 'lia', name: 'Lia' });
  const rt = makeRoutine({ id: 'rt1', title: 'Pendências do dia' });

  it('says in words what each kind of proposal does', () => {
    expect(proposalSummary(makeProposal('update_agent', { payload: { agent_id: 'lia', changes: { name: 'B', instructions: 'x' } }, before: { name: 'Lia', instructions: 'y' } }), [lia], {})).toBe('Muda o nome e as instruções de Lia.');
    expect(proposalSummary(makeProposal('create_agents'), [lia], {})).toBe('Cria 2 agentes: Bia e Caio.');
    expect(proposalSummary(makeProposal('create_routine'), [lia], {})).toBe('Cria uma rotina para Lia: «Revisão do dia».');
    expect(proposalSummary(makeProposal('update_routine'), [lia], { rt1: rt })).toBe('Muda o horário da rotina «Pendências do dia».');
    const pause = makeProposal('update_routine', { payload: { routine_id: 'rt1', changes: { enabled: false } }, before: { enabled: true } });
    expect(proposalSummary(pause, [lia], { rt1: rt })).toBe('Pausa a rotina «Pendências do dia».');
    const resume = makeProposal('update_routine', { payload: { routine_id: 'rt1', changes: { enabled: true } }, before: { enabled: false } });
    expect(proposalSummary(resume, [lia], { rt1: rt })).toBe('Retoma a rotina «Pendências do dia».');
  });

  it('words who changed an agent and which fields', () => {
    expect(changedByWords('owner')).toBe('você');
    expect(changedByWords('guide')).toBe('a Seraphine, a seu pedido');
    expect(changedByWords('pack')).toBe('um time pronto');
    expect(changedByWords('restore')).toBe('uma volta a uma versão anterior');
    expect(changedFieldsLine(['instructions', 'name'])).toBe('Mudou o nome e as instruções');
    expect(changedFieldsLine(['role', 'description', 'suggestions'])).toBe('Mudou o papel, a descrição e as sugestões');
    expect(changedFieldsLine([])).toBe('');
  });

  it('labels what the next message is about, and nothing for a thing that is gone', () => {
    expect(aboutLabel({ agent_id: 'lia' }, [lia], {})).toBe('Sobre Lia');
    expect(aboutLabel({ routine_id: 'rt1' }, [lia], { rt1: rt })).toBe('Sobre a rotina «Pendências do dia»');
    expect(aboutLabel({ agent_id: 'sumiu' }, [lia], {})).toBe('');
    expect(aboutLabel(undefined, [lia], {})).toBe('');
  });
});

describe('suggestions of the empty conversation', () => {
  it('are four, built from an agent and a routine when they exist', () => {
    const s = guideSuggestions([makeAgent({ id: 'lia', name: 'Lia' })], { rt1: makeRoutine({ title: 'Pendências do dia' }) });
    expect(s).toHaveLength(4);
    expect(s[0]).toContain('Lia');
    expect(s[1]).toContain('«Pendências do dia»');
    expect(new Set(s).size).toBe(4);
  });

  it('are still four, and different, with nothing created yet', () => {
    const s = guideSuggestions([], {});
    expect(s).toHaveLength(4);
    expect(new Set(s).size).toBe(4);
    expect(s.join(' ')).not.toMatch(/undefined|\{/);
  });
});
