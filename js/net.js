// Peer-to-peer rooms over WebRTC (PeerJS public broker; no backend of our own).
// The room code maps to a well-known peer id. Whoever holds that id is the host and runs HostGame;
// everyone else connects to it. If the host disappears, the next player claims the id and carries on
// from the last broadcast state, so the room survives refreshes and departures.

import { HostGame } from './host.js';

const PREFIX = 'tengrand-bj-v1-';
const HEARTBEAT = 2500;
const HOST_SILENCE = 9000;
const CLIENT_SILENCE = 12000;
const SNAP_KEY = (code) => 'tg_room_' + code;
const SNAP_TTL = 1000 * 60 * 60 * 48;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errOf = (type, msg) => Object.assign(new Error(msg || type), { type });

export function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  return [...buf].map((x) => A[x % A.length]).join('');
}

export const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const opts = { debug: 0 };
    const peer = id ? new window.Peer(id, opts) : new window.Peer(opts);
    const t = setTimeout(() => fail(errOf('timeout', 'Signaling server timed out')), 12000);
    function cleanup() { clearTimeout(t); peer.off('open', onOpen); peer.off('error', fail); }
    function onOpen() { cleanup(); resolve(peer); }
    function fail(e) { cleanup(); try { peer.destroy(); } catch {} reject(e); }
    peer.on('open', onOpen);
    peer.on('error', fail);
  });
}

function connectTo(peer, id) {
  return new Promise((resolve, reject) => {
    const conn = peer.connect(id, { reliable: true, serialization: 'json' });
    const t = setTimeout(() => done(errOf('timeout', 'Connection timed out')), 10000);
    function onErr(e) { if (e.type === 'peer-unavailable' || e.type === 'network' || e.type === 'disconnected') done(e); }
    function onOpen() { done(null); }
    function done(err) {
      clearTimeout(t);
      peer.off('error', onErr);
      conn.off('open', onOpen);
      if (err) { try { conn.close(); } catch {} reject(err); } else resolve(conn);
    }
    conn.on('open', onOpen);
    peer.on('error', onErr);
  });
}

function send(conn, msg) {
  try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn('send failed', e); }
}

function loadSnapshot(code) {
  try {
    const snap = JSON.parse(localStorage.getItem(SNAP_KEY(code)) || 'null');
    if (snap && Date.now() - snap.savedAt < SNAP_TTL) return snap;
  } catch {}
  return null;
}

export class Room {
  constructor({ code, me, onState, onFx, onStatus, onFatal }) {
    this.code = code;
    this.me = me;
    this.onState = onState;
    this.onFx = onFx;
    this.onStatus = onStatus;
    this.onFatal = onFatal;
    this.closed = false;
    this.role = null; // 'host' | 'client' | null while (re)connecting
    this.lastState = null;
    this.lastStateAt = 0;
    this.lastSaved = 0;
    this.saveTimer = null;
  }

  // ---------- lifecycle

  async create() {
    for (let i = 0; i < 6 && !this.closed; i++) {
      try {
        const peer = await openPeer(PREFIX + this.code);
        if (this.closed) { peer.destroy(); return; }
        this.becomeHost(peer, null);
        return;
      } catch (e) {
        if (e.type === 'unavailable-id') { this.code = makeCode(); continue; }
        if (i >= 2) throw e;
        await sleep(800);
      }
    }
  }

