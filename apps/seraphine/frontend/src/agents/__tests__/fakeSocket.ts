/** Minimal controllable WebSocket for vitest (`vi.stubGlobal('WebSocket', FakeWebSocket)`). */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  closeCalls = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Client-initiated close (what `stop()` does). */
  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // ---- test drivers ----
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
