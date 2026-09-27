import type { ClientMsg, ServerMsg } from './protocol.ts';

type Handler<T extends ServerMsg['type']> = (msg: Extract<ServerMsg, { type: T }>) => void;

/**
 * The realtime connection: reconnects on its own, and keeps an estimate of the server
 * clock (from ping round-trips) so every pilot's music starts at the same instant.
 */
export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<(m: ServerMsg) => void>>();
  private offset = 0;
  private bestRtt = Infinity;
  private pingTimer = 0;
  private retry = 0;
  private closedByUs = false;
  connected = false;

  constructor(private token: () => string | null) {}

  connect() {
    const t = this.token();
    if (!t || this.ws) return;
    this.closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.bestRtt = Infinity;
      ws.send(JSON.stringify({ type: 'hello', token: t }));
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 4000);
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'pong' && msg.t) {
        const rtt = performance.now() - msg.t;
        // Keep the estimate from the fastest round-trip: it has the least noise.
        if (rtt <= this.bestRtt * 1.3) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.offset = msg.now + rtt / 2 - Date.now();
        }
      }
      if (msg.type === 'lobby') {
        // Every snapshot carries the server time too: a coarse fallback before pings settle.
        if (this.bestRtt === Infinity) this.offset = msg.now - Date.now();
      }
      this.dispatch(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      this.ws = null;
      this.connected = false;
      this.dispatch({ type: 'error', message: '__disconnected' });
      if (!this.closedByUs) {
        const wait = Math.min(8000, 500 * 2 ** this.retry++);
        setTimeout(() => this.connect(), wait);
      }
    };
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
  }

  private ping() {
    this.send({ type: 'ping', t: performance.now() });
  }

  /** Current server time, in ms. */
  serverNow() {
    return Date.now() + this.offset;
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on<T extends ServerMsg['type']>(type: T, fn: Handler<T>) {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn as (m: ServerMsg) => void);
    return () => set!.delete(fn as (m: ServerMsg) => void);
  }

  private dispatch(msg: ServerMsg) {
    for (const fn of this.handlers.get(msg.type) ?? []) fn(msg);
  }
}