  // Join the room, or take it over if nobody is hosting it right now.
  async establish(preferHost) {
    const id = PREFIX + this.code;
    let host = preferHost;
    for (let attempt = 0; !this.closed; attempt++) {
      if (attempt >= 24) throw new Error("Couldn't reach the room. Check your connection and try again.");
      if (attempt > 0) this.onStatus({ state: 'connecting', attempt });
      if (host) {
        host = false;
        try {
          const peer = await openPeer(id);
          if (this.closed) { peer.destroy(); return; }
          this.becomeHost(peer, this.bestSnapshot());
          return;
        } catch (e) {
          // Someone else holds the id (a racing successor, or a host whose socket hasn't timed out yet).
          await sleep(e.type === 'unavailable-id' ? 500 + Math.random() * 700 : Math.min(600 + attempt * 400, 4000));
          continue;
        }
      }
      try {
        const peer = await this.clientPeer();
        const conn = await connectTo(peer, id);
        if (this.closed) { conn.close(); return; }
        this.becomeClient(conn);
        return;
      } catch (e) {
        if (e.type === 'peer-unavailable') { host = true; continue; }
        await sleep(Math.min(600 + attempt * 400, 4000));
        if (attempt % 3 === 2) host = true; // the old host may be a ghost; try to claim the id
      }
    }
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    this.flushSave();
    clearInterval(this.hbTimer);
    if (this.game) this.game.destroy();
    if (this.conns) for (const c of this.conns.keys()) { try { c.close(); } catch {} }
    try { if (this.conn) this.conn.close(); } catch {}
    try { if (this.peer) this.peer.destroy(); } catch {}
    try { if (this.cpeer) this.cpeer.destroy(); } catch {}
  }

  async clientPeer() {
    if (this.cpeer && !this.cpeer.destroyed && !this.cpeer.disconnected) return this.cpeer;
    try { if (this.cpeer) this.cpeer.destroy(); } catch {}
    this.cpeer = null;
    this.cpeer = await openPeer(null);
    return this.cpeer;
  }

  bestSnapshot() {
    const saved = loadSnapshot(this.code);
    if (this.lastState && (!saved || this.lastStateAt >= saved.savedAt)) return this.lastState;
    return saved;
  }

