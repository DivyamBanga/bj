// Authoritative game state machine. Runs in whichever browser currently hosts the room.
// Clients only ever see publicState() — the shoe and the dealer's hole card stay here.

import {
  RULES, buildShoe, handValue, isBlackjack, cardValue, rankOf,
  canSplit, canDouble, settleHand, dealerShouldHit,
} from './engine.js';
import { later } from './timers.js';

export const TIMING = {
  deal: 430,
  peek: 350,
  dealerStart: 450,
  reveal: 750,
  dealerDraw: 820,
  settleHold: 5200,
  betCountdown: 15000,
  turnTime: 30000,
  allReady: 900,
  shuffle: 1900,
  dropGrace: 8000,
  gameoverDelay: 1800,
};

export const REACTIONS = ['🔥', '😂', '😱', '👏', '💀', '🤑', '😤', '🙏'];

const ACTIVE = new Set(['shuffling', 'dealing', 'playing', 'dealer']);
const CANCEL = Symbol('cancel');

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Player';
const cleanAvatar = (a) => [...String(a || '🃏')].slice(0, 2).join('') || '🃏';

function newPlayer(id, name, avatar) {
  return {
    id, name, avatar,
    bank: RULES.startBank, bet: 0, ready: false, connected: true, hands: [],
    lastBet: 0, lastNet: 0, streak: 0, resets: 0, wins: 0, played: 0, best: 0,
  };
}

function newHand(bet) {
  return { cards: [], bet, done: false, doubled: false, split: false, splitAces: false, result: null, payout: 0 };
}

function freshState(code, host) {
  return {
    code, host, match: 1, round: 0, phase: 'betting',
    players: {}, order: [], dealer: { cards: [], hole: false },
    deadline: null, dur: null, winner: null,
    feed: [], chat: [], seq: 1, fseq: 1, shoeLeft: 0, shoeTotal: 0,
  };
}

// Rebuild a live state from a saved/public snapshot (host refresh or host migration).
// Any round in flight is voided and its stakes refunded.
function restoreState(snap, code, host) {
  const s = freshState(code, host);
  if (!snap || typeof snap !== 'object' || !snap.players || typeof snap.players !== 'object') return { s, voided: false };
  let voided = false;
  for (const [id, raw] of Object.entries(snap.players)) {
    if (!raw || typeof raw !== 'object') continue;
    const p = newPlayer(id, cleanName(raw.name), cleanAvatar(raw.avatar));
    for (const k of ['bank', 'lastBet', 'streak', 'resets', 'wins', 'played', 'best']) {
      if (Number.isFinite(raw[k])) p[k] = raw[k];
    }
    if (ACTIVE.has(snap.phase) && Array.isArray(raw.hands)) {
      for (const h of raw.hands) {
        if (h && h.result == null && Number.isFinite(h.bet)) { p.bank += h.bet; voided = true; }
      }
    }
    p.connected = false;
    p.bet = 0;
    s.players[id] = p;
  }
  for (const k of ['match', 'round', 'seq', 'fseq']) if (Number.isFinite(snap[k])) s[k] = snap[k];
  if (Array.isArray(snap.feed)) s.feed = snap.feed.slice(-30);
  if (Array.isArray(snap.chat)) s.chat = snap.chat.slice(-50);
  if (snap.phase === 'gameover' && snap.winner) { s.phase = 'gameover'; s.winner = snap.winner; }
  return { s, voided };
}

export class HostGame {
  constructor({ code, hostPid, snapshot = null, onState, onFx = () => {}, timing = TIMING }) {
    this.t = timing;
    this.onState = onState;
    this.onFx = onFx;
    this.gen = 0;
    this.timer = null;
    this.syncQueued = false;
    this.destroyed = false;
    this.lastReact = new Map();
    this.lastChat = new Map();
    const { s, voided } = restoreState(snapshot, code, hostPid);
    this.s = s;
    if (voided) this.feed('Host changed — the unfinished hand was refunded', 'info');
    this.newShoe(false);
  }

  // ---------- plumbing

  P(pid) { return this.s.players[pid]; }
  seated() { return this.s.order.map((id) => this.s.players[id]).filter(Boolean); }
  participants() { return this.seated().filter((p) => p.hands.length); }

  feed(text, kind = 'info', pid = null) {
    const f = this.s.feed;
    f.push({ id: this.s.fseq++, text, kind, pid });
    if (f.length > 30) f.splice(0, f.length - 30);
  }

