import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionInfo, AgentEvent, PermissionMode, HostStatus, SiSession, DiffFile, GateResult } from './types';

// Tauri v2 maps JS camelCase arg keys to Rust snake_case params (verified in
// this repo: `whisper_transcribe_pcm` is invoked with `sampleRate` against the
// Rust param `sample_rate`). Keep the keys below camelCase accordingly.

export const listSessions = () => invoke<SessionInfo[]>('maestro_list_sessions');
export const listHosts = () => invoke<string[]>('maestro_list_hosts');
export const checkHost = (host: string) => invoke<HostStatus>('maestro_check_host', { host });
export const listRemoteSessions = (host: string) => invoke<SessionInfo[]>('maestro_list_remote_sessions', { host });
export const readTranscript = (slug: string, sessionId: string, tail = 200, host?: string) =>
  invoke<unknown[]>('maestro_read_transcript', { slug, sessionId, tail, host: host ?? null });
export const spawnAgent = (cwd: string, goal: string, permissionMode: PermissionMode | 'sandbox', host?: string) =>
  invoke<string>('maestro_spawn_agent', { cwd, goal, permissionMode, host: host ?? null });
export const sendToAgent = (agentId: string, text: string) =>
  invoke('maestro_send_to_agent', { agentId, text });
export const respondPermission = (agentId: string, requestId: string, allow: boolean) =>
  invoke('maestro_respond_permission', { agentId, requestId, allow });
export const stopAgent = (agentId: string) => invoke('maestro_stop_agent', { agentId });
export const resumeSession = (sessionId: string, cwd: string, goal: string, m: PermissionMode) =>
  invoke<string>('maestro_resume_session', { sessionId, cwd, goal, permissionMode: m });
export const forkSession = (sessionId: string, cwd: string, goal: string, m: PermissionMode) =>
  invoke<string>('maestro_fork_session', { sessionId, cwd, goal, permissionMode: m });
export const onAgentEvent = (cb: (e: AgentEvent) => void): Promise<UnlistenFn> =>
  listen<AgentEvent>('maestro:agent-event', (ev) => cb(ev.payload));
export const onAgentExit = (cb: (agentId: string) => void): Promise<UnlistenFn> =>
  listen<string>('maestro:agent-exit', (ev) => cb(ev.payload));

// Maestro Phase 3 — directed self-improvement (isolated worktrees).
export const siCreate = (repoRoot: string, slug: string, id: string) => invoke<SiSession>('maestro_si_create', { repoRoot, slug, id });
export const siList = (repoRoot: string) => invoke<string[]>('maestro_si_list', { repoRoot });
export const siCommit = (repoRoot: string, id: string, message: string) => invoke<boolean>('maestro_si_commit', { repoRoot, id, message });
export const siDiffstat = (repoRoot: string, branch: string) => invoke<DiffFile[]>('maestro_si_diffstat', { repoRoot, branch });
export const siReview = (repoRoot: string, branch: string) => invoke<string>('maestro_si_review', { repoRoot, branch });
export const siMerge = (repoRoot: string, branch: string) => invoke<string>('maestro_si_merge', { repoRoot, branch });
export const siDiscard = (repoRoot: string, id: string, branch: string) => invoke<void>('maestro_si_discard', { repoRoot, id, branch });
export const siGate = (path: string, commands: string[]) => invoke<GateResult>('maestro_si_gate', { path, commands });

// Maestro — skills self-authoring. The Rust params are snake_case
// (`transcript`, `slug`+`skill_md`); Tauri maps these camelCase keys to them
// (same convention as `maestro_si_create` above; verified against
// `skills.rs::maestro_skill_publish(slug, skill_md)`).
export const skillExtract = (transcript: string) => invoke<string>('maestro_skill_extract', { transcript });
export const skillPublish = (slug: string, skillMd: string) => invoke<string>('maestro_skill_publish', { slug, skillMd });
export const skillListPublished = () => invoke<string[]>('maestro_skill_list');
