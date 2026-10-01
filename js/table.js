// Renders broadcast state onto the table and choreographs every animation:
// cards fly from the shoe (FLIP-keyed by card id), flip, slide on splits and sweep to the discard;
// chips fly between the tray, betting spots and the dealer; reactions float over seats.

import { RULES, handValue, isBlackjack, rankOf, suitOf, canSplit, canDouble } from './engine.js';
import { REACTIONS } from './host.js';
import { sfx } from './audio.js';
import { confetti } from './confetti.js';

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
const TRAY = [10, 25, 100, 500, 1000];
const STACK = [5000, 1000, 500, 100, 25, 10, 5, 1];
const ACTIVE = new Set(['shuffling', 'dealing', 'playing', 'dealer']);

export const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (id) => document.getElementById(id);
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const center = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

// Net worth for the race: bank plus anything still riding on unsettled hands.
export const worth = (p) => p.bank + p.hands.reduce((a, h) => a + (h.result == null ? h.bet : 0), 0);

function breakdown(amount, max = 8) {
  const out = [];
  let left = Math.round(amount);
  for (const d of STACK) while (left >= d && out.length < 40) { out.push(d); left -= d; }
  return out.slice(0, max);
}

function totalLabel(cards, split, final) {
  const known = cards.filter((c) => c.c);
  if (!known.length) return { text: '', cls: '' };
  const v = handValue(known);
  if (v.total > 21) return { text: String(v.total), cls: 'bust' };
  if (known.length === cards.length && isBlackjack(cards, split)) return { text: 'BJ', cls: 'twentyone' };
  if (v.total === 21) return { text: '21', cls: 'twentyone' };
  if (v.soft && !final && known.length === cards.length) return { text: `${v.total - 10}/${v.total}`, cls: '' };
  return { text: String(v.total), cls: '' };
}