  sync() {
    if (this.syncQueued || this.destroyed) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      if (!this.destroyed) this.onState(this.publicState());
    });
  }

  publicState() {
    const pub = JSON.parse(JSON.stringify(this.s));
    if (this.s.dealer.hole && pub.dealer.cards[1]) pub.dealer.cards[1].c = null;
    pub.rem = this.s.deadline ? Math.max(0, this.s.deadline - Date.now()) : null;
    delete pub.deadline;
    return pub;
  }

  wait(ms) {
    const g = this.gen;
    return new Promise((r) => later(r, ms)).then(() => {
      if (g !== this.gen || this.destroyed) throw CANCEL;
    });
  }

  run(fn) {
    fn().catch((e) => { if (e !== CANCEL) console.error(e); });
  }

  setTimer(ms, fn) {
    this.clearTimer();
    const g = this.gen;
    this.timer = later(() => {
      this.timer = null;
      if (g === this.gen && !this.destroyed) fn();
    }, ms);
  }

  clearTimer() {
    if (this.timer) this.timer.cancel();
    this.timer = null;
  }

  setDeadline(ms) {
    this.s.deadline = ms == null ? null : Date.now() + ms;
    this.s.dur = ms;
  }

  newShoe(announce) {
    this.shoe = buildShoe();
    this.s.shoeTotal = this.shoe.length;
    this.s.shoeLeft = this.shoe.length;
    this.cutCount = Math.floor(this.shoe.length * RULES.reshuffleAt);
    if (announce) this.feed('Fresh shoe shuffled in', 'shuffle');
  }

  draw() {
    if (!this.shoe.length) this.newShoe(false);
    const c = this.shoe.pop();
    this.s.shoeLeft = this.shoe.length;
    return { i: this.s.seq++, c };
  }

  destroy() {
    this.destroyed = true;
    this.gen++;
    this.clearTimer();
  }

  // ---------- presence

  join(pid, name, avatar) {
    const s = this.s;
    name = cleanName(name);
    avatar = cleanAvatar(avatar);
    if (!s.order.includes(pid)) {
      const others = this.seated().filter((p) => p.connected && p.id !== pid).length;
      if (others >= RULES.maxPlayers) return false;
    }
    let p = s.players[pid];
    if (!p) {
      p = s.players[pid] = newPlayer(pid, name, avatar);
      this.feed(`${name} joined the table`, 'join', pid);
    } else {
      if (!p.connected) this.feed(`${name} is back`, 'join', pid);
      p.name = name;
      p.avatar = avatar;
    }
    p.connected = true;
    if (!s.order.includes(pid)) s.order.push(pid);
    this.checkBetting();
    this.sync();
    return true;
  }

  leave(pid) {
    const s = this.s;
    const p = this.P(pid);
    if (!p || !p.connected) return;
    p.connected = false;
    this.feed(`${p.name} left`, 'leave', pid);
    if (s.phase === 'betting') {
      p.ready = false;
      s.order = s.order.filter((id) => id !== pid);
      this.checkBetting();
    } else if (s.phase === 'playing' && p.hands.length) {
      this.graceStand(pid);
    } else if (!p.hands.length) {
      s.order = s.order.filter((id) => id !== pid);
    }
    this.sync();
  }

  // A player who drops mid-hand gets a few seconds to come back before their hands stand.
  graceStand(pid) {
    const g = this.gen;
    const round = this.s.round;
    later(() => {
      const p = this.P(pid);
      if (g !== this.gen || this.destroyed || this.s.round !== round || this.s.phase !== 'playing') return;
      if (!p || p.connected) return;
      for (const h of p.hands) h.done = true;
      this.sync();
      this.checkAllDone();
    }, this.t.dropGrace);
  }

  // ---------- actions

  action(pid, m) {
    const p = this.P(pid);
    const s = this.s;
    if (!p || !m || typeof m.a !== 'string') return;
    switch (m.a) {
      case 'bet': {
        if (s.phase !== 'betting' || p.ready) return;
        const amt = Math.floor(Number(m.amount));
        if (!Number.isFinite(amt) || amt < 0) return;
        p.bet = Math.min(amt, p.bank);
        this.sync();
        return;
      }
      case 'ready': {
        if (s.phase !== 'betting' || p.ready || p.bet < RULES.minBet || p.bet > p.bank) return;
        p.ready = true;
        this.checkBetting();
        this.sync();
        return;
      }
      case 'unready': {
        if (s.phase !== 'betting' || !p.ready) return;
        p.ready = false;
        this.checkBetting();
        this.sync();
        return;
      }
      case 'hit': case 'stand': case 'double': case 'split':
        this.play(p, m);
        return;
      case 'reset': {
        if (s.phase === 'gameover') return;
        if (ACTIVE.has(s.phase) && p.hands.length) return;
        p.bank = RULES.startBank;
        p.bet = 0;
        p.ready = false;
        p.streak = 0;
        p.resets++;
        this.feed(`${p.name} reset to $1,000`, 'reset', pid);
        this.checkBetting();
        this.sync();
        return;
      }
      case 'newMatch':
        if (s.phase === 'gameover') this.newMatch(p);
        return;
      case 'chat': {
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const now = Date.now();
        if (!text || now - (this.lastChat.get(pid) || 0) < 300) return;
        this.lastChat.set(pid, now);
        s.chat.push({ id: s.fseq++, pid, name: p.name, avatar: p.avatar, text });
        if (s.chat.length > 50) s.chat.splice(0, s.chat.length - 50);
        this.sync();
        return;
      }
      case 'react': {
        const now = Date.now();
        if (!REACTIONS.includes(m.e) || now - (this.lastReact.get(pid) || 0) < 200) return;
        this.lastReact.set(pid, now);
        this.onFx({ k: 'react', pid, e: m.e });
        return;
      }
    }
  }

  // ---------- betting

  checkBetting() {
    const s = this.s;
    if (s.phase !== 'betting') return;
    const seated = this.seated().filter((p) => p.connected);
    const ready = seated.filter((p) => p.ready);
    if (!ready.length) {
      this.clearTimer();
      this.setDeadline(null);
      return;
    }
    const eligible = seated.filter((p) => p.bank >= RULES.minBet);
    if (eligible.every((p) => p.ready)) {
      this.setDeadline(null);
      this.setTimer(this.t.allReady, () => this.startRound());
      return;
    }
    if (!s.deadline) {
      this.setDeadline(this.t.betCountdown);
      this.setTimer(this.t.betCountdown, () => this.startRound());
    }
  }

  startRound() {
    const s = this.s;
    if (s.phase !== 'betting') return;
    this.clearTimer();
    this.setDeadline(null);
    const players = this.seated().filter((p) => p.connected && p.ready && p.bet >= RULES.minBet && p.bet <= p.bank);
    if (!players.length) {
      for (const p of this.seated()) p.ready = false;
      this.sync();
      return;
    }
    s.round++;
    for (const p of this.seated()) {
      if (players.includes(p)) {
        p.bank -= p.bet;
        p.hands = [newHand(p.bet)];
        p.lastBet = p.bet;
      }
      p.bet = 0;
      p.ready = false;
    }
    s.dealer = { cards: [], hole: true };
    this.run(() => this.dealSequence(players));
  }

  async dealSequence(players) {
    const s = this.s;
    if (this.shoe.length < this.cutCount) {
      s.phase = 'shuffling';
      this.sync();
      this.onFx({ k: 'shuffle' });
      await this.wait(this.t.shuffle);
      this.newShoe(true);
    }
    s.phase = 'dealing';
    this.sync();
    for (let r = 0; r < 2; r++) {
      for (const p of players) {
        p.hands[0].cards.push(this.draw());
        this.sync();
        await this.wait(this.t.deal);
      }
      s.dealer.cards.push(this.draw());
      this.sync();
      await this.wait(this.t.deal);
    }
    // Dealer peeks when showing an ace or ten.
    if (cardValue(s.dealer.cards[0].c) >= 10 && isBlackjack(s.dealer.cards)) {
      await this.wait(this.t.peek);
      s.dealer.hole = false;
      this.feed('Dealer has blackjack', 'dealer');
      this.sync();
      await this.wait(this.t.reveal);
      await this.settle();
      return;
    }
    for (const p of players) for (const h of p.hands) if (isBlackjack(h.cards)) h.done = true;
    s.phase = 'playing';
    this.setDeadline(this.t.turnTime);
    this.setTimer(this.t.turnTime, () => this.timeoutTurns());
    for (const p of players) if (!p.connected) this.graceStand(p.id);
    this.sync();
    this.checkAllDone();
  }

  // ---------- playing

  play(p, m) {
    if (this.s.phase !== 'playing') return;
    const idx = p.hands.findIndex((h) => !h.done);
    if (idx < 0 || m.h !== idx) return;
    const h = p.hands[idx];
    if (m.n !== h.cards.length) return; // stale or double-clicked action
    switch (m.a) {
      case 'hit':
        h.cards.push(this.draw());
        if (handValue(h.cards).total >= 21) h.done = true;
        break;
      case 'stand':
        h.done = true;
        break;
      case 'double':
        if (!canDouble(h, p.bank)) return;
        p.bank -= h.bet;
        h.bet *= 2;
        h.doubled = true;
        h.cards.push(this.draw());
        h.done = true;
        break;
      case 'split': {
        if (!canSplit(h, p.bank, p.hands.length)) return;
        p.bank -= h.bet;
        const aces = rankOf(h.cards[0].c) === 'A';
        const a = newHand(h.bet);
        const b = newHand(h.bet);
        a.split = b.split = true;
        a.cards = [h.cards[0], this.draw()];
        b.cards = [h.cards[1], this.draw()];
        for (const x of [a, b]) {
          if (aces) { x.splitAces = true; x.done = true; }
          if (handValue(x.cards).total === 21) x.done = true;
        }
        p.hands.splice(idx, 1, a, b);
        break;
      }
      default:
        return;
    }
    this.sync();
    this.checkAllDone();
  }

  timeoutTurns() {
    if (this.s.phase !== 'playing') return;
    for (const p of this.participants()) {
      if (p.hands.some((h) => !h.done)) {
        for (const h of p.hands) h.done = true;
        this.feed(`${p.name} ran out of time`, 'info', p.id);
      }
    }
    this.sync();
    this.checkAllDone();
  }

  checkAllDone() {
    const s = this.s;
    if (s.phase !== 'playing') return;
    if (!this.participants().every((p) => p.hands.every((h) => h.done))) return;
    this.clearTimer();
    this.setDeadline(null);
    s.phase = 'dealer';
    this.sync();
    this.run(() => this.dealerSequence());
  }

  async dealerSequence() {
    const s = this.s;
    await this.wait(this.t.dealerStart);
    s.dealer.hole = false;
    this.sync();
    await this.wait(this.t.reveal);
    const live = this.participants().some((p) =>
      p.hands.some((h) => handValue(h.cards).total <= 21 && !isBlackjack(h.cards, h.split)));
    if (live) {
      while (dealerShouldHit(s.dealer.cards)) {
        s.dealer.cards.push(this.draw());
        this.sync();
        await this.wait(this.t.dealerDraw);
      }
    }
    await this.settle();
  }

  // ---------- settlement

  async settle() {
    const s = this.s;
    s.phase = 'settle';
    this.setDeadline(null);
    for (const p of this.participants()) {
      let net = 0;
      let bj = false;
      for (const h of p.hands) {
        const r = settleHand(h, s.dealer.cards);
        h.result = r.result;
        h.payout = r.payout;
        p.bank += r.payout;
        net += r.payout - h.bet;
        if (r.result === 'blackjack') bj = true;
      }
      p.played++;
      p.lastNet = net;
      if (net > 0) { p.streak++; p.wins++; } else if (net < 0) p.streak = 0;
      if (net > p.best) p.best = net;
      if (bj) this.feed(`${p.name} hit blackjack!`, 'bj', p.id);
      else if (net >= 1000) this.feed(`${p.name} won ${money(net)}`, 'big', p.id);
      if (net > 0 && (p.streak === 3 || p.streak === 5 || p.streak === 8 || p.streak === 12)) {
        this.feed(`${p.name} is on a ${p.streak}-hand heater`, 'streak', p.id);
      }
    }
    this.sync();
    const champ = this.participants().filter((p) => p.bank >= RULES.goal).sort((a, b) => b.bank - a.bank)[0];
    if (champ) {
      await this.wait(this.t.gameoverDelay);
      s.phase = 'gameover';
      s.winner = { id: champ.id, name: champ.name, avatar: champ.avatar, bank: champ.bank };
      this.feed(`${champ.name} reached $10,000 and wins match #${s.match}!`, 'win', champ.id);
      this.sync();
      return;
    }
    await this.wait(this.t.settleHold);
    this.clearRound();
  }

  clearRound() {
    const s = this.s;
    for (const p of Object.values(s.players)) {
      p.hands = [];
      p.ready = false;
      const rebet = Math.min(p.lastBet || 0, p.bank);
      p.bet = p.connected && rebet >= RULES.minBet ? rebet : 0;
    }
    s.dealer = { cards: [], hole: false };
    s.order = s.order.filter((id) => s.players[id] && s.players[id].connected);
    s.phase = 'betting';
    this.checkBetting();
    this.sync();
  }

  newMatch(by) {
    const s = this.s;
    this.gen++;
    this.clearTimer();
    s.match++;
    s.round = 0;
    s.winner = null;
    for (const p of Object.values(s.players)) {
      Object.assign(p, {
        bank: RULES.startBank, bet: 0, ready: false, hands: [],
        lastBet: 0, lastNet: 0, streak: 0, resets: 0, wins: 0, played: 0, best: 0,
      });
    }
    s.dealer = { cards: [], hole: false };
    s.order = s.order.filter((id) => s.players[id] && s.players[id].connected);
    s.phase = 'betting';
    this.setDeadline(null);
    this.newShoe(false);
    this.feed(`${by.name} started match #${s.match} — everyone back to $1,000`, 'info', by.id);
    this.sync();
  }
}
