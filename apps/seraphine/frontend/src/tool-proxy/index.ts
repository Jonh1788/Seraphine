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
      // engine.py:1081 forwards `metadata.image` to the Anthropic adapter
      // as a vision content block. It expects a full data URL — output
      // alone is treated as plain text and never reaches the model as an
      // image. Mirror what `browser_screenshot` (a known-working vision
      // tool) returns.
      return wrapOk(
        'Screenshot taken. I can see the screen.',
        { image: `data:image/jpeg;base64,${b64}` },
      );
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
  // 034 — Native Mac integrations
  osascript: async (args) => {
    try {
      const stdout = await tauriInvoke<string>('osascript_local', {
        script: String(args.script ?? ''),
      });
      return wrapOk(stdout);
    } catch (e) {
      return wrapErr(e);
    }
  },
  shortcuts_run: async (args) => {
    try {
      const stdout = await tauriInvoke<string>('shortcuts_run_local', {
        name: String(args.name ?? ''),
        input: args.input !== undefined ? String(args.input) : null,
      });
      return wrapOk(stdout);
    } catch (e) {
      return wrapErr(e);
    }
  },
  open_path: async (args) => {
    try {
      await tauriInvoke<void>('open_path_local', {
        target: String(args.target ?? ''),
      });
      return wrapOk('opened');
    } catch (e) {
      return wrapErr(e);
    }
  },
  active_app: async () => {
    try {
      const result = await tauriInvoke<{ app_name: string; window_title: string }>(
        'active_app_local',
      );
      return wrapOk(
        result.window_title
          ? `${result.app_name} — ${result.window_title}`
          : result.app_name,
        { app_name: result.app_name, window_title: result.window_title },
      );
    } catch (e) {
      return wrapErr(e);
    }
  },
  // 035 — screen click/type/key
  screen_click: async (args) => {
    try {
      await tauriInvoke<void>('screen_click_local', {
        x: Number(args.x ?? 0),
        y: Number(args.y ?? 0),
        button: args.button ? String(args.button) : null,
      });
      return wrapOk('clicked');
    } catch (e) {
      return wrapErr(e);
    }
  },
  screen_type: async (args) => {
    try {
      await tauriInvoke<void>('screen_type_local', {
        text: String(args.text ?? ''),
      });
      return wrapOk('typed');
    } catch (e) {
      return wrapErr(e);
    }
  },
  screen_key: async (args) => {
    try {
      await tauriInvoke<void>('screen_key_local', {
        combo: String(args.combo ?? args.keys ?? ''),
      });
      return wrapOk('key sent');
    } catch (e) {
      return wrapErr(e);
    }
  },
  // 036 — Dev sidekick wrappers using run_shell_local under the hood
  git_status: async (args) => {
    try {
      const out = await tauriInvoke<{ stdout: string; stderr: string; code: number }>(
        'run_shell_local',
        {
          command: 'git status --short --branch',
          cwd: args.path ?? null,
        },
      );
      if (out.code !== 0) return wrapErr(out.stderr || 'git failed');
      return wrapOk(out.stdout || '(clean)');
    } catch (e) {
      return wrapErr(e);
    }
  },
  git_diff: async (args) => {
    try {
      const staged = args.staged ? ' --cached' : '';
      const out = await tauriInvoke<{ stdout: string; stderr: string; code: number }>(
        'run_shell_local',
        {
          command: `git diff${staged}`,
          cwd: args.path ?? null,
        },
      );
      if (out.code !== 0) return wrapErr(out.stderr || 'git failed');
      return wrapOk(out.stdout || '(no diff)');
    } catch (e) {
      return wrapErr(e);
    }
  },
  edit_file: async (args) => {
    try {
      const path = String(args.path ?? '');
      const oldStr = String(args.old ?? '');
      const newStr = String(args.new ?? '');
      if (!path || !oldStr) return wrapErr('missing path/old');
      const current = await tauriInvoke<string>('read_file_local', { path });
      const occurrences = current.split(oldStr).length - 1;
      if (occurrences === 0) return wrapErr('old string not found in file');
      if (occurrences > 1) {
        return wrapErr(
          `ambiguous match (${occurrences} occurrences) — add more context`,
        );
      }
      const next = current.replace(oldStr, newStr);
      await tauriInvoke<void>('write_file_local', { path, content: next });
      return wrapOk(`edited ${path}`);
    } catch (e) {
      return wrapErr(e);
    }
  },
  search_code: async (args) => {
    try {
      const q = String(args.query ?? '');
      const fileType = args.file_type ? ` -t ${String(args.file_type)}` : '';
      // Use `rg` if available; escape query with $'...' for shell safety.
      const escaped = q.replace(/'/g, "'\\''");
      const cmd = `rg --color=never -n${fileType} '${escaped}' | head -200`;
      const out = await tauriInvoke<{ stdout: string; stderr: string; code: number }>(
        'run_shell_local',
        { command: cmd, cwd: args.path ?? null },
      );
      return wrapOk(out.stdout || '(no matches)');
    } catch (e) {
      return wrapErr(e);
    }
  },
  run_tests: async (args) => {
    try {
      // Framework detection via file probing.
      const cwd = args.path ?? null;
      const probe = await tauriInvoke<{ stdout: string; code: number; stderr: string }>(
        'run_shell_local',
        {
          command: (
            'if [ -f pyproject.toml ] || [ -f pytest.ini ]; then echo pytest; '
            + 'elif [ -f package.json ]; then echo node; '
            + 'elif [ -f Cargo.toml ]; then echo cargo; '
            + 'elif [ -f go.mod ]; then echo go; '
            + 'else echo unknown; fi'
          ),
          cwd,
        },
      );
      const framework = probe.stdout.trim();
      const filterArg = args.filter ? ` ${String(args.filter)}` : '';
      const cmd = (
        framework === 'pytest' ? `pytest -x -q${filterArg}` :
        framework === 'node' ? `npm test${filterArg}` :
        framework === 'cargo' ? `cargo test${filterArg}` :
        framework === 'go' ? `go test ./...${filterArg}` :
        ''
      );
      if (!cmd) {
        return wrapErr(`no test framework detected (${framework})`);
      }
      const out = await tauriInvoke<{ stdout: string; stderr: string; code: number }>(
        'run_shell_local',
        { command: cmd, cwd },
      );
      const body = out.stdout + (out.stderr ? `\n[stderr]\n${out.stderr}` : '');
      return {
        request_id: '',
        ok: out.code === 0,
        output: body,
        error: out.code !== 0 ? `exit ${out.code}` : null,
        metadata: { framework, exit_code: out.code },
      };
    } catch (e) {
      return wrapErr(e);
    }
  },
};

/** Attach to a WS instance. Must be invoked after the runtime is Tauri. */
export function attachToolProxy(ws: SeraphineWS): () => void {
  console.log('[tool-proxy] attached', { handlers: Object.keys(handlers) });
  const off = ws.onMessage(async (msg) => {
    if (msg instanceof ArrayBuffer) return;
    const raw = msg as { type?: string };
    if (raw.type !== 'tool_proxy_request') return;
    const req = msg as unknown as ToolProxyRequest;
    console.log('[tool-proxy] request', { tool: req.tool, request_id: req.request_id, args: req.args });
    const handler = handlers[req.tool];
    if (!handler) {
      console.warn('[tool-proxy] no handler for', req.tool);
    }
    const baseResp: ProxyResponse = handler
      ? await handler(req.args || {}).catch(wrapErr)
      : { request_id: '', ok: false, error: `no handler for ${req.tool}` };
    console.log('[tool-proxy] response', {
      tool: req.tool,
      request_id: req.request_id,
      ok: baseResp.ok,
      error: baseResp.error,
      output_preview: typeof baseResp.output === 'string' ? baseResp.output.slice(0, 80) : undefined,
      has_image: Boolean(baseResp.metadata && 'image' in baseResp.metadata),
    });
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
