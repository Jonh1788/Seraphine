import type { ClientMessage, ServerMessage } from './types';

type StatusListener = (status: 'connected' | 'disconnected') => void;
type MessageListener = (msg: ServerMessage) => void;

const DEFAULT_URL = 'ws://localhost:8000/ws/conversation';
const BACKOFF_MS = [1000, 2000, 5000];

export class SeraphineWS {
  private socket: WebSocket | null = null;
  private url: string;
  private statusListeners = new Set<StatusListener>();
  private messageListeners = new Set<MessageListener>();
  private retry = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url?: string) {
    const envUrl = (import.meta.env.VITE_WS_URL as string | undefined) ?? DEFAULT_URL;
    this.url = url ?? envUrl;
  }

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  onMessage(cb: MessageListener): () => void {
    this.messageListeners.add(cb);
    return () => this.messageListeners.delete(cb);
  }

  onStatus(cb: StatusListener): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private openSocket(): void {
    const sock = new WebSocket(this.url);
    this.socket = sock;

    sock.onopen = () => {
      this.retry = 0;
      this.statusListeners.forEach((cb) => cb('connected'));
    };
    sock.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as ServerMessage;
        this.messageListeners.forEach((cb) => cb(parsed));
      } catch {
        // ignore non-JSON frames for now
      }
    };
    sock.onclose = () => {
      this.statusListeners.forEach((cb) => cb('disconnected'));
      if (!this.closed) this.scheduleReconnect();
    };
    sock.onerror = () => {
      sock.close();
    };
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.retry, BACKOFF_MS.length - 1)];
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }
}
