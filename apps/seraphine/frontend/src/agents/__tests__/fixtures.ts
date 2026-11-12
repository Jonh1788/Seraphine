/**
 * Builders in the exact wire shapes of the backend (see the contract in
 * ../types.ts). `backend-samples.json` holds real responses captured from the
 * backend; the api contract tests replay them.
 */
import type {
  Agent,
  AgentAction,
  Approval,
  BridgeEngineStatus,
  EngineInfo,
  HarnessEvent,
  ProviderInfo,
  Message,
  Project,
  Run,
  RunLimit,
  RunQuestion,
  SendMessageResult,
  SpendRow,
  Task,
  ToolGroup,
  WaitKind,
} from '../types';

export function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'loja',
    path: 'C:\\Projetos\\loja',
    description: '',
    archived: false,
    created_at: '2026-01-01T10:00:00Z',
    kind: 'project',
    agent_id: null,
    ...over,
  };
}

export function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'ag1',
    name: 'Forja',
    role: 'código',
    instructions: 'Cuide do código.',
    engine: 'claude_code',
    provider: 'anthropic',
    model: null,
    reasoning_effort: null,
    fallback_engine: null,
    fallback_provider: null,
    fallback_model: null,
    color: '#f2a65a',
    perm_edit: 'free',
    perm_commands: 'ask',
    daily_budget_usd: null,
    enabled: true,
    project_ids: ['p1'],
    grants: { notes: 'read', wiki: 'read', memory: 'none' },
    description: '',
    suggestions: [],
    home_project_id: null,
    origin: 'manual',
    version: 0,
    archived: false,
    archived_at: null,
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    ...over,
  };
}

/** The catalogue of step 3b as `GET /agents/tools` sends it (the `system` group is not listed). */
export function makeToolGroups(): ToolGroup[] {
  return [
    {
      id: 'notes',
      label: 'Notas',
      description: 'As notas que você escreveu na Seraphine.',
      default: 'read',
      sensitive: false,
      levels: ['none', 'read'],
      tools: [
        { name: 'search_notes', label: 'Buscar nas notas', description: 'Procura nas notas.', read_only: true, level: 'read' },
        { name: 'list_notes', label: 'Ver as notas mais recentes', description: 'Lista as notas.', read_only: true, level: 'read' },
      ],
    },
    {
      id: 'wiki',
      label: 'Wiki',
      description: 'As páginas da sua wiki.',
      default: 'read',
      sensitive: false,
      levels: ['none', 'read'],
      tools: [
        { name: 'wiki_search', label: 'Buscar na wiki', description: 'Procura na wiki.', read_only: true, level: 'read' },
        { name: 'wiki_list_pages', label: 'Listar as páginas', description: 'Lista as páginas.', read_only: true, level: 'read' },
        { name: 'wiki_read_page', label: 'Ler uma página', description: 'Lê uma página.', read_only: true, level: 'read' },
      ],
    },
    {
      id: 'memory',
      label: 'Memória pessoal',
      description: 'O que a Seraphine guarda sobre você.',
      default: 'none',
      sensitive: true,
      levels: ['none', 'read'],
      tools: [{ name: 'memory_search', label: 'Buscar na memória', description: 'Procura na memória.', read_only: true, level: 'read' }],
    },
  ];
}

export function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r1',
    agent_id: 'ag1',
    project_id: 'p1',
    task_id: null,
    goal: 'Checkout com cupom falhando',
    status: 'running',
    engine: 'claude_code',
    provider: 'anthropic',
    model: null,
    reasoning_effort: null,
    session_ref: null,
    requested_by: 'user',
    result_summary: null,
    error: null,
    exit_code: null,
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    approvals_used: 0,
    created_at: '2026-01-01T10:00:00Z',
    started_at: '2026-01-01T10:00:01Z',
    finished_at: null,
    recoveries: 0,
    can_continue: false,
    continued_from: null,
    continued_by: null,
    wait_kind: null,
    wait_until: null,
    wait_since: null,
    wait_attempts: 0,
    wait_detail: null,
    wait_exact: false,
    inbox_count: 0,
    actions_count: 0,
    question: null,
    session_mode: 'fresh',
    session_from: null,
    routine_id: null,
    routine_title: null,
    ...over,
  };
}

/** A run waiting for something that is not its fault (step 1b). `auth` has no `wait_until`. */
export function makeParkedRun(kind: WaitKind = 'outage', over: Partial<Run> = {}): Run {
  return makeRun({
    status: 'parked',
    wait_kind: kind,
    wait_until: kind === 'auth' ? null : '2026-01-01T10:15:00Z',
    wait_since: '2026-01-01T10:10:00Z',
    wait_attempts: 1,
    ...over,
  });
}

/** A run the backend's restart cut short (`interrupted` can be continued; `interrupted_mid_action` cannot). */
export function makeInterruptedRun(over: Partial<Run> = {}): Run {
  return makeRun({
    status: 'failed',
    error: 'interrupted',
    can_continue: true,
    finished_at: '2026-01-01T10:10:00Z',
    ...over,
  });
}

/** A run the harness stopped at a limit (step 1d); every limit leaves it failed and, unless continued, continuable. */
export function makeLimitRun(error: RunLimit = 'step_limit', over: Partial<Run> = {}): Run {
  return makeRun({
    status: 'failed',
    error,
    can_continue: true,
    actions_count: 200,
    finished_at: '2026-01-01T10:10:00Z',
    ...over,
  });
}

