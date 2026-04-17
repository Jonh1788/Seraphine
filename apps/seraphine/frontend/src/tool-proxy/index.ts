/**
 * 033 — Tool proxy handler.
 *
 * Receives `tool_proxy_request` frames from the backend (VPS) and
 * dispatches them to the matching Tauri command running locally on the
 * Mac. The result goes back as `tool_proxy_response`.
 *
 * This is what restores screen/shell/filesystem/clipboard tools after
 * the backend moved off the Mac.
 */

import type { SeraphineWS } from '../ws/client';

interface ToolProxyRequest {
  type: 'tool_proxy_request';
  request_id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ProxyResponse {
  request_id: string;
  ok: boolean;
  output?: string;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

type Handler = (args: Record<string, unknown>) => Promise<ProxyResponse>;

async function tauriInvoke<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(name, args as Record<string, unknown>);
}

function wrapOk(output: string, metadata?: Record<string, unknown>): ProxyResponse {
  return { request_id: '', ok: true, output, metadata: metadata ?? {} };
}

function wrapErr(err: unknown): ProxyResponse {
  return { request_id: '', ok: false, error: String(err) };
}

const handlers: Record<string, Handler> = {
  run_shell: async (args) => {
    try {
      const result = await tauriInvoke<{ stdout: string; stderr: string; code: number }>(
        'run_shell_local',
        { command: String(args.command ?? ''), cwd: args.cwd ?? null },
      );
      const body = result.stdout + (result.stderr ? `\n[stderr]\n${result.stderr}` : '');
      return wrapOk(body, { exit_code: result.code });
    } catch (e) {
      return wrapErr(e);
    }
  },
  read_file: async (args) => {
    try {
      const text = await tauriInvoke<string>('read_file_local', {
        path: String(args.path ?? ''),
      });
      return wrapOk(text);
    } catch (e) {
      return wrapErr(e);
    }
  },
  write_file: async (args) => {
    try {
      await tauriInvoke<void>('write_file_local', {
        path: String(args.path ?? ''),
        content: String(args.content ?? ''),
      });
      return wrapOk('ok');
    } catch (e) {
      return wrapErr(e);
    }
  },
  list_dir: async (args) => {
    try {
      const entries = await tauriInvoke<string[]>('list_dir_local', {
        path: String(args.path ?? ''),
      });
      return wrapOk(entries.join('\n'));
    } catch (e) {
      return wrapErr(e);
    }
  },
  screen_capture: async () => {
    try {
      const b64 = await tauriInvoke<string>('screen_capture_local');
      return wrapOk(b64, { format: 'png', encoding: 'base64' });
    } catch (e) {
      return wrapErr(e);
    }
  },
  screen_read_clipboard: async () => {
    try {
      const text = await tauriInvoke<string>('read_clipboard_local');
      return wrapOk(text);
    } catch (e) {
      return wrapErr(e);
    }
  },
  screen_copy_to_clipboard: async (args) => {
    try {
      await tauriInvoke<void>('write_clipboard_local', {
        text: String(args.text ?? args.content ?? ''),
      });
      return wrapOk('copied');
    } catch (e) {
      return wrapErr(e);
    }
  },
};

/** Attach to a WS instance. Must be invoked after the runtime is Tauri. */
export function attachToolProxy(ws: SeraphineWS): () => void {
  const off = ws.onMessage(async (msg) => {
    if (msg instanceof ArrayBuffer) return;
    const raw = msg as { type?: string };
    if (raw.type !== 'tool_proxy_request') return;
    const req = msg as unknown as ToolProxyRequest;
    const handler = handlers[req.tool];
    const baseResp: ProxyResponse = handler
      ? await handler(req.args || {}).catch(wrapErr)
      : { request_id: '', ok: false, error: `no handler for ${req.tool}` };
    ws.send({
      ...(baseResp as unknown as Record<string, unknown>),
      type: 'tool_proxy_response',
      request_id: req.request_id,
    } as never);
  });
  return off;
}

/** Announce this client as Tauri so the server prefers it for proxy calls. */
export function sendClientHello(ws: SeraphineWS): void {
  ws.send({
    type: 'client_hello',
    is_tauri: true,
  } as never);
}
