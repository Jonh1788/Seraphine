import { describe, expect, it } from 'vitest';
import { classifyTranscriptLine, transcriptToEvents } from '../MaestroView';

describe('classifyTranscriptLine (JS mirror of proto::classify)', () => {
  it('classifies the stream-json line types', () => {
    expect(classifyTranscriptLine({ type: 'system', subtype: 'init', session_id: 'abc' })).toEqual({ kind: 'init', session_id: 'abc' });
    expect(classifyTranscriptLine({ type: 'assistant', message: {} })).toEqual({ kind: 'assistant' });
    expect(classifyTranscriptLine({ type: 'result', subtype: 'success' })).toEqual({ kind: 'result' });
    expect(classifyTranscriptLine({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write' } }))
      .toEqual({ kind: 'permission_request', request_id: 'r1', tool: 'Write' });
    // initialize control_request is NOT a permission ask
    expect(classifyTranscriptLine({ type: 'control_request', request: { subtype: 'initialize' } })).toEqual({ kind: 'other' });
    expect(classifyTranscriptLine({ type: 'user', message: {} })).toEqual({ kind: 'other' });
    expect(classifyTranscriptLine(null)).toEqual({ kind: 'other' });
    expect(classifyTranscriptLine('garbage')).toEqual({ kind: 'other' });
  });
});

describe('transcriptToEvents', () => {
  it('maps lines to AgentEvents keyed by the session id, preserving raw', () => {
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    ];
    const out = transcriptToEvents('s1', lines);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ agent_id: 's1', kind: { kind: 'init', session_id: 's1' }, raw: lines[0] });
    expect(out[1].kind).toEqual({ kind: 'assistant' });
    expect(out[1].raw).toBe(lines[1]);
  });

  it('tolerates an empty / nullish list', () => {
    expect(transcriptToEvents('s1', [])).toEqual([]);
    expect(transcriptToEvents('s1', undefined as unknown as unknown[])).toEqual([]);
  });
});
