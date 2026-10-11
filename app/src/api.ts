// Server client: REST + a self-healing WebSocket for pushed events.

import { activeServer, connection, type ServerEntry } from "./store";
import { effect, signal } from "@preact/signals";

type Handler = (msg: any) => void;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function normUrl(u: string) {
  u = u.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = (u.startsWith("localhost") || /^\d+\.\d+/.test(u) ? "http://" : "https://") + u;
  return u;
}

export const lastHello = signal<any>(null);

class Api {
  base = "";
  token = "";
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private retry = 0;
  private retryTimer: number | undefined;
  private watched: string[] = [];
  private pingTimer: number | undefined;

  configure(s: ServerEntry | undefined) {
    const base = s ? normUrl(s.url) : "";
    const token = s?.token ?? "";
    if (base === this.base && token === this.token) return;
    this.base = base;
    this.token = token;
    this.reconnect();
  }

  private headers(): HeadersInit {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async get<T = any>(path: string, signal?: AbortSignal): Promise<T> {
    if (!this.base) throw new ApiError(0, "No server configured");
    const r = await fetch(this.base + path, { headers: this.headers(), signal });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        msg = (await r.json()).error ?? msg;
      } catch {
        /* not json */
      }
      if (r.status === 401) connection.value = "unauthorized";
      throw new ApiError(r.status, msg);
    }
    return r.json();
  }

  async bin(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.base) throw new ApiError(0, "No server configured");
    const r = await fetch(this.base + path, { headers: this.headers(), signal });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        msg = (await r.json()).error ?? msg;
      } catch {
        /* binary */
      }
      throw new ApiError(r.status, msg);
    }
    return r.arrayBuffer();
  }

  async send<T = any>(method: string, path: string, body: BodyInit | object, isJson = true): Promise<T> {
    const headers: Record<string, string> = { ...(this.headers() as any) };
    if (isJson) headers["Content-Type"] = "application/json";
    const r = await fetch(this.base + path, { method, headers, body: isJson ? JSON.stringify(body) : (body as BodyInit) });
    if (!r.ok) {
      let msg = r.statusText;
      try {
        msg = (await r.json()).error ?? msg;
      } catch {
        /* */
      }
      throw new ApiError(r.status, msg);
    }
    return r.json();
  }

  on(type: string, h: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(h);
    return () => this.handlers.get(type)?.delete(h);
  }

  private emit(msg: any) {
    this.handlers.get(msg.type)?.forEach((h) => h(msg));
    this.handlers.get("*")?.forEach((h) => h(msg));
  }

  watch(sites: string[]) {
    this.watched = sites;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "watch", sites }));
  }

  private reconnect() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    if (!this.base) {
      connection.value = "none";
      return;
    }
    connection.value = "connecting";
    const url = this.base.replace(/^http/, "ws") + "/api/ws?token=" + encodeURIComponent(this.token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      connection.value = "online";
      if (this.watched.length) ws.send(JSON.stringify({ type: "watch", sites: this.watched }));
      this.pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25000);
      this.emit({ type: "connected" });
    };
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === "hello") lastHello.value = m;
        this.emit(m);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (connection.value !== "unauthorized") connection.value = "offline";
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.reconnect(), delay);
  }

  /** Check a server before saving it. */
  async test(url: string, token: string): Promise<{ ok: boolean; message: string; info?: any }> {
    const base = normUrl(url);
    try {
      const h = await fetch(base + "/api/health").then((r) => r.json());
      if (h.app !== "thebigweather") return { ok: false, message: "Not a TheBigWeather server" };
      const r = await fetch(base + "/api/info", { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 401) return { ok: false, message: "Wrong token" };
      const info = await r.json();
      return { ok: true, message: `Connected · ${info.profile?.name} profile · v${info.version}`, info };
    } catch (e: any) {
      return { ok: false, message: "Can't reach server" };
    }
  }
}

export const api = new Api();

effect(() => api.configure(activeServer.value));
