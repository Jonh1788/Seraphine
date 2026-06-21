import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SessionInfo, AgentEvent, PermissionMode } from './types';

// Tauri v2 maps JS camelCase arg keys to Rust snake_case params (verified in
// this repo: `whisper_transcribe_pcm` is invoked with `sampleRate` against the
// Rust param `sample_rate`). Keep the keys below camelCase accordingly.

export const listSessions = () => invoke<SessionInfo[]>('maestro_list_sessions');
export const readTranscript = (slug: string, sessionId: string, tail = 200) =>
  invoke<unknown[]>('maestro_read_transcript', { slug, sessionId, tail });
export const spawnAgent = (cwd: string, goal: string, permissionMode: PermissionMode) =>
  invoke<string>('maestro_spawn_agent', { cwd, goal, permissionMode });
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
