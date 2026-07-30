import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { handlers } from '../index';

describe('lan_request handler', () => {
  // Block body on purpose: `mockReset()` returns the mock itself, and vitest
  // treats a function returned from `beforeEach` as the teardown hook — it
  // would then call the mock after each test, and the rejecting case below
  // would blow up in teardown.
  beforeEach(() => {
    invoke.mockReset();
  });

  it('marks a 2xx as ok and passes the body through', async () => {
    invoke.mockResolvedValue({ status: 200, body: '{"ok":true}' });
    const res = await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/next',
    });
    expect(res.ok).toBe(true);
    expect(res.output).toBe('{"ok":true}');
    expect(res.metadata?.status).toBe(200);
  });

  it('forwards every field to the Tauri command under `args`', async () => {
    invoke.mockResolvedValue({ status: 200, body: '{}' });
    await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/announce',
      audio_b64: 'AAAA',
      audio_filename: 'aviso.ogg',
    });
    expect(invoke).toHaveBeenCalledWith('lan_request', {
      args: {
        base: 'http://espmusic.local:8080',
        method: 'POST',
        path: '/api/announce',
        json: null,
        audio_b64: 'AAAA',
        audio_filename: 'aviso.ogg',
      },
    });
  });

  it('marks a 4xx as not ok but still returns the body', async () => {
    invoke.mockResolvedValue({ status: 404, body: '{"error":"nada encontrado"}' });
    const res = await handlers.lan_request({
      base: 'http://espmusic.local:8080',
      method: 'POST',
      path: '/api/play',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('404');
    expect(res.output).toBe('{"error":"nada encontrado"}');
    expect(res.metadata?.status).toBe(404);
  });

  it('turns a rejected invoke into an error response', async () => {
    invoke.mockRejectedValue(new Error('host não permitido'));
    const res = await handlers.lan_request({
      base: 'http://evil.local:80',
      method: 'GET',
      path: '/',
    });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('host não permitido');
  });
});