export function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'ap1',
    run_id: 'r1',
    agent_id: 'ag1',
    project_id: 'p1',
    title: 'Voltar a loja para a versão anterior',
    command: 'git revert HEAD && ./deploy.sh',
    reason: 'deploy e rollback sempre passam por você',
    status: 'pending',
    output: null,
    created_at: '2026-01-01T10:05:00Z',
    decided_at: null,
    risk_level: 'medium',
    risk_reasons: [],
    command_digest: 'd1'.repeat(32),
    expires_at: '2026-01-02T10:05:00Z',
    decided_by: null,
    decision_note: null,
    ...over,
  };
}

export function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    project_id: 'p1',
    task_id: null,
    author: 'user',
    body: 'Oi',
    run_id: null,
    created_at: '2026-01-01T10:00:00Z',
    delivery: null,
    routine_id: null,
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    project_id: 'p1',
    number: 42,
    title: 'Corrigir o arredondamento do cupom',
    description: 'Ajustar o arredondamento.',
    status: 'todo',
    assignee_agent_id: null,
    priority: 'medium',
    due_at: null,
    acceptance: [{ text: 'Reproduzir a falha', done: false }],
    created_by: 'user',
    created_at: '2026-01-01T10:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    ...over,
  };
}

export function makeEvent(over: Partial<HarnessEvent> = {}): HarnessEvent {
  return {
    id: 1,
    run_id: 'r1',
    ts: '2026-01-01T10:00:02Z',
    kind: 'step',
    payload: { type: 'reasoning', text: 'Leu os erros do checkout' },
    ...over,
  };
}

/** `POST /projects/{id}/messages` answer: the message was stored and a run started. */
export function makeSendResult(over: Partial<SendMessageResult> = {}): SendMessageResult {
  return {
    message: makeMessage(),
    agent_id: null,
    run: null,
    error: null,
    detail: null,
    joined: false,
    interrupted: false,
    ...over,
  };
}

export function makeEngine(over: Partial<EngineInfo> = {}): EngineInfo {
  return { name: 'claude_code', available: true, reason: '', can_act: true, ...over };
}

export function makeProvider(over: Partial<ProviderInfo> = {}): ProviderInfo {
  return {
    id: 'openai',
    label: 'OpenAI (login do Codex)',
    kind: 'plan',
    runtimes: ['codex'],
    configured: true,
    reason: '',
    default_model: null,
    notes: '',
    how: '',
    ...over,
  };
}

export function makeSpendRow(over: Partial<SpendRow> = {}): SpendRow {
  return { agent_id: 'ag1', name: 'Forja', spent_usd: 0, daily_budget_usd: null, ...over };
}

/** The catalogue of step 3c: notes now also write, plus the two new groups (`reminders` starts closed). */
export function makeWriteToolGroups(): ToolGroup[] {
  const [notes, wiki, memory] = makeToolGroups();
  return [
    {
      ...notes,
      levels: ['none', 'read', 'write'],
      tools: [
        ...notes.tools,
        { name: 'create_note', label: 'Criar uma nota', description: 'Cria uma nota.', read_only: false, level: 'write' },
        { name: 'update_note', label: 'Alterar uma nota', description: 'Altera uma nota.', read_only: false, level: 'write' },
      ],
    },
    wiki,
    memory,
    {
      id: 'project_tasks',
      label: 'Tarefas do projeto',
      description: 'As tarefas do projeto em que o agente trabalha.',
      default: 'read',
      sensitive: false,
      levels: ['none', 'read', 'write'],
      tools: [
        { name: 'list_project_tasks', label: 'Ver as tarefas do projeto', description: 'Lista.', read_only: true, level: 'read' },
        { name: 'create_project_task', label: 'Criar uma tarefa', description: 'Cria.', read_only: false, level: 'write' },
        { name: 'update_project_task', label: 'Alterar uma tarefa', description: 'Altera.', read_only: false, level: 'write' },
      ],
    },
    {
      id: 'reminders',
      label: 'Lembretes',
      description: 'Os seus lembretes.',
      default: 'none',
      sensitive: false,
      levels: ['none', 'read', 'write'],
      tools: [
        { name: 'list_reminders', label: 'Ver os lembretes', description: 'Lista.', read_only: true, level: 'read' },
        { name: 'create_reminder', label: 'Criar um lembrete', description: 'Cria.', read_only: false, level: 'write' },
      ],
    },
  ];
}

/** A write an agent made (step 3c); by default undoable for another five minutes after `created_at`. */
export function makeAction(over: Partial<AgentAction> = {}): AgentAction {
  return {
    id: 'act1',
    run_id: 'r1',
    agent_id: 'ag1',
    project_id: 'p1',
    tool: 'create_note',
    group: 'notes',
    label: 'Criou a nota «Compras»',
    created_at: '2026-01-01T10:00:00Z',
    undo_until: '2026-01-01T10:05:00Z',
    undone_at: null,
    can_undo: true,
    ...over,
  };
}

export function makeQuestion(over: Partial<RunQuestion> = {}): RunQuestion {
  return { text: 'Posso apagar as notas antigas da pasta?', options: ['Pode', 'Não'], asked_at: '2026-01-01T10:00:30Z', ...over };
}

/** A run parked because its agent asked the owner something (step 3c). */
export function makeAskingRun(question: RunQuestion | null = makeQuestion(), over: Partial<Run> = {}): Run {
  return makeParkedRun('owner_input', { question, wait_until: null, ...over });
}

export function makeBridgeStatus(over: Partial<BridgeEngineStatus> = {}): BridgeEngineStatus {
  return { engine: 'codex', label: 'Codex', state: 'ok', last_ok_at: '2026-01-01T10:00:00Z', last_failure_at: null, last_failure: null, ...over };
}
