// Rooms over public MQTT brokers via secure WebSockets — works on any network (no direct peer-to-peer
// connection or TURN relay needed) and has no backend of our own. Every message is sent through several
// brokers at once and de-duplicated, so one broker being slow or blocked doesn't matter.
//
// Privacy & fairness: all traffic is AES-GCM encrypted with a key derived from the room code (the broker and
// strangers see noise). Each player also has a long-lived ECDH key; the host encrypts that player's private
// data (hole cards) with their pairwise key, and players sign-by-encrypting their actions to the host, so no
// one can read another player's cards or act on their behalf.
//
// The host (any player) runs the authoritative game and heartbeats on a retained topic. If it goes quiet the
// next player in seat order takes over from the last state; conflicting hosts resolve by (epoch, id).

import { every, later } from './timers.js';

const BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' },
];
const HOST_BEAT = 2000;
const CLIENT_HI = 3000;
const HOST_SILENCE = 7000;
const CLIENT_SILENCE = 11000;
const PROBE = 2800;
const SNAP_TTL = 1000 * 60 * 60 * 48;

const sleep = (ms) => new Promise((r) => later(r, ms));
const te = new TextEncoder();
const td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const buf = new Uint32Array(4);
  crypto.getRandomValues(buf);
  return [...buf].map((x) => A[x % A.length]).join('');
}

export const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

