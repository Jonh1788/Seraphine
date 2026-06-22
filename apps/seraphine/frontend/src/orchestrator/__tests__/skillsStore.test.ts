import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri bridge BEFORE importing the store. The store wires a
// module-level subscription at load time, which calls ensureSubscribed() ->
// onAgentEvent/onAgentExit (from ../api via agentStreamStore), so those must be
// stubbed too or the import throws.
vi.mock('../api', () => ({
  skillExtract: vi.fn(),
  skillPublish: vi.fn(),
  skillListPublished: vi.fn(),
  onAgentEvent: vi.fn().mockResolvedValue(() => {}),
  onAgentExit: vi.fn().mockResolvedValue(() => {}),
}));

import * as api from '../api';
import { useSkillsStore, parseExtract, jaccard, isDuplicate, countToolCalls, buildTranscript } from '../skillsStore';
import type { AgentEvent, SkillDraft } from '../types';

const mockApi = api as unknown as {
  skillExtract: ReturnType<typeof vi.fn>;
  skillPublish: ReturnType<typeof vi.fn>;
  skillListPublished: ReturnType<typeof vi.fn>;
};

/** A complete extract payload (snake_case `skill_md`, as the model emits). */
function extractPayload(over: Partial<Record<string, unknown>> = {}): string {
  const obj = {
    reusable: true,
    confidence: 0.8,
    name: 'Deploy via push to vps',
    slug: 'deploy-via-push-to-vps',
    skill_md: '--- name: Deploy ---\n## Procedure\nrun git push vps main',
    ...over,
  };
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

beforeEach(() => {
  mockApi.skillExtract.mockReset();
  mockApi.skillPublish.mockReset();
  mockApi.skillListPublished.mockReset();
  mockApi.skillListPublished.mockResolvedValue([]);
  localStorage.clear();
  // Hard reset persisted store state between tests.
  useSkillsStore.setState({ drafts: [], processed: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseExtract', () => {
  it('parses a fenced ```json block and maps skill_md -> skillMd', () => {
    const out = parseExtract(extractPayload());
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      reusable: true,
      confidence: 0.8,
      name: 'Deploy via push to vps',
      slug: 'deploy-via-push-to-vps',
      skillMd: '--- name: Deploy ---\n## Procedure\nrun git push vps main',
    });
  });

  it('parses a bare object with no fence', () => {
    const out = parseExtract(
      'sure, here:\n{"reusable":false,"confidence":0.2,"name":"x","slug":"x","skill_md":"y"} done',
    );
    expect(out).toMatchObject({ reusable: false, confidence: 0.2, name: 'x', slug: 'x', skillMd: 'y' });
  });

  it('returns null on garbage / non-JSON', () => {
    expect(parseExtract('total nonsense, no json here')).toBeNull();
    expect(parseExtract('```json\n{ broken : ,}\n```')).toBeNull();
    expect(parseExtract('')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseExtract('```json\n{"reusable":true,"confidence":0.9}\n```')).toBeNull();
  });
});

describe('jaccard', () => {
  it('identical text -> 1', () => {
    expect(jaccard('git push vps main', 'git push vps main')).toBe(1);
  });
  it('disjoint text -> 0', () => {
    expect(jaccard('alpha beta', 'gamma delta')).toBe(0);
  });
  it('is case-insensitive and token-set based', () => {
    expect(jaccard('Git Push', 'git push')).toBe(1);
  });
  it('two empty strings -> 0 (no division by zero)', () => {
    expect(jaccard('', '')).toBe(0);
  });
});

describe('isDuplicate', () => {
  const existing: SkillDraft[] = [
    {
      id: 'd1',
      name: 'Deploy via push to vps',
      slug: 'deploy-via-push-to-vps',
      skillMd: '--- name: Deploy ---\n## Procedure\nrun git push vps main',
      confidence: 0.8,
      sourceAgentId: 'a1',
      createdAt: 1,
      status: 'draft',
    },
  ];

  it('near-identical name+skillMd -> duplicate (>= 0.82)', () => {
    expect(
      isDuplicate('--- name: Deploy ---\n## Procedure\nrun git push vps main', 'Deploy via push to vps', existing, []),
    ).toBe(true);
  });

  it('unrelated content -> not a duplicate', () => {
    expect(isDuplicate('## How to brew coffee\ngrind beans', 'Brew coffee', existing, [])).toBe(false);
  });

  it('slug already published -> duplicate', () => {
    expect(isDuplicate('something brand new entirely', 'Fresh skill', existing, ['fresh-skill'])).toBe(true);
  });
});

describe('extractFor gating', () => {
  it('reusable:false -> no draft added', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ reusable: false }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(0);
  });

  it('confidence below 0.6 -> no draft added', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.5 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(0);
  });

  it('reusable + confidence>=0.6 + unique -> draft added', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    const drafts = useSkillsStore.getState().drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      name: 'Deploy via push to vps',
      slug: 'deploy-via-push-to-vps',
      confidence: 0.8,
      sourceAgentId: 'a1',
      status: 'draft',
    });
    expect(typeof drafts[0].id).toBe('string');
    expect(drafts[0].id.length).toBeGreaterThan(0);
  });

  it('duplicate of an existing draft -> not added a second time', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(1);
    // A different agent producing the same skill should be gated out as duplicate.
    await useSkillsStore.getState().extractFor('a2', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(1);
  });

  it('published slug gates out a would-be draft', async () => {
    mockApi.skillListPublished.mockResolvedValue(['deploy-via-push-to-vps']);
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.9 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(0);
  });

  it('swallows skillListPublished errors (treats as no published slugs)', async () => {
    mockApi.skillListPublished.mockRejectedValue(new Error('boom'));
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(useSkillsStore.getState().drafts).toHaveLength(1);
  });
});

