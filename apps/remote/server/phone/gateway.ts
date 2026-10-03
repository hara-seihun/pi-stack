import { timingSafeEqual } from "node:crypto";
import type { Result } from "./policy";

export type GatewaySocket = { send(data: string | Buffer): unknown; close(code?: number): void; getBufferedAmount(): number };
export type GatewaySpec = { id: string; name: string; token: string };
export type GatewaySnapshot = { id: string; name: string; connected: boolean; ready: boolean; reason: string; callId: string | null };
type Gateway = GatewaySpec & { socket?: GatewaySocket; hello: boolean; ready: boolean; reason: string; callId?: string; dialled: boolean; ending: boolean; active: boolean; lastSeen: number };
export type GatewayEvents = { state(callId: string, state: string, error?: string): void; audio(callId: string, data: Buffer): void };
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class SimGateways {
  private gateways = new Map<string, Gateway>();
  constructor(specs: GatewaySpec[], private events: GatewayEvents, private now = Date.now) {
    for (const s of specs) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.id) || s.token.length < 32 || this.gateways.has(s.id) || [...this.gateways.values()].some(g => equal(g.token, s.token))) throw new Error("SIM gateways need unique bounded IDs and unique owner-provisioned tokens of at least 32 characters");
      this.gateways.set(s.id, { ...s, hello: false, ready: false, reason: "No physical gateway connected", dialled: false, ending: false, active: false, lastSeen: 0 });
    }
  }
  authenticate(header: string | null): string | null {
    if (!header?.startsWith("Bearer ")) return null;
    return [...this.gateways.values()].find(g => equal(header.slice(7), g.token))?.id ?? null;
  }
  snapshots(): GatewaySnapshot[] {
    return [...this.gateways.values()].map(g => ({ id: g.id, name: g.name, connected: Boolean(g.socket), ready: Boolean(g.socket && g.hello && g.ready && !g.callId && this.now() - g.lastSeen <= 45_000), reason: g.callId ? "Gateway is reserved for a call" : g.reason, callId: g.callId ?? null }));
  }
  connected(id: string, socket: GatewaySocket): void {
    const g = this.gateways.get(id)!;
    if (g.socket) { const old = g.socket; this.disconnected(id, old); old.close(1008); }
    g.socket = socket; g.hello = false; g.ready = false; g.reason = "Waiting for Bluetooth/audio readiness"; g.lastSeen = this.now();
  }
  disconnected(id: string, socket: GatewaySocket): void {
    const g = this.gateways.get(id);
    if (!g || g.socket !== socket) return;
    const callId = g.callId;
    g.socket = undefined; g.ready = false; g.hello = false; g.reason = "Physical gateway disconnected"; g.callId = undefined; g.active = false; g.dialled = false; g.ending = false;
    if (callId) this.events.state(callId, "failed", g.reason);
  }
  receive(id: string, socket: GatewaySocket, data: string | Buffer): void {
    const g = this.gateways.get(id); if (!g || g.socket !== socket) return;
    g.lastSeen = this.now();
    if (typeof data !== "string") {
      if (!g.hello || data.length !== 640) { this.fail(g, "Invalid SIM audio frame"); return; }
      if (g.callId && g.active) this.events.audio(g.callId, data);
      return;
    }
    if (data.length > 4096) { this.fail(g, "Gateway control message too large"); return; }
    let m: any; try { m = JSON.parse(data); } catch { this.fail(g, "Invalid gateway control message"); return; }
    if (!m || typeof m !== "object") { this.fail(g, "Invalid gateway control message"); return; }
    if (m.type === "hello") {
      if (m.id !== g.id || m.sampleRate !== 16000 || typeof m.ready !== "boolean") { this.fail(g, "Gateway identity or audio format mismatch"); return; }
      g.hello = true; g.ready = m.ready; g.reason = m.ready ? "Bluetooth hands-free audio ready" : String(m.reason ?? "Bluetooth/audio not ready").slice(0, 200);
      if (!g.ready && g.callId) this.fail(g, g.reason);
      return;
    }
    if (!g.hello) { this.fail(g, "Gateway hello required"); return; }
    if (m.type === "heartbeat") return;
    if (m.type === "call-state") {
      if (typeof m.callId !== "string" || m.callId !== g.callId || !g.dialled) return;
      if (!["dialing", "ringing", "active", "ended", "failed"].includes(m.state)) { this.fail(g, "Invalid SIM call state"); return; }
      if (g.ending && !["ended", "failed"].includes(m.state)) return;
      g.active = m.state === "active";
      const callId = g.callId!;
      if (["ended", "failed"].includes(m.state)) { g.callId = undefined; g.dialled = false; g.ending = false; }
      this.events.state(callId, m.state, typeof m.error === "string" ? m.error.slice(0, 200) : undefined);
      return;
    }
    this.fail(g, "Unknown gateway operation");
  }
  reserve(id: string, callId: string): Result<true> {
    const g = this.gateways.get(id);
    if (!g?.socket || !g.hello || !g.ready || this.now() - g.lastSeen > 45_000) return { ok: false, error: "A paired physical SIM audio gateway must be connected and ready before dialing" };
    if (g.callId) return { ok: false, error: "SIM gateway already has a call" };
    g.callId = callId; g.dialled = false; g.ending = false; g.active = false;
    return { ok: true, value: true };
  }
  dial(id: string, callId: string, number: string, maxSeconds: number): Result<true> {
    const g = this.gateways.get(id);
    if (!g?.socket || !g.ready || this.now() - g.lastSeen > 45_000 || g.callId !== callId || g.dialled) return { ok: false, error: "SIM call reservation is unavailable; dialing was not retried" };
    if (number !== number.trim() || !/^\+[1-9]\d{6,14}$/.test(number) || !Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 1800) return { ok: false, error: "Invalid SIM destination or duration" };
    g.dialled = true;
    const sent = this.send(g, JSON.stringify({ type: "dial", callId, number, maxSeconds }));
    return sent ? { ok: true, value: true } : { ok: false, error: "SIM dial dispatch failed; outcome may be unconfirmed" };
  }
  audio(id: string, callId: string, data: Buffer): void {
    const g = this.gateways.get(id);
    if (!g?.socket || g.callId !== callId || !g.active) return;
    if (data.length !== 640 || g.socket.getBufferedAmount() > 6400) { this.fail(g, "SIM audio backpressure or frame error"); return; }
    this.send(g, data);
  }
  end(id: string, callId: string): void {
    const g = this.gateways.get(id); if (!g || g.callId !== callId) return;
    if (g.dialled && g.socket) {
      g.active = false; g.ending = true;
      this.send(g, JSON.stringify({ type: "hangup", callId }));
      // Keep the modem reserved until firmware confirms hangup or disconnects.
      return;
    }
    g.callId = undefined; g.dialled = false; g.ending = false; g.active = false;
  }
  expire(): void {
    for (const g of this.gateways.values()) if (g.socket && this.now() - g.lastSeen > 45_000) this.fail(g, "SIM gateway heartbeat expired");
  }
  private send(g: Gateway, data: string | Buffer): boolean {
    try {
      if (!g.socket) return false;
      if (g.socket.getBufferedAmount() > 6400) { this.fail(g, "SIM gateway backpressure"); return false; }
      const result = g.socket.send(data);
      if (result === false || result === 0) { this.fail(g, "SIM gateway rejected dispatch"); return false; }
      return true;
    } catch { this.fail(g, "SIM gateway socket failed"); return false; }
  }
  private fail(g: Gateway, reason: string): void {
    const socket = g.socket;
    if (g.callId && g.dialled && socket) { try { socket.send(JSON.stringify({ type: "hangup", callId: g.callId })); } catch { /* Local firmware watchdog owns disconnected cleanup. */ } }
    const callId = g.callId;
    g.callId = undefined; g.dialled = false; g.ending = false; g.active = false; g.ready = false; g.hello = false; g.socket = undefined; g.reason = reason;
    if (callId) this.events.state(callId, "failed", reason);
    try { socket?.close(1008); } catch { /* State is already disconnected; firmware has its local watchdog. */ }
  }
}