// ---------- crypto helpers

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function roomSecrets(game, code) {
  const base = await subtle().importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveKey', 'deriveBits']);
  const key = await subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('tengrand/v2/key/' + game), iterations: 60000 },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const bits = new Uint8Array(await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('tengrand/v2/topic/' + game), iterations: 1000 }, base, 96,
  ));
  const topic = `tengrand/v2/${game}/${[...bits].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  return { key, topic, hostTopic: topic + '/host' };
}

// Callers pass objects; they are serialized immediately (before any await) so later mutations can't leak in.
function seal(key, obj) {
  return sealText(key, JSON.stringify(obj));
}

async function sealText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}

async function unseal(key, str) {
  const b = unb64(str);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b.subarray(0, 12) }, key, b.subarray(12));
  return JSON.parse(td.decode(pt));
}

const EC = { name: 'ECDH', namedCurve: 'P-256' };
const importPub = (p) => subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: p.x, y: p.y, ext: true }, EC, false, []);
const pairKey = async (priv, pub) => subtle().deriveKey({ name: 'ECDH', public: await importPub(pub) }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

async function newKeyPair() {
  const pair = await subtle().generateKey(EC, true, ['deriveKey']);
  const pub = await subtle().exportKey('jwk', pair.publicKey);
  return { priv: pair.privateKey, privJwk: await subtle().exportKey('jwk', pair.privateKey), pub: { x: pub.x, y: pub.y } };
}

// A player's long-lived identity key, kept with their player id in this browser.
async function identity(pid) {
  const k = 'tg_idkey_' + pid;
  try {
    const saved = JSON.parse(localStorage.getItem(k) || 'null');
    if (saved && saved.priv && saved.pub) {
      const priv = await subtle().importKey('jwk', saved.priv, EC, false, ['deriveKey']);
      return { priv, pub: saved.pub };
    }
  } catch {}
  const kp = await newKeyPair();
  try { localStorage.setItem(k, JSON.stringify({ priv: kp.privJwk, pub: kp.pub })); } catch {}
  return { priv: kp.priv, pub: kp.pub };
}

// ---------- relay: the same messages through several brokers, de-duplicated

class Relay {
  constructor(onMessage, onChange) {
    this.topics = [];
    this.clients = BROKERS.map((b) => {
      const c = globalThis.mqtt.connect(b.url, {
        username: b.username, password: b.password,
        connectTimeout: 8000, reconnectPeriod: 2500, keepalive: 30, clean: true,
        queueQoSZero: false, resubscribe: false,
      });
      c.on('connect', () => { if (this.topics.length) c.subscribe(this.topics, { qos: 0 }); onChange(); });
      c.on('close', onChange);
      c.on('error', () => {});
      c.on('message', (topic, payload, packet) => onMessage(topic, payload.toString(), !!(packet && packet.retain)));
      return c;
    });
  }

  get up() { return this.clients.filter((c) => c.connected).length; }

  ready(ms) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => {
        if (this.up > 0) return resolve();
        if (Date.now() - t0 > ms) return reject(new Error("Can't reach the game servers. Check your internet connection and try again."));
        later(check, 150);
      };
      check();
    });
  }

  setTopics(topics) {
    const old = this.topics;
    this.topics = topics;
    for (const c of this.clients) {
      if (!c.connected) continue;
      if (old.length) c.unsubscribe(old);
      c.subscribe(topics, { qos: 0 });
    }
  }

  publish(topic, payload, retain = false) {
    for (const c of this.clients) if (c.connected) c.publish(topic, payload, { qos: 0, retain });
  }

  end() { for (const c of this.clients) { try { c.end(true); } catch {} } }
}

// ---------- room

export class Room {
  // game: 'bj' | 'poker'; makeHost({ code, hostPid, snapshot, emit, fx }) -> host game object;
  // successors(state) -> player ids in takeover order; merge(pub, priv) -> state for this player;
  // missing(pub, priv) -> true when private data for the current state hasn't arrived yet.
  constructor({ game, code, me, makeHost, successors, merge = (s) => s, missing = () => false, onState, onFx, onStatus, onFatal }) {
    Object.assign(this, { game, code, me, makeHost, successors, merge, missing, onState, onFx, onStatus, onFatal });
    this.closed = false;
    this.role = null; // 'host' | 'client' | 'electing' | null
    this.seen = new Set();
    this.seenOrder = [];
    this.q = Promise.resolve();
    this.sendQ = Promise.resolve();
    this.lastPublic = null;
    this.lastStateAt = 0;
    this.lastSaved = 0;
    this.saveTimer = null;
    this.priv = null;
    this.maxEpoch = 0;
    this.liveHost = null;
    this.n = 0;
    this.pairCache = new Map();
  }

  // ---------- lifecycle

  async open(code) {
    if (!this.id) this.id = await identity(this.me.id);
    if (!this.relay) {
      this.relay = new Relay((t, p, r) => this.onRaw(t, p, r), () => this.netChanged());
      await this.relay.ready(15000);
    }
    this.code = code;
    this.sec = await roomSecrets(this.game, code);
    this.liveHost = null;
    this.relay.setTopics([this.sec.topic, this.sec.hostTopic]);
  }

  // Wait briefly for a live host heartbeat (retained ones only tell us the last epoch).
  async probe(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms && !this.closed) {
      if (this.liveHost) return this.liveHost;
      await sleep(120);
    }
    return this.liveHost;
  }

  async create() {
    for (let i = 0; i < 5 && !this.closed; i++) {
      await this.open(this.code);
      if (!(await this.probe(1600))) { await this.becomeHost(null, this.maxEpoch + 1); return; }
      this.code = makeCode(); // someone is already using this code
    }
    throw new Error('Could not create a room. Try again.');
  }

  async establish() {
    await this.open(this.code);
    const host = await this.probe(PROBE);
    if (this.closed) return;
    if (host) this.follow(host);
    else await this.becomeHost(this.bestSnapshot(), this.maxEpoch + 1, true);
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    this.flushSave();
    this.stopTimers();
    if (this.relay && this.sec) {
      const bye = { t: 'bye', f: this.me.id };
      const wasHost = this.role === 'host';
      seal(this.sec.key, bye).then((p) => {
        this.relay.publish(this.sec.topic, p);
        if (wasHost) this.relay.publish(this.sec.hostTopic, '', true); // clear the retained heartbeat
        later(() => this.relay.end(), 400);
      }).catch(() => this.relay.end());
    } else if (this.relay) this.relay.end();
    if (this.host) this.host.destroy();
  }

  stopTimers() {
    for (const k of ['beatTimer', 'hiTimer', 'watchTimer', 'presenceTimer']) if (this[k]) { this[k].cancel(); this[k] = null; }
  }

  netChanged() {
    if (this.closed || !this.relay) return;
    if (this.relay.up === 0 && this.role) this.onStatus({ state: 'connecting', attempt: 1 });
    else if (this.relay.up > 0 && this.role === 'host') this.onStatus({ state: 'online', role: 'host', code: this.code });
    else if (this.relay.up > 0 && this.role === 'client' && this.lastPublic) {
      this.onStatus({ state: 'online', role: 'client', code: this.code });
      this.sendHi(true); // a broker came back: make sure we're current
    }
  }

  bestSnapshot() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(`tg_${this.game}_room_${this.code}`) || 'null');
      if (saved && Date.now() - saved.savedAt > SNAP_TTL) saved = null;
    } catch {}
    if (this.lastPublic && (!saved || this.lastStateAt >= saved.savedAt)) return this.lastPublic;
    return saved;
  }

  remember(pub) {
    this.lastPublic = pub;
    this.lastStateAt = Date.now();
    if (this.saveTimer) return;
    const due = Math.max(0, 1000 - (Date.now() - this.lastSaved));
    this.saveTimer = setTimeout(() => this.flushSave(), due);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.lastPublic) return;
    this.lastSaved = Date.now();
    try { localStorage.setItem(`tg_${this.game}_room_${this.code}`, JSON.stringify({ ...this.lastPublic, savedAt: this.lastStateAt })); } catch {}
  }

  // ---------- messaging

  send(msg, topic) {
    if (this.closed || !this.sec) return;
    const sec = this.sec;
    const text = JSON.stringify(msg); // freeze now; the object may change before the queue gets to it
    this.sendQ = this.sendQ.then(async () => {
      const box = await sealText(sec.key, text);
      if (this.sec === sec && this.relay) this.relay.publish(topic || sec.topic, box, topic === sec.hostTopic);
    }).catch((e) => console.warn('send failed', e));
  }

  pair(pub) {
    const k = pub.x + pub.y;
    if (!this.pairCache.has(k)) this.pairCache.set(k, pairKey(this.id.priv, pub));
    return this.pairCache.get(k);
  }

  onRaw(topic, payload, retained) {
    if (this.closed || !this.sec || !payload || (topic !== this.sec.topic && topic !== this.sec.hostTopic)) return;
    const k = payload.slice(0, 16); // the random IV: identical copies from several brokers share it
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.seenOrder.push(k);
    if (this.seenOrder.length > 4000) this.seen.delete(this.seenOrder.shift());
    const sec = this.sec;
    this.q = this.q.then(async () => {
      let m;
      try { m = await unseal(sec.key, payload); } catch { return; } // not for this room / tampered
      if (this.sec !== sec || this.closed || !m || m.f === this.me.id) return;
      await this.handle(m, retained);
    }).catch((e) => console.warn('message failed', e));
  }

  async handle(m, retained) {
    switch (m.t) {
      case 'hb': return this.onBeat(m, retained);
      case 'state': return this.onStateMsg(m);
      case 'priv': return this.onPriv(m);
      case 'fx': if (this.role === 'client' && m.f === this.hostId) this.onFx(m.fx); return;
      case 'full': if (m.to === this.me.id && m.f === this.hostId) { this.leave(); this.onFatal('That table is full.'); } return;
      case 'hi': if (this.role === 'host') await this.hostHi(m); return;
      case 'act': if (this.role === 'host' && m.to === this.me.id) await this.hostAct(m); return;
      case 'bye':
        if (this.role === 'host' && this.host) { const p = this.peers.get(m.f); if (p) p.lastSeen = 0; this.host.leave(m.f); }
        else if (this.role === 'client' && m.f === this.hostId) this.hostLost();
        return;
    }
  }

  // ---------- heartbeats & host selection

  onBeat(m, retained) {
    if (!Number.isFinite(m.e) || !m.pub) return;
    this.maxEpoch = Math.max(this.maxEpoch, m.e);
    if (retained) return;
    const beat = { id: m.f, e: m.e, pub: m.pub };
    if (!this.role || this.role === 'electing') { this.liveHost = this.liveHost && !better(beat, this.liveHost) ? this.liveHost : beat; return; }
    if (this.role === 'client') {
      if (m.f === this.hostId) { this.lastHeard = Date.now(); return; }
      if (better(beat, { id: this.hostId, e: this.hostEpoch })) this.follow(beat);
      return;
    }
    if (this.role === 'host' && better(beat, { id: this.me.id, e: this.epoch })) {
      // Another host outranks us (two players took over at once): hand over and follow it.
      this.stepDown();
      this.follow(beat);
    }
  }

  follow(h) {
    this.stopTimers();
    this.role = 'client';
    this.hostId = h.id;
    this.hostEpoch = h.e;
    this.hostPub = h.pub;
    this.hostKey = this.pair(h.pub);
    this.lastHeard = Date.now();
    this.lastSeq = -1;
    this.gotState = false;
    this.priv = null;
    this.sendHi(true);
    this.hiTimer = every(() => this.sendHi(!this.gotState), CLIENT_HI);
    this.watchTimer = every(() => this.watch(), 1000);
  }

  sendHi(fresh) {
    if (this.role !== 'client') return;
    this.send({ t: 'hi', f: this.me.id, to: this.hostId, name: this.me.name, avatar: this.me.avatar, pub: this.id.pub, fresh: !!fresh });
  }

  watch() {
    if (this.role !== 'client') return;
    if (Date.now() - this.lastHeard > HOST_SILENCE) { this.hostLost(); return; }
    // Our private data (e.g. hole cards) didn't arrive — ask again.
    if (this.lastPublic && this.missing(this.lastPublic, this.priv) && Date.now() - this.lastStateAt > 1200) this.sendHi(true);
  }

  async hostLost() {
    if (this.closed || this.role !== 'client') return;
    const oldHost = this.hostId;
    const oldEpoch = this.hostEpoch;
    this.stopTimers();
    this.role = 'electing';
    this.liveHost = null;
    this.onStatus({ state: 'connecting' });
    const order = (this.lastPublic ? this.successors(this.lastPublic) : []).filter((id) => id !== oldHost);
    let rank = order.indexOf(this.me.id);
    if (rank < 0) rank = order.length + 1;
    const until = Date.now() + 1200 + rank * 3000;
    while (Date.now() < until && !this.closed && this.role === 'electing') {
      const h = this.liveHost;
      if (h) { this.follow(h); return; } // someone (maybe the old host, back from a blip) is hosting
      await sleep(200);
    }
    if (this.closed || this.role !== 'electing') return;
    await this.becomeHost(this.bestSnapshot(), Math.max(this.maxEpoch, oldEpoch || 0) + 1);
  }

  // ---------- client side

  onStateMsg(m) {
    if (this.role !== 'client' || m.f !== this.hostId || m.e !== this.hostEpoch || !m.s) return;
    if (m.q <= this.lastSeq) return;
    this.lastSeq = m.q;
    this.lastHeard = Date.now();
    this.remember(m.s);
    if (!this.gotState) {
      this.gotState = true;
      this.onStatus({ state: 'online', role: 'client', code: this.code });
    }
    this.onState(this.merge(structuredClone(m.s), this.priv));
  }

  async onPriv(m) {
    if (this.role !== 'client' || m.f !== this.hostId || m.to !== this.me.id || m.e !== this.hostEpoch) return;
    try { this.priv = await unseal(await this.hostKey, m.box); } catch { return; }
    if (this.lastPublic) this.onState(this.merge(structuredClone(this.lastPublic), this.priv));
  }

  act(a, extra = {}) {
    const m = { a, ...extra };
    if (this.role === 'host' && this.host) { this.host.action(this.me.id, m); return; }
    if (this.role !== 'client') return;
    const hostId = this.hostId;
    const key = this.hostKey;
    const n = ++this.n;
    const text = JSON.stringify({ ...m, n });
    this.sendQ = this.sendQ.then(async () => {
      const box = await sealText(await key, text);
      const out = await seal(this.sec.key, { t: 'act', f: this.me.id, to: hostId, box });
      this.relay.publish(this.sec.topic, out);
    }).catch((e) => console.warn('act failed', e));
  }

  // ---------- host side

  async becomeHost(snapshot, epoch, announceEmpty = false) {
    if (this.closed) return;
    this.stopTimers();
    this.role = 'host';
    this.hostId = this.me.id;
    this.epoch = epoch;
    this.maxEpoch = Math.max(this.maxEpoch, epoch);
    this.peers = new Map();
    this.privSent = new Map();
    this.seq = 0;
    this.host = this.makeHost({
      code: this.code,
      hostPid: this.me.id,
      snapshot,
      emit: (pub) => this.hostEmit(pub),
      fx: (fx) => this.hostFx(fx),
    });
    this.beat();
    this.beatTimer = every(() => this.beat(), HOST_BEAT);
    this.presenceTimer = every(() => this.presence(), 2000);
    this.host.join(this.me.id, this.me.name, this.me.avatar);
    this.onStatus({ state: 'online', role: 'host', code: this.code, fresh: announceEmpty && !snapshot });
  }

  stepDown() {
    this.stopTimers();
    if (this.host) this.host.destroy();
    this.host = null;
    this.role = null;
  }

  beat() {
    if (this.role !== 'host') return;
    this.send({ t: 'hb', f: this.me.id, e: this.epoch, pub: this.id.pub }, this.sec.hostTopic);
  }

  presence() {
    if (this.role !== 'host' || !this.host) return;
    const now = Date.now();
    for (const [pid, p] of this.peers) {
      const gp = this.host.s.players[pid];
      if (gp && gp.connected && now - p.lastSeen > CLIENT_SILENCE) this.host.leave(pid);
    }
  }

  hostEmit(pub) {
    if (this.role !== 'host' || !this.host) return;
    const state = pub || this.host.publicState();
    this.remember(state);
    // Private parts first so they're in hand when the matching public state lands.
    if (this.host.privateFor) {
      for (const [pid, p] of this.peers) {
        const gp = this.host.s.players[pid];
        if (!gp || !gp.connected) continue;
        const priv = this.host.privateFor(pid);
        const sig = JSON.stringify(priv);
        if (this.privSent.get(pid) === sig) continue;
        this.privSent.set(pid, sig);
        this.sendPriv(pid, p, priv);
      }
    }
    this.send({ t: 'state', f: this.me.id, e: this.epoch, q: ++this.seq, s: state });
    this.onState(this.merge(structuredClone(state), this.host.privateFor ? this.host.privateFor(this.me.id) : null));
  }

  sendPriv(pid, p, priv) {
    const sec = this.sec;
    const epoch = this.epoch;
    const text = JSON.stringify(priv);
    this.sendQ = this.sendQ.then(async () => {
      const box = await sealText(await p.key, text);
      const out = await seal(sec.key, { t: 'priv', f: this.me.id, e: epoch, to: pid, box });
      if (this.sec === sec) this.relay.publish(sec.topic, out);
    }).catch((e) => console.warn('priv failed', e));
  }

  hostFx(fx) {
    this.send({ t: 'fx', f: this.me.id, fx });
    this.onFx(fx);
  }

  async hostHi(m) {
    if (m.to && m.to !== this.me.id) return;
    const pid = String(m.f || '').slice(0, 48);
    if (!pid || !m.pub || typeof m.pub.x !== 'string' || typeof m.pub.y !== 'string') return;
    const now = Date.now();
    let p = this.peers.get(pid);
    const keyId = m.pub.x + m.pub.y;
    if (p && p.keyId !== keyId) {
      if (now - p.lastSeen < CLIENT_SILENCE) return; // someone else claiming an active player's id
      p = null;
    }
    if (!p) {
      p = { keyId, key: this.pair(m.pub), lastSeen: 0, lastN: 0 };
      try { await p.key; } catch { return; }
      this.peers.set(pid, p);
    }
    p.lastSeen = now;
    const gp = this.host.s.players[pid];
    if (!gp || !gp.connected) {
      if (!this.host.join(pid, m.name, m.avatar)) {
        this.send({ t: 'full', f: this.me.id, to: pid });
        this.peers.delete(pid);
        return;
      }
      this.privSent.delete(pid);
    } else if (m.fresh) {
      // They (re)loaded while we still had them seated: resend everything.
      this.privSent.delete(pid);
      this.hostEmit();
    }
  }

  async hostAct(m) {
    const p = this.peers.get(m.f);
    if (!p || !m.box) return;
    let a;
    try { a = await unseal(await p.key, m.box); } catch { return; }
    if (!a || !(a.n > p.lastN) || typeof a.a !== 'string') return;
    p.lastN = a.n;
    p.lastSeen = Date.now();
    const { n, ...action } = a;
    this.host.action(m.f, action);
  }
}

// Higher epoch wins; ties go to the smaller id.
function better(a, b) {
  if (!b || !Number.isFinite(b.e)) return true;
  return a.e > b.e || (a.e === b.e && String(a.id) < String(b.id));
}