describe('extractFor idempotency', () => {
  it('calling twice for the same agentId extracts once', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ reusable: false }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    expect(mockApi.skillExtract).toHaveBeenCalledTimes(1);
    expect(useSkillsStore.getState().processed).toContain('a1');
  });
});

describe('publish', () => {
  it('calls skillPublish(slug, skillMd) and flips status to published', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    const draft = useSkillsStore.getState().drafts[0];

    mockApi.skillPublish.mockResolvedValue('/Users/x/.claude/skills/deploy-via-push-to-vps/SKILL.md');
    await useSkillsStore.getState().publish(draft.id);

    expect(mockApi.skillPublish).toHaveBeenCalledWith(draft.slug, draft.skillMd);
    const after = useSkillsStore.getState().drafts[0];
    expect(after.status).toBe('published');
    expect(after.publishedPath).toBe('/Users/x/.claude/skills/deploy-via-push-to-vps/SKILL.md');
  });

  it('leaves the draft as draft if publish fails', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    const draft = useSkillsStore.getState().drafts[0];

    mockApi.skillPublish.mockRejectedValue(new Error('write failed'));
    await useSkillsStore.getState().publish(draft.id);

    expect(useSkillsStore.getState().drafts[0].status).toBe('draft');
  });
});

describe('discard', () => {
  it('flips status to discarded', async () => {
    mockApi.skillExtract.mockResolvedValue(extractPayload({ confidence: 0.8 }));
    await useSkillsStore.getState().extractFor('a1', 'transcript');
    const draft = useSkillsStore.getState().drafts[0];
    useSkillsStore.getState().discard(draft.id);
    expect(useSkillsStore.getState().drafts[0].status).toBe('discarded');
  });
});

describe('countToolCalls (trigger condition)', () => {
  const toolUse = (aid: string): AgentEvent => ({
    agent_id: aid,
    kind: { kind: 'assistant' },
    raw: { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] } },
  });
  const perm = (aid: string): AgentEvent => ({
    agent_id: aid,
    kind: { kind: 'permission_request', request_id: 'r1', tool: 'Bash' },
    raw: {},
  });

  it('counts both tool_use blocks and permission_request events for the agent', () => {
    const events: AgentEvent[] = [toolUse('a1'), perm('a1'), toolUse('a2')];
    expect(countToolCalls(events, 'a1')).toBe(2); // one tool_use + one permission_request
    expect(countToolCalls(events, 'a2')).toBe(1);
  });

  it('counts multiple tool_use blocks inside one assistant line', () => {
    const events: AgentEvent[] = [
      {
        agent_id: 'a1',
        kind: { kind: 'assistant' },
        raw: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Edit' }] } },
      },
    ];
    expect(countToolCalls(events, 'a1')).toBe(2);
  });

  it('ignores non-assistant raw and other agents', () => {
    const events: AgentEvent[] = [
      { agent_id: 'a1', kind: { kind: 'result' }, raw: { type: 'result' } },
      { agent_id: 'a1', kind: { kind: 'init' }, raw: { type: 'system' } },
    ];
    expect(countToolCalls(events, 'a1')).toBe(0);
  });
});

describe('buildTranscript', () => {
  it('joins JSON.stringify of only the target agent raw payloads, newline-separated', () => {
    const events: AgentEvent[] = [
      { agent_id: 'a1', kind: { kind: 'assistant' }, raw: { step: 1 } },
      { agent_id: 'a2', kind: { kind: 'assistant' }, raw: { other: true } },
      { agent_id: 'a1', kind: { kind: 'result' }, raw: { step: 2 } },
    ];
    expect(buildTranscript(events, 'a1')).toBe('{"step":1}\n{"step":2}');
  });
});