const RESULT_LABEL = { blackjack: 'Blackjack', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' };

export class Table {
  constructor() {
    this.els = {
      dealerCards: $('dealer-cards'), dealerTotal: $('dealer-total'), dealerTray: $('dealer-tray'),
      table: $('table'), status: $('status'), seats: $('seats'), shoe: $('shoe'), shoeCard: document.querySelector('.shoe-card'), shoeMeter: $('shoe-meter'),
      discard: $('discard'), fx: $('fx'),
      statusMain: $('status-main'), statusSub: $('status-sub'), ring: $('status-ring'), ringProg: document.querySelector('#status-ring .prog'),
      dock: $('dock'), dockBank: $('dock-bank'), chipTray: $('chip-tray'), dealBtn: $('deal-btn'), dealAmt: $('deal-amt'),
      betClear: $('bet-clear'), betDouble: $('bet-double'), betMax: $('bet-max'), readyAmt: $('ready-amt'), unready: $('unready-btn'),
      hit: $('act-hit'), stand: $('act-stand'), double: $('act-double'), split: $('act-split'),
      waitMsg: $('wait-msg'), rebuy: $('rebuy-btn'), newMatchDock: $('newmatch-dock'), react: $('react-bar'),
      raceTokens: $('race-tokens'), raceFill: $('race-fill'), raceTrack: document.querySelector('.race-track'),
      board: $('board'), chat: $('chat-list'), resetBtn: $('reset-btn'),
      victory: $('victory'), vAvatar: $('victory-avatar'), vTitle: $('victory-title'), vSub: $('victory-sub'), vBoard: $('victory-board'),
      side: $('side'), chatBadge: $('chat-badge'),
    };
    this.act = () => {};
    this.toast = () => {};
    this.reset();
    this.bind();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    addEventListener('resize', () => { if (this.s) this.fitSeats(); });
  }

  attach({ meId, act, toast }) {
    this.meId = meId;
    this.act = act;
    this.toast = toast;
  }

  reset() {
    this.s = null;
    this.first = true;
    this.draft = null;
    this.deadline = null;
    this.dur = null;
    this.seenFeed = -1;
    this.seenChat = -1;
    this.activeHand = null;
    this.pendingAct = false;
    this.lastSecond = null;
    this.subBase = '';
    if (this.cardEls) for (const c of this.cardEls.values()) c.remove();
    this.cardEls = new Map();
    this.seatEls = new Map();
    this.tokenEls = new Map();
    this.rowEls = new Map();
    const e = this.els;
    e.seats.innerHTML = '';
    e.dealerCards.innerHTML = '';
    e.raceTokens.innerHTML = '';
    e.board.innerHTML = '';
    e.chat.innerHTML = '<div class="chat-empty">No messages yet. Talk a little trash.</div>';
    e.fx.innerHTML = '';
    e.victory.hidden = true;
    e.dealerTotal.hidden = true;
    e.statusMain.innerHTML = '';
    e.statusSub.textContent = '';
    e.ring.hidden = true;
    e.dock.dataset.mode = 'wait';
    e.waitMsg.textContent = 'Taking your seat…';
  }

  // ---------- input

  bind() {
    const e = this.els;
    for (const v of TRAY) {
      const b = el('button', 'tray-chip', `<div class="chip" data-v="${v}"></div><span>${v >= 1000 ? v / 1000 + 'K' : v}</span>`);
      b.dataset.v = v;
      b.title = `Add $${v}`;
      b.addEventListener('click', () => this.addChip(v, b));
      e.chipTray.append(b);
    }
    e.betClear.addEventListener('click', () => this.setBet(0));
    e.betDouble.addEventListener('click', () => this.setBet(this.betAmount() * 2, e.betDouble));
    e.betMax.addEventListener('click', () => { const me = this.me(); if (me) this.setBet(me.bank, e.betMax); });
    e.dealBtn.addEventListener('click', () => this.deal());
    e.unready.addEventListener('click', () => { sfx.click(); this.act('unready'); });
    e.hit.addEventListener('click', () => this.play('hit'));
    e.stand.addEventListener('click', () => this.play('stand'));
    e.double.addEventListener('click', () => this.play('double'));
    e.split.addEventListener('click', () => this.play('split'));
    e.rebuy.addEventListener('click', () => { sfx.chips(5); this.act('reset'); });
    e.newMatchDock.addEventListener('click', () => this.act('newMatch'));
    for (const r of REACTIONS) {
      const b = el('button', '', r);
      b.title = 'React';
      b.addEventListener('click', () => this.act('react', { e: r }));
      e.react.append(b);
    }
    addEventListener('keydown', (ev) => {
      if (!this.s || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const tag = ev.target && ev.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mode = e.dock.dataset.mode;
      const k = ev.key.toLowerCase();
      if (mode === 'play') {
        const map = { h: 'hit', s: 'stand', d: 'double', p: 'split' };
        if (map[k]) { ev.preventDefault(); this.play(map[k]); }
      } else if (mode === 'bet') {
        if (k === 'enter' || k === ' ') { ev.preventDefault(); this.deal(); }
        const n = Number(k);
        if (n >= 1 && n <= TRAY.length) this.addChip(TRAY[n - 1], e.chipTray.children[n - 1]);
        if (k === 'backspace' || k === 'c') this.setBet(0);
      }
    });
  }

  me() { return this.s && this.s.players[this.meId]; }

  betAmount() {
    const me = this.me();
    if (!me) return 0;
    if (this.draft && performance.now() - this.draft.t < 2500) return this.draft.amount;
    return me.bet;
  }

  addChip(v, from) {
    const me = this.me();
    if (!me || this.els.dock.dataset.mode !== 'bet') return;
    const cur = this.betAmount();
    if (cur + v > me.bank) return;
    this.setBet(cur + v, from, v);
  }

  setBet(amount, from = null, denom = null) {
    const me = this.me();
    if (!me || this.s.phase !== 'betting' || me.ready) return;
    amount = Math.max(0, Math.min(me.bank, Math.floor(amount)));
    const prev = this.betAmount();
    if (amount === prev) return;
    this.draft = { amount, t: performance.now() };
    this.act('bet', { amount });
    const seat = this.seatEls.get(this.meId);
    if (seat && amount > prev) {
      const src = from ? from.getBoundingClientRect() : seat._q.plate.getBoundingClientRect();
      const chips = denom ? [denom] : breakdown(amount - prev, 4);
      chips.forEach((d, i) => this.flyChip(src, seat._q.spot.getBoundingClientRect(), d, i * 60));
      setTimeout(() => sfx.chip(), 280);
    } else {
      sfx.sweep();
    }
    this.render(false);
  }

  deal() {
    const me = this.me();
    if (!me || this.els.dock.dataset.mode !== 'bet') return;
    const amt = this.betAmount();
    if (amt < RULES.minBet || amt > me.bank) return;
    if (me.bet !== amt) this.act('bet', { amount: amt });
    this.act('ready');
    sfx.chips(2);
  }

  play(a) {
    const ah = this.activeHand;
    if (!ah || this.pendingAct) return;
    const btn = this.els[a];
    if (btn && btn.disabled) return;
    this.pendingAct = true;
    for (const k of ['hit', 'stand', 'double', 'split']) this.els[k].disabled = true;
    if (a === 'double' || a === 'split') sfx.chips(2); else sfx.click();
    this.act(a, { h: ah.h, n: ah.n });
    // If the host ignored it (e.g. raced with a timeout), unlock after a moment.
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => { this.pendingAct = false; if (this.s) this.renderDock(this.s); }, 1500);
  }

  // ---------- main entry

  update(s) {
    const prev = this.s;
    this.s = s;
    this.deadline = s.rem != null ? performance.now() + s.rem : null;
    this.dur = s.dur;
    this.pendingAct = false;
    clearTimeout(this.pendingTimer);
    const me = s.players[this.meId];
    if (s.phase !== 'betting' || (me && me.ready)) this.draft = null;
    this.render(true, prev);
  }

  render(full, prev = this.s) {
    const s = this.s;
    if (!s) return;
    const before = new Map();
    for (const [id, c] of this.cardEls) before.set(id, c._fly.getBoundingClientRect());
    this.renderDealer(s);
    this.renderSeats(s);
    this.fitSeats();
    this.animateCards(s, before);
    this.renderStatus(s);
    this.renderDock(s);
    this.renderShoe(s);
    if (full) {
      this.renderRace(s);
      this.renderBoard(s);
      this.renderChat(s);
      this.events(prev, s);
      this.first = false;
    }
  }

  // ---------- dealer & cards

  renderDealer(s) {
    const d = s.dealer;
    this.placeCards(this.els.dealerCards, d.cards);
    const t = this.els.dealerTotal;
    if (!d.cards.length) { t.hidden = true; return; }
    const hidden = d.cards.some((c) => !c.c);
    const lab = totalLabel(d.cards, false, !hidden && s.phase !== 'dealer');
    t.hidden = !lab.text;
    t.textContent = lab.text;
    t.className = 'hand-total ' + lab.cls;
  }

  makeCard(card) {
    const c = el('div', 'card down');
    const fly = el('div', 'fly');
    const inner = el('div', 'inner');
    const front = el('div', 'face front');
    const back = el('div', 'face back');
    inner.append(front, back);
    fly.append(inner);
    c.append(fly);
    c._fly = fly;
    c._front = front;
    c._face = null;
    c._new = !this.first;
    if (card.c) this.setFace(c, card.c);
    if (this.first && card.c) c.classList.remove('down');
    this.cardEls.set(card.i, c);
    return c;
  }

  setFace(c, code) {
    c._face = code;
    const r = rankOf(code);
    const su = suitOf(code);
    const court = r === 'J' || r === 'Q' || r === 'K';
    c._front.className = 'face front ' + (su === 'h' || su === 'd' ? 'red' : 'black') + (court ? ' court' : '') + (r === 'A' ? ' ace' : '');
    const ix = `<b>${r}</b><i>${SUIT[su]}</i>`;
    c._front.innerHTML = `<span class="ix tl">${ix}</span><span class="pip">${court ? r : SUIT[su]}</span><span class="ix br">${ix}</span>`;
  }

  placeCards(container, cards) {
    cards.forEach((card, k) => {
      let c = this.cardEls.get(card.i);
      if (!c) c = this.makeCard(card);
      else if (card.c && c._face !== card.c) {
        // Hole card reveal.
        this.setFace(c, card.c);
        // A timer rather than rAF so the flip also happens while the tab is in the background.
        setTimeout(() => c.classList.remove('down'), 30);
        sfx.flip();
      }
      if (container.children[k] !== c) container.insertBefore(c, container.children[k] || null);
    });
  }

  animateCards(s, before) {
    const live = new Set();
    for (const c of s.dealer.cards) live.add(c.i);
    for (const id of s.order) {
      const p = s.players[id];
      if (p) for (const h of p.hands) for (const c of h.cards) live.add(c.i);
    }
    let swept = 0;
    for (const [id, c] of [...this.cardEls]) {
      if (live.has(id)) continue;
      this.cardEls.delete(id);
      this.discard(c, before.get(id), swept++);
    }
    if (swept && !this.first) sfx.sweep();

    const shoe = center(this.els.shoeCard.getBoundingClientRect());
    let k = 0;
    for (const [id, c] of this.cardEls) {
      const home = c.getBoundingClientRect();
      const z = home.width / (c.offsetWidth || home.width || 1) || 1; // seat row may be scaled to fit
      if (c._new) {
        c._new = false;
        const hc = center(home);
        const delay = k++ * 140;
        c._fly.animate([
          { transform: `translate(${(shoe.x - hc.x) / z}px, ${(shoe.y - hc.y) / z}px) rotate(-24deg) scale(0.8)`, opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 },
        ], { duration: 560, delay, easing: 'cubic-bezier(.18,.75,.25,1)', fill: 'backwards' });
        setTimeout(() => sfx.card(), delay + 40);
        if (c._face) setTimeout(() => c.classList.remove('down'), delay + 300);
      } else if (c._home && (Math.abs(c._home.x - home.left) > 0.5 || Math.abs(c._home.y - home.top) > 0.5)) {
        const b = before.get(id);
        if (b && b.width) {
          for (const a of c._fly.getAnimations()) a.cancel();
          const dx = (b.left - home.left) / z;
          const dy = (b.top - home.top) / z;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            c._fly.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 440, easing: 'cubic-bezier(.2,.75,.2,1)' });
          }
        }
      }
      c._home = { x: home.left, y: home.top };
    }
  }

  discard(c, rect, idx) {
    for (const a of c._fly.getAnimations()) a.cancel();
    c.remove();
    if (!rect || !rect.width || this.first) return;
    const d = center(this.els.discard.getBoundingClientRect());
    Object.assign(c.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', margin: '0' });
    c.style.setProperty('--cw', rect.width + 'px');
    c.style.setProperty('--ch', rect.height + 'px');
    this.els.fx.append(c);
    c.classList.add('down');
    const from = center(rect);
    const dx = d.x - from.x;
    const dy = d.y - from.y;
    const r = (Math.random() - 0.5) * 40;
    const a = c.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${r}deg) scale(0.72)`, opacity: 1, offset: 0.82 },
      { transform: `translate(${dx}px, ${dy}px) rotate(${r}deg) scale(0.68)`, opacity: 0 },
    ], { duration: 700, delay: idx * 40, easing: 'cubic-bezier(.55,0,.3,1)', fill: 'both' });
    a.onfinish = () => c.remove();
    setTimeout(() => c.remove(), 3000);
  }

  // ---------- seats

  // Scale the seat row down (never wrap off the felt) when hands or players outgrow the table.
  fitSeats() {
    const wrap = this.els.seats;
    wrap.style.transform = '';
    const kids = [...wrap.children];
    if (!kids.length) return;
    const cs = getComputedStyle(wrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const wraps = cs.flexWrap === 'wrap';
    const natW = (wraps ? Math.max(...kids.map((k) => k.offsetWidth)) : kids.reduce((a, k) => a + k.offsetWidth, 0) + gap * (kids.length - 1)) + padX;
    const availW = this.els.table.clientWidth;
    const availH = this.els.table.getBoundingClientRect().bottom - this.els.status.getBoundingClientRect().bottom - 4;
    const f = Math.min(1, availW / natW, availH / wrap.offsetHeight);
    if (f < 0.995) wrap.style.transform = `scale(${Math.max(0.4, f).toFixed(3)})`;
  }

  seatOrder(s) {
    const ids = s.order.filter((id) => s.players[id]);
    const k = ids.indexOf(this.meId);
    if (k < 0) return ids;
    const n = ids.length;
    const mid = Math.floor(n / 2);
    return ids.map((_, i) => ids[(k - mid + i + n * 2) % n]);
  }

  makeSeat() {
    const seat = el('div', 'seat');
    seat.innerHTML = `
      <div class="hands"></div>
      <div class="spot"><div class="stack"></div><span class="spot-amt"></span></div>
      <div class="plate">
        <div class="avatar"><span class="av"></span><svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" pathLength="100"/></svg></div>
        <div class="who"><div class="name"></div><div class="bank"></div></div>
        <div class="seat-badges"></div>
      </div>`;
    seat._q = {
      hands: seat.querySelector('.hands'), spot: seat.querySelector('.spot'), stack: seat.querySelector('.stack'),
      amt: seat.querySelector('.spot-amt'), plate: seat.querySelector('.plate'), av: seat.querySelector('.av'),
      ring: seat.querySelector('.avatar svg'), ringC: seat.querySelector('.avatar circle'),
      name: seat.querySelector('.name'), bank: seat.querySelector('.bank'), badges: seat.querySelector('.seat-badges'),
    };
    seat._amt = -1;
    seat._sig = {};
    return seat;
  }

  renderSeats(s) {
    const ids = this.seatOrder(s);
    const wrap = this.els.seats;
    wrap.dataset.n = ids.length;
    for (const [pid, seat] of this.seatEls) {
      if (!ids.includes(pid)) { seat.remove(); this.seatEls.delete(pid); }
    }
    ids.forEach((pid, k) => {
      let seat = this.seatEls.get(pid);
      if (!seat) { seat = this.makeSeat(); this.seatEls.set(pid, seat); }
      if (wrap.children[k] !== seat) wrap.insertBefore(seat, wrap.children[k] || null);
      this.fillSeat(seat, s.players[pid], s, k, ids.length);
    });
  }

  fillSeat(seat, p, s, k, n) {
    const q = seat._q;
    const isMe = p.id === this.meId;
    seat.classList.toggle('me', isMe);
    seat.classList.toggle('offline', !p.connected);
    const mid = (n - 1) / 2;
    const d = mid ? Math.abs(k - mid) / mid : 0;
    seat.style.setProperty('--arc', (d * d).toFixed(3));

    const activeIdx = s.phase === 'playing' ? p.hands.findIndex((h) => !h.done) : -1;
    seat.classList.toggle('acting', activeIdx >= 0);

    while (q.hands.children.length > p.hands.length) q.hands.lastElementChild.remove();
    p.hands.forEach((h, i) => {
      let he = q.hands.children[i];
      if (!he) {
        he = el('div', 'hand', '<div class="hand-meta"><span class="hand-total"></span><span class="hand-bet-tag"></span></div><div class="cards"></div>');
        he._tot = he.querySelector('.hand-total');
        he._tag = he.querySelector('.hand-bet-tag');
        he._cards = he.querySelector('.cards');
        q.hands.append(he);
      }
      this.placeCards(he._cards, h.cards);
      const lab = totalLabel(h.cards, h.split, h.done);
      he._tot.textContent = lab.text;
      he._tot.className = 'hand-total ' + lab.cls;
      he._tot.hidden = !lab.text;
      he._tag.textContent = p.hands.length > 1 || h.doubled ? money(h.bet) + (h.doubled ? ' ×2' : '') : '';
      he.classList.toggle('active', i === activeIdx);
      he.classList.toggle('waiting', activeIdx >= 0 && i > activeIdx);
      const busted = handValue(h.cards).total > 21;
      he.classList.toggle('lost', busted || h.result === 'lose');
      he.classList.toggle('settled', !!h.result);
      let rb = he._result;
      if (h.result) {
        if (!rb || rb.dataset.r !== h.result) {
          if (rb) rb.remove();
          const net = h.payout - h.bet;
          const amt = net > 0 ? `+${money(net)}` : net < 0 ? money(net) : '';
          rb = el('div', 'result ' + h.result, `${RESULT_LABEL[h.result]}${amt ? `<small>${amt}</small>` : ''}`);
          rb.dataset.r = h.result;
          rb.style.animationDelay = (this.first ? 0 : i * 0.12) + 's';
          he.append(rb);
          he._result = rb;
        }
      } else if (rb) { rb.remove(); he._result = null; }
    });

    const amt = s.phase === 'betting' ? (isMe ? this.betAmount() : p.bet) : p.hands.reduce((a, h) => a + h.bet, 0);
    if (seat._amt !== amt) {
      q.stack.innerHTML = breakdown(amt).reverse().map((v, i) => `<div class="chip" data-v="${v}" style="--k:${i}"></div>`).join('');
      q.amt.textContent = amt ? money(amt) : '';
      seat._amt = amt;
    }
    q.spot.classList.toggle('has', amt > 0);
    q.spot.classList.toggle('collect', s.phase === 'settle' && p.hands.length > 0 && p.hands.every((h) => h.result));

    if (seat._sig.av !== p.avatar) { q.av.textContent = p.avatar; seat._sig.av = p.avatar; }
    const nameHTML = esc(p.name) + (isMe ? '<span class="you">you</span>' : '');
    if (seat._sig.name !== nameHTML) { q.name.innerHTML = nameHTML; seat._sig.name = nameHTML; }
    const shown = p.bank - (s.phase === 'betting' ? amt : 0);
    this.tween(q.bank, shown, s.phase === 'settle' ? 750 : 0);

    const badges = [];
    if (p.id === s.host) badges.push('<span class="sb host" title="Hosting the room">HOST</span>');
    if (!p.connected) badges.push('<span class="sb off">away</span>');
    else if (s.phase === 'betting' && p.ready) badges.push('<span class="sb ready" title="Ready">✓</span>');
    if (p.streak >= 2) badges.push(`<span class="sb streak" title="${p.streak} wins in a row">🔥${p.streak}</span>`);
    const bsig = badges.join('');
    if (seat._sig.badges !== bsig) { q.badges.innerHTML = bsig; seat._sig.badges = bsig; }
  }

  tween(node, to, delay = 0) {
    if (node._v === to) return;
    const from = node._shown;
    node._v = to;
    if (from == null || this.first) { node._shown = to; node.textContent = money(to); return; }
    const start = performance.now() + delay;
    const dur = 750;
    const step = (now) => {
      if (node._v !== to) return;
      const t = Math.min(1, Math.max(0, (now - start) / dur));
      const e = 1 - Math.pow(1 - t, 3);
      node._shown = Math.round(from + (to - from) * e);
      node.textContent = money(node._shown);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- status line

  renderStatus(s) {
    const me = s.players[this.meId];
    const seated = s.order.map((id) => s.players[id]).filter((p) => p && p.connected);
    const parts = s.order.map((id) => s.players[id]).filter((p) => p && p.hands.length);
    let main = '';
    let sub = '';
    switch (s.phase) {
      case 'betting': {
        const ready = seated.filter((p) => p.ready).length;
        const eligible = seated.filter((p) => p.bank >= RULES.minBet).length;
        if (ready && ready === eligible) main = 'Here we go…';
        else if (s.rem != null) { main = 'Dealing soon'; sub = `${ready}/${eligible} ready`; }
        else { main = 'Place your bets'; sub = seated.length > 1 ? `${ready}/${eligible} ready · min $10` : 'Min $10 · Blackjack pays 3 to 2'; }
        break;
      }
      case 'shuffling': main = 'Shuffling a fresh shoe'; sub = '6 decks · 312 cards'; break;
      case 'dealing': main = 'Dealing'; break;
      case 'playing': {
        const acting = parts.filter((p) => p.hands.some((h) => !h.done));
        const mine = me && me.hands.find((h) => !h.done);
        if (mine) {
          const up = s.dealer.cards[0] && s.dealer.cards[0].c ? handValue([s.dealer.cards[0]]).total : '?';
          main = 'Your move';
          sub = `${totalLabel(mine.cards, mine.split, false).text} vs dealer ${up}`;
        } else if (acting.length) {
          const names = acting.slice(0, 2).map((p) => esc(p.name)).join(' & ') + (acting.length > 2 ? ` +${acting.length - 2}` : '');
          main = `Waiting on ${names}`;
        }
        break;
      }
      case 'dealer': main = "Dealer's turn"; sub = 'Dealer stands on all 17s'; break;
      case 'settle': {
        const dv = handValue(s.dealer.cards).total;
        sub = isBlackjack(s.dealer.cards) ? 'Dealer has blackjack' : dv > 21 ? `Dealer busts with ${dv}` : `Dealer has ${dv}`;
        if (me && me.hands.length) {
          const net = me.hands.reduce((a, h) => a + h.payout - h.bet, 0);
          const bj = me.hands.some((h) => h.result === 'blackjack');
          main = net > 0 ? `${bj ? 'Blackjack!' : 'You win'} <span class="pos">+${money(net)}</span>`
            : net < 0 ? `You lose <span class="neg">${money(net)}</span>` : me.hands.every((h) => h.result === 'push') ? 'Push — money back' : 'Broke even';
        } else main = 'Round over';
        break;
      }
      case 'gameover':
        main = s.winner ? `${s.winner.id === this.meId ? 'You win' : esc(s.winner.name) + ' wins'} the match` : 'Match over';
        sub = 'Start a new match when you’re ready';
        break;
    }
    const m = this.els.statusMain;
    if (m._html !== main) {
      m._html = main;
      m.innerHTML = main;
      m.classList.remove('pop');
      void m.offsetWidth;
      if (main) m.classList.add('pop');
    }
    this.subBase = sub;
    this.lastSecond = null;
    this.els.statusSub.innerHTML = sub;
  }

  // ---------- dock

  renderDock(s) {
    const e = this.els;
    const me = s.players[this.meId];
    let mode = 'wait';
    let msg = '';
    this.activeHand = null;
    if (!me) msg = 'Taking your seat…';
    else if (s.phase === 'gameover') mode = 'over';
    else if (s.phase === 'betting') mode = me.ready ? 'ready' : me.bank < RULES.minBet ? 'broke' : 'bet';
    else {
      const idx = s.phase === 'playing' ? me.hands.findIndex((h) => !h.done) : -1;
      if (idx >= 0) {
        mode = 'play';
        const h = me.hands[idx];
        this.activeHand = { h: idx, n: h.cards.length };
        const lock = this.pendingAct;
        e.hit.disabled = lock;
        e.stand.disabled = lock;
        e.double.disabled = lock || !canDouble(h, me.bank);
        e.split.disabled = lock || !canSplit(h, me.bank, me.hands.length);
      } else if (!me.hands.length && me.bank < RULES.minBet) mode = 'broke';
      else if (!me.hands.length) msg = 'Sitting this one out — you’re in next hand';
      else msg = {
        shuffling: 'Shuffling…', dealing: 'Dealing…', playing: 'Waiting for the others…',
        dealer: 'Dealer is drawing…', settle: 'Next hand in a moment…',
      }[s.phase] || '';
    }
    if (e.dock.dataset.mode !== mode) e.dock.dataset.mode = mode;
    if (msg) e.waitMsg.textContent = msg;

    if (me) {
      const amt = s.phase === 'betting' && !me.ready ? this.betAmount() : s.phase === 'betting' ? me.bet : 0;
      this.tween(e.dockBank, me.bank - amt, s.phase === 'settle' ? 750 : 0);
      if (mode === 'bet') {
        for (const b of e.chipTray.children) b.disabled = amt + Number(b.dataset.v) > me.bank;
        e.dealBtn.disabled = amt < RULES.minBet;
        e.dealAmt.textContent = amt ? money(amt) : '';
        e.betClear.disabled = amt === 0;
        e.betDouble.disabled = amt === 0 || amt * 2 > me.bank;
        e.betMax.disabled = amt === me.bank;
      }
      if (mode === 'ready') e.readyAmt.textContent = money(me.bet);
      e.resetBtn.disabled = s.phase === 'gameover' || (ACTIVE.has(s.phase) && me.hands.length > 0);
    }
  }

  renderShoe(s) {
    const f = s.shoeTotal ? s.shoeLeft / s.shoeTotal : 1;
    this.els.shoeMeter.style.width = (f * 100).toFixed(1) + '%';
  }

  // ---------- race & standings

  renderRace(s) {
    const players = s.order.map((id) => s.players[id]).filter(Boolean);
    const wrap = this.els.raceTokens;
    for (const [pid, t] of this.tokenEls) if (!players.find((p) => p.id === pid)) { t.remove(); this.tokenEls.delete(pid); }
    const width = this.els.raceTrack.clientWidth || 600;
    const minGap = 30 / width;
    const placed = players.map((p) => ({ p, x: Math.max(0, Math.min(1, worth(p) / RULES.goal)) })).sort((a, b) => a.x - b.x);
    const lanes = [];
    let lead = 0;
    for (const t of placed) {
      let lane = lanes.findIndex((lx) => t.x - lx >= minGap);
      if (lane < 0) lane = lanes.length < 3 ? lanes.length : 0;
      lanes[lane] = t.x;
      t.lane = lane;
      lead = Math.max(lead, t.x);
    }
    for (const t of placed) {
      let tok = this.tokenEls.get(t.p.id);
      if (!tok) {
        tok = el('div', 'token', '<div class="token-face"></div><div class="token-tip"></div>');
        this.tokenEls.set(t.p.id, tok);
        wrap.append(tok);
      }
      tok.style.setProperty('--x', t.x.toFixed(4));
      tok.style.setProperty('--lane', t.lane);
      tok.classList.toggle('me', t.p.id === this.meId);
      tok.classList.toggle('leader', placed.length > 1 && lead > 0 && t.x === lead && placed.filter((o) => o.x === lead).length === 1);
      tok.firstChild.textContent = t.p.avatar;
      tok.lastChild.innerHTML = `${esc(t.p.name)}<b>${money(worth(t.p))}</b>`;
    }
    this.els.raceFill.style.width = (lead * 100).toFixed(2) + '%';
  }

  renderBoard(s) {
    const players = s.order.map((id) => s.players[id]).filter(Boolean).sort((a, b) => worth(b) - worth(a));
    const ol = this.els.board;
    for (const [pid, li] of this.rowEls) if (!players.find((p) => p.id === pid)) { li.remove(); this.rowEls.delete(pid); }
    players.forEach((p, i) => {
      let li = this.rowEls.get(p.id);
      if (!li) {
        li = el('li', '', '<span class="rank"></span><span class="av"></span><span class="nm"><b></b><small></small></span><span class="amt"></span><span class="bar"><i></i></span>');
        this.rowEls.set(p.id, li);
      }
      if (ol.children[i] !== li) ol.insertBefore(li, ol.children[i] || null);
      li.classList.toggle('me', p.id === this.meId);
      li.classList.toggle('off', !p.connected);
      li.children[0].textContent = i + 1;
      li.children[1].textContent = p.avatar;
      li.children[2].firstChild.textContent = p.name + (p.id === this.meId ? ' (you)' : '');
      const meta = [];
      if (p.streak >= 2) meta.push(`🔥 ${p.streak} streak`);
      meta.push(`${p.wins}W / ${p.played}`);
      if (p.resets) meta.push(`↺ ${p.resets}`);
      if (p.best > 0) meta.push(`best +${money(p.best)}`);
      li.children[2].lastChild.textContent = meta.join(' · ');
      li.children[3].textContent = money(worth(p));
      li.children[4].firstChild.style.width = Math.min(100, (worth(p) / RULES.goal) * 100).toFixed(1) + '%';
    });
  }

  renderChat(s) {
    const box = this.els.chat;
    const fresh = s.chat.filter((m) => m.id > this.seenChat);
    if (!fresh.length) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const empty = box.querySelector('.chat-empty');
    if (empty) empty.remove();
    for (const m of fresh) {
      this.seenChat = m.id;
      const row = el('div', 'msg' + (m.pid === this.meId ? ' me' : ''), `<span class="av">${esc(m.avatar)}</span><p><b>${esc(m.name)}</b>${esc(m.text)}</p>`);
      box.append(row);
      if (!this.first && m.pid !== this.meId) {
        sfx.message();
        if (getComputedStyle(this.els.side).position === 'fixed' && !this.els.side.classList.contains('open')) {
          this.els.chatBadge.hidden = false;
          this.toast(`${m.name}: ${m.text}`, 'chat');
        }
      }
    }
    while (box.children.length > 60) box.firstChild.remove();
    if (nearBottom || this.first) box.scrollTop = box.scrollHeight;
  }

  // ---------- events (diff prev → next)

  events(prev, s) {
    if (!prev || this.first) {
      for (const f of s.feed) this.seenFeed = Math.max(this.seenFeed, f.id);
      if (s.phase === 'gameover') this.showVictory(s, false);
      return;
    }
    for (const f of s.feed) {
      if (f.id <= this.seenFeed) continue;
      this.seenFeed = f.id;
      if ((f.kind === 'join' || f.kind === 'leave' || f.kind === 'reset') && f.pid === this.meId) continue;
      this.toast(f.text, f.kind);
    }
    if (s.phase === 'betting' && prev.phase === 'betting') {
      for (const id of s.order) {
        if (id === this.meId) continue;
        const p = s.players[id];
        const q = prev.players[id];
        const seat = this.seatEls.get(id);
        if (!p || !q || !seat) continue;
        if (p.bet > q.bet) {
          const chips = breakdown(p.bet - q.bet, 3);
          chips.forEach((d, i) => this.flyChip(seat._q.plate.getBoundingClientRect(), seat._q.spot.getBoundingClientRect(), d, i * 60, 26));
          setTimeout(() => sfx.chip(), 250);
        }
        if (p.ready && !q.ready) sfx.tick();
      }
    }
    const me = s.players[this.meId];
    const pm = prev.players[this.meId];
    if (me && pm) {
      if (me.resets > pm.resets) {
        const seat = this.seatEls.get(this.meId);
        if (seat) {
          const d = this.els.dealerTray.getBoundingClientRect();
          breakdown(1000, 5).forEach((v, i) => this.flyChip(d, seat._q.plate.getBoundingClientRect(), v, i * 70));
        }
      }
      // my hand just busted
      const bustNow = me.hands.filter((h) => handValue(h.cards).total > 21).length;
      const bustBefore = pm.hands.filter((h) => handValue(h.cards).total > 21).length;
      if (s.phase === 'playing' && bustNow > bustBefore) sfx.lose();
    }
    if (s.phase !== prev.phase) {
      if (s.phase === 'shuffling') {
        this.els.shoe.classList.add('shuffling');
        sfx.shuffle();
        setTimeout(() => this.els.shoe.classList.remove('shuffling'), 1900);
      }
      if (s.phase === 'playing' && me && me.hands.some((h) => !h.done)) sfx.turn();
      if (s.phase === 'settle') this.settleFx(s);
      if (s.phase === 'gameover') this.showVictory(s, true);
      if (prev.phase === 'gameover') this.els.victory.hidden = true;
    }
  }

  settleFx(s) {
    const dealer = this.els.dealerTray.getBoundingClientRect();
    let myNet = null;
    let myBJ = false;
    for (const id of s.order) {
      const p = s.players[id];
      const seat = this.seatEls.get(id);
      if (!p || !p.hands.length || !seat) continue;
      const spot = seat._q.spot.getBoundingClientRect();
      const plate = seat._q.plate.getBoundingClientRect();
      const staked = p.hands.reduce((a, h) => a + h.bet, 0);
      const paid = p.hands.reduce((a, h) => a + h.payout, 0);
      const net = paid - staked;
      if (net > 0) {
        this.flyChips(dealer, spot, net, 0);
        this.flyChips(spot, plate, paid, 750);
        setTimeout(() => { seat._q.plate.classList.remove('bump'); void seat._q.plate.offsetWidth; seat._q.plate.classList.add('bump'); }, 1350);
      } else if (paid > 0) {
        this.flyChips(spot, plate, paid, 250);
        if (net < 0) this.flyChips(spot, dealer, -net, 150);
      } else {
        this.flyChips(spot, dealer, staked, 150);
      }
      this.floatText(plate, net);
      const bj = p.hands.some((h) => h.result === 'blackjack');
      if (bj) {
        const c = center(seat.getBoundingClientRect());
        confetti({ x: c.x / innerWidth, y: c.y / innerHeight, count: id === this.meId ? 110 : 40, power: id === this.meId ? 1 : 0.7 });
      }
      if (id === this.meId) { myNet = net; myBJ = bj; }
    }
    if (myNet == null) sfx.chips(3);
    else if (myBJ) sfx.bj();
    else if (myNet > 0) sfx.win();
    else if (myNet < 0) sfx.lose();
    else sfx.push();
  }

  // ---------- flying things

  flyChip(fromRect, toRect, denom, delay = 0, size = 34) {
    const a = center(fromRect);
    const b = center(toRect);
    const c = el('div', 'chip fchip');
    c.dataset.v = denom;
    Object.assign(c.style, { left: a.x - size / 2 + 'px', top: a.y - size / 2 + 'px', width: size + 'px', height: size + 'px' });
    this.els.fx.append(c);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lift = Math.min(90, Math.hypot(dx, dy) * 0.25);
    const anim = c.animate([
      { transform: 'translate(0,0) scale(0.9)', opacity: 0 },
      { transform: `translate(${dx * 0.15}px, ${dy * 0.15 - lift * 0.5}px) scale(1.05)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - lift}px) scale(1.08)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.92)`, opacity: 1, offset: 0.92 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.85)`, opacity: 0 },
    ], { duration: 640, delay, easing: 'cubic-bezier(.35,.6,.3,1)', fill: 'both' });
    anim.onfinish = () => c.remove();
    setTimeout(() => c.remove(), delay + 1500);
  }

  flyChips(from, to, amount, delay) {
    const chips = breakdown(amount, 5);
    chips.forEach((d, i) => this.flyChip(from, to, d, delay + i * 70));
    setTimeout(() => sfx.chips(Math.min(3, chips.length)), delay + 450);
  }

  floatText(rect, net) {
    const c = center(rect);
    const t = el('div', 'float-net ' + (net > 0 ? 'pos' : net < 0 ? 'neg' : ''), net > 0 ? '+' + money(net) : net < 0 ? money(net) : 'push');
    Object.assign(t.style, { left: c.x + 'px', top: rect.top - 6 + 'px', animationDelay: '0.5s', opacity: 0 });
    t.style.animationFillMode = 'both';
    this.els.fx.append(t);
    setTimeout(() => t.remove(), 2700);
  }

  fx(fx) {
    if (!fx || fx.k !== 'react') return;
    const seat = this.seatEls.get(fx.pid);
    if (!seat) return;
    const r = seat._q.plate.getBoundingClientRect();
    const e = el('div', 'float-emoji', esc(fx.e));
    Object.assign(e.style, { left: r.left + 24 + Math.random() * (r.width - 48) + 'px', top: r.top - 10 + 'px' });
    e.style.setProperty('--dx', (Math.random() - 0.5) * 60 + 'px');
    this.els.fx.append(e);
    setTimeout(() => e.remove(), 2400);
    sfx.pop();
  }

  // ---------- game over

  showVictory(s, celebrate) {
    const e = this.els;
    const w = s.winner;
    if (!w) return;
    const mine = w.id === this.meId;
    e.vAvatar.textContent = w.avatar || '🏆';
    e.vTitle.innerHTML = mine ? 'You <em>take the table</em>' : `${esc(w.name)} <em>takes the table</em>`;
    e.vSub.textContent = `First to $10,000 — finished with ${money(w.bank)}.`;
    const rows = s.order.map((id) => s.players[id]).filter(Boolean).sort((a, b) => b.bank - a.bank);
    e.vBoard.innerHTML = rows.map((p, i) => `<li><span>${i === 0 ? '🏆' : i + 1}</span><span>${esc(p.avatar)} ${esc(p.name)}</span><b>${money(p.bank)}</b></li>`).join('');
    e.victory.hidden = false;
    if (celebrate) {
      sfx.victory();
      confetti({ x: 0.5, y: 0.35, count: 180, power: 1.2 });
      setTimeout(() => confetti({ x: 0.2, y: 0.5, count: 90 }), 400);
      setTimeout(() => confetti({ x: 0.8, y: 0.5, count: 90 }), 700);
    }
  }

  // ---------- timers (per frame)

  loop() {
    requestAnimationFrame(this.loop);
    const s = this.s;
    if (!s) return;
    const rem = this.deadline != null ? Math.max(0, this.deadline - performance.now()) : null;
    const showRing = rem != null && this.dur;
    const ring = this.els.ring;
    if (ring.hidden === !!showRing) ring.hidden = !showRing;
    if (showRing) {
      const frac = rem / this.dur;
      this.els.ringProg.style.strokeDashoffset = (100 * (1 - frac)).toFixed(2);
      ring.classList.toggle('urgent', rem < 5000);
      const sec = Math.ceil(rem / 1000);
      if (sec !== this.lastSecond) {
        this.lastSecond = sec;
        const label = s.phase === 'betting' ? `Dealing in ${sec}s` : `${sec}s left`;
        this.els.statusSub.innerHTML = this.subBase ? `${this.subBase} · ${label}` : label;
        const me = s.players[this.meId];
        const mineAtStake = me && ((s.phase === 'playing' && me.hands.some((h) => !h.done)) || (s.phase === 'betting' && !me.ready && me.bank >= RULES.minBet));
        if (sec <= 5 && sec > 0 && mineAtStake) sfx.tick();
      }
      for (const [, seat] of this.seatEls) {
        if (!seat.classList.contains('acting')) continue;
        seat._q.ringC.style.strokeDashoffset = (100 * (1 - frac)).toFixed(2);
        seat._q.ring.classList.toggle('urgent', rem < 5000);
      }
    }
  }
}