  // Persist the latest state so the room survives everyone leaving or a refresh. Throttled.
  remember(pub) {
    this.lastState = pub;
    this.lastStateAt = Date.now();
    if (this.saveTimer) return;
    const due = Math.max(0, 1000 - (Date.now() - this.lastSaved));
    this.saveTimer = setTimeout(() => this.flushSave(), due);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.lastState) return;
    this.lastSaved = Date.now();
    try { localStorage.setItem(SNAP_KEY(this.code), JSON.stringify({ ...this.lastState, savedAt: this.lastStateAt })); } catch {}
  }

  // ---------- host side

  becomeHost(peer, snapshot) {
    try { if (this.cpeer) this.cpeer.destroy(); } catch {}
    this.cpeer = null;
    this.conn = null;
    this.role = 'host';
    this.peer = peer;
    this.conns = new Map();
    this.game = new HostGame({
      code: this.code,
      hostPid: this.me.id,
      snapshot,
      onState: (pub) => this.hostEmit(pub),
      onFx: (fx) => this.hostFx(fx),
    });
    peer.on('connection', (c) => this.accept(c));
    peer.on('disconnected', () => {
      // Lost the signaling socket: existing peers still work, but re-register so nobody else claims the id.
      setTimeout(() => { if (!this.closed && this.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch {} } }, 1000);
    });
    peer.on('close', () => { if (!this.closed && this.peer === peer) this.demote(); });
    peer.on('error', (e) => console.warn('[host]', e.type, e.message));
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => this.hostBeat(), HEARTBEAT);
    this.game.join(this.me.id, this.me.name, this.me.avatar);
    this.onStatus({ state: 'online', role: 'host', code: this.code });
  }

  // Our peer id was lost (e.g. another tab claimed it while we were offline): fall back to client.
  demote() {
    clearInterval(this.hbTimer);
    if (this.game) this.game.destroy();
    this.game = null;
    if (this.conns) for (const c of this.conns.keys()) { try { c.close(); } catch {} }
    this.conns = null;
    this.peer = null;
    this.role = null;
    this.onStatus({ state: 'reconnecting' });
    this.establish(false).catch((e) => this.onFatal(e.message));
  }

  hostEmit(pub) {
    this.remember(pub);
    const msg = { t: 'state', s: pub };
    for (const [c, info] of this.conns) if (info.pid) send(c, msg);
    this.onState(pub);
  }

  hostFx(fx) {
    const msg = { t: 'fx', fx };
    for (const [c, info] of this.conns) if (info.pid) send(c, msg);
    this.onFx(fx);
  }

  accept(conn) {
    const info = { pid: null, last: Date.now() };
    this.conns.set(conn, info);
    conn.on('data', (m) => this.onHostData(conn, info, m));
    conn.on('close', () => this.dropConn(conn));
    conn.on('error', () => this.dropConn(conn));
  }

  onHostData(conn, info, m) {
    info.last = Date.now();
    if (!m || typeof m !== 'object' || !this.game) return;
    if (m.t === 'hello') {
      const pid = String(m.pid || '').slice(0, 48);
      if (!pid || pid === this.me.id || (info.pid && info.pid !== pid)) { try { conn.close(); } catch {} return; }
      // Same player reconnecting (refresh): retire the stale connection.
      for (const [c2, i2] of this.conns) {
        if (c2 !== conn && i2.pid === pid) { this.conns.delete(c2); try { c2.close(); } catch {} }
      }
      if (!this.game.join(pid, m.name, m.avatar)) {
        send(conn, { t: 'full' });
        this.conns.delete(conn);
        setTimeout(() => { try { conn.close(); } catch {} }, 600);
        return;
      }
      info.pid = pid;
      send(conn, { t: 'state', s: this.game.publicState() });
      return;
    }
    if (!info.pid) return;
    if (m.t === 'act') this.game.action(info.pid, m);
  }

  dropConn(conn) {
    const info = this.conns && this.conns.get(conn);
    if (!info) return;
    this.conns.delete(conn);
    if (info.pid && this.game && ![...this.conns.values()].some((i) => i.pid === info.pid)) this.game.leave(info.pid);
  }

  hostBeat() {
    if (!this.conns) return;
    const now = Date.now();
    for (const [c, info] of [...this.conns]) {
      if (now - info.last > CLIENT_SILENCE) { try { c.close(); } catch {} this.dropConn(c); continue; }
      if (info.pid) send(c, { t: 'hb' });
    }
  }

  // ---------- client side

  becomeClient(conn) {
    this.role = 'client';
    this.conn = conn;
    this.lastHeard = Date.now();
    conn.on('data', (m) => { if (conn === this.conn) this.onClientData(m); });
    conn.on('close', () => { if (conn === this.conn) this.lost(); });
    conn.on('error', () => { if (conn === this.conn) this.lost(); });
    send(conn, { t: 'hello', pid: this.me.id, name: this.me.name, avatar: this.me.avatar });
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.conn !== conn) return;
      if (Date.now() - this.lastHeard > HOST_SILENCE) { this.lost(); return; }
      send(conn, { t: 'hb' });
    }, HEARTBEAT);
    this.onStatus({ state: 'online', role: 'client', code: this.code });
  }

  onClientData(m) {
    this.lastHeard = Date.now();
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state' && m.s) { this.remember(m.s); this.onState(m.s); }
    else if (m.t === 'fx' && m.fx) this.onFx(m.fx);
    else if (m.t === 'full') { this.leave(); this.onFatal('That room is full — 6 players max.'); }
  }

  async lost() {
    if (this.closed || this.role !== 'client') return;
    this.role = null;
    clearInterval(this.hbTimer);
    const c = this.conn;
    this.conn = null;
    try { c.close(); } catch {}
    this.onStatus({ state: 'reconnecting' });
    // The first connected player after the old host claims the room; everyone else gives them a head start.
    const st = this.lastState;
    const next = st && st.order.map((id) => st.players[id]).find((p) => p && p.connected && p.id !== st.host);
    const iAmNext = !!next && next.id === this.me.id;
    if (!iAmNext) await sleep(1500 + Math.random() * 900);
    try { await this.establish(iAmNext); } catch (e) { if (!this.closed) this.onFatal(e.message); }
  }

  // ---------- outbound

  act(a, extra = {}) {
    const m = { t: 'act', a, ...extra };
    if (this.role === 'host' && this.game) this.game.action(this.me.id, m);
    else if (this.role === 'client') send(this.conn, m);
  }
}
