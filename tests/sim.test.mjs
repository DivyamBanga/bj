// Node test: rules unit tests + a fast multi-bot simulation of the host state machine.
// Run: node tests/sim.test.mjs
import assert from 'node:assert/strict';
import { RULES, buildShoe, handValue, isBlackjack, settleHand, canSplit, canDouble } from '../js/engine.js';
import { HostGame } from '../js/host.js';

const C = (...cs) => cs.map((c, i) => ({ i, c }));
let passed = 0;
const test = (name, fn) => { fn(); passed++; };

// ---------- engine
test('shoe has 312 unique-by-count cards', () => {
  const shoe = buildShoe();
  assert.equal(shoe.length, 312);
  const counts = {};
  for (const c of shoe) counts[c] = (counts[c] || 0) + 1;
  assert.equal(Object.keys(counts).length, 52);
  assert.ok(Object.values(counts).every((n) => n === 6));
});
test('hand values', () => {
  assert.deepEqual(handValue(['As', 'Kd']), { total: 21, soft: true });
  assert.deepEqual(handValue(['As', 'Ad']), { total: 12, soft: true });
  assert.deepEqual(handValue(['As', 'Ad', '9c']), { total: 21, soft: true });
  assert.deepEqual(handValue(['As', 'Ad', '9c', 'Kh']), { total: 21, soft: false });
  assert.deepEqual(handValue(['10s', '6d', '9c']), { total: 25, soft: false });
  assert.deepEqual(handValue([{ i: 1, c: 'Qs' }, { i: 2, c: null }]), { total: 10, soft: false });
});
test('blackjack detection', () => {
  assert.ok(isBlackjack(C('As', 'Jd')));
  assert.ok(!isBlackjack(C('As', 'Jd'), true));
  assert.ok(!isBlackjack(C('7s', '7d', '7c')));
});
test('settlement', () => {
  const H = (cards, bet = 100, split = false) => ({ cards: C(...cards), bet, split });
  assert.deepEqual(settleHand(H(['As', 'Kd']), C('9s', '9d')), { result: 'blackjack', payout: 250 });
  assert.deepEqual(settleHand(H(['As', 'Kd'], 25), C('9s', '9d')), { result: 'blackjack', payout: 63 });
  assert.deepEqual(settleHand(H(['As', 'Kd']), C('Ac', 'Qd')), { result: 'push', payout: 100 });
  assert.deepEqual(settleHand(H(['10s', 'Kd']), C('Ac', 'Qd')), { result: 'lose', payout: 0 });
  assert.deepEqual(settleHand(H(['As', 'Kd'], 100, true), C('9s', '9d')), { result: 'win', payout: 200 });
  assert.deepEqual(settleHand(H(['10s', '5d', '9c']), C('9s', '9d')), { result: 'bust', payout: 0 });
  assert.deepEqual(settleHand(H(['10s', '5d']), C('9s', '7d', '8c')), { result: 'win', payout: 200 });
  assert.deepEqual(settleHand(H(['10s', '8d']), C('9s', '9d')), { result: 'push', payout: 100 });
  assert.deepEqual(settleHand(H(['10s', '7d']), C('9s', '9d')), { result: 'lose', payout: 0 });
  assert.deepEqual(settleHand(H(['10s', '5d', '9c']), C('9s', '7d', '8c')), { result: 'bust', payout: 0 });
});
test('split/double eligibility', () => {
  const hand = { cards: C('8s', '8d'), bet: 100, done: false };
  assert.ok(canSplit(hand, 100, 1));
  assert.ok(!canSplit(hand, 99, 1));
  assert.ok(!canSplit(hand, 100, RULES.maxHands));
  assert.ok(canSplit({ ...hand, cards: C('Ks', '10d') }, 100, 1));
  assert.ok(!canSplit({ ...hand, cards: C('Ks', '9d') }, 100, 1));
  assert.ok(canDouble(hand, 100));
  assert.ok(!canDouble({ ...hand, cards: C('2s', '3d', '4c') }, 1000));
});

// ---------- host simulation
// Windows timers have ~15ms granularity; run 0ms timers on the immediate queue so the sim is fast.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms, ...a) => (ms > 0 ? realSetTimeout(fn, ms, ...a) : { imm: setImmediate(fn, ...a) });
globalThis.clearTimeout = (h) => (h && h.imm ? clearImmediate(h.imm) : realClearTimeout(h));

const FAST = {
  peek: 0, dealerStart: 0, deal: 0, reveal: 0, dealerDraw: 0, settleHold: 0, betCountdown: 5, turnTime: 50,
  allReady: 0, shuffle: 0, dropGrace: 5, gameoverDelay: 0,
};
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

async function simulate({ players = 4, rounds = 400, seed = 1 }) {
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  let last = null;
  let fxCount = 0;
  let lastRound = 0;
  let settledRounds = 0;
  // Verify every settlement as it is broadcast (the settle phase can be shorter than one poll tick).
  let banksAtBetting = {};
  const onState = (pub) => {
    last = pub;
    if (pub.phase === 'betting') banksAtBetting = Object.fromEntries(Object.values(pub.players).map((p) => [p.id, p.bank]));
    if (pub.dealer.cards[1] && pub.dealer.hole) assert.equal(pub.dealer.cards[1].c, null, 'hole card leaked');
    if (pub.phase !== 'settle' || pub.round === lastRound) return;
    lastRound = pub.round;
    settledRounds++;
    const parts = pub.order.map((id) => pub.players[id]).filter((p) => p.hands.length);
    for (const p of parts) {
      for (const h of p.hands) {
        const exp = settleHand(h, pub.dealer.cards);
        assert.equal(h.result, exp.result);
        assert.equal(h.payout, exp.payout);
        assert.ok(h.cards.length >= 2);
      }
      // chip conservation: bank = bank before the round - all stakes + all payouts
      const staked = p.hands.reduce((a, h) => a + h.bet, 0);
      const paid = p.hands.reduce((a, h) => a + h.payout, 0);
      assert.equal(p.bank, banksAtBetting[p.id] - staked + paid, 'chips not conserved for ' + p.id);
    }
    const all = [...pub.dealer.cards, ...parts.flatMap((p) => p.hands.flatMap((h) => h.cards))];
    assert.equal(new Set(all.map((c) => c.i)).size, all.length, 'duplicate card id in one round');
    assert.ok(all.every((c) => typeof c.c === 'string'), 'unrevealed card at settle');
    const dv = handValue(pub.dealer.cards).total;
    const anyLive = parts.some((p) => p.hands.some((h) => handValue(h.cards).total <= 21 && !isBlackjack(h.cards, h.split)));
    if (anyLive && !isBlackjack(pub.dealer.cards)) assert.ok(dv >= 17, 'dealer stopped below 17');
    if (!anyLive) assert.equal(pub.dealer.cards.length, 2, 'dealer drew with no live hands');
  };
  const g = new HostGame({ code: 'TEST', hostPid: 'p0', onState, onFx: () => fxCount++, timing: FAST });
  const ids = Array.from({ length: players }, (_, i) => 'p' + i);
  for (const id of ids) assert.ok(g.join(id, 'Bot ' + id, '🤖'));
  assert.equal(g.join('extra1', 'x', 'x') && g.join('extra2', 'x', 'x') && g.join('extra3', 'x', 'x'), players <= 3);

  const t0 = Date.now();
  let gameovers = 0;
  while (settledRounds < rounds && Date.now() - t0 < 60000) {
    await tick(0);
    const s = g.s;
    // money invariant: banks + in-play stakes never negative
    for (const p of Object.values(s.players)) {
      assert.ok(p.bank >= 0, 'bank negative');
      assert.ok(Number.isInteger(p.bank), 'bank not integer');
    }

    if (s.phase === 'betting') {
      for (const id of ids) {
        const p = s.players[id];
        if (!p.connected) continue;
        if (p.bank < RULES.minBet) { g.action(id, { a: 'reset' }); continue; }
        if (!p.ready) {
          const amt = Math.max(RULES.minBet, Math.floor(rand() * Math.min(p.bank, 800)));
          g.action(id, { a: 'bet', amount: amt });
          if (rand() < 0.9) g.action(id, { a: 'ready' });
        }
      }
    } else if (s.phase === 'playing') {
      for (const id of ids) {
        const p = s.players[id];
        const idx = p.hands.findIndex((h) => !h.done);
        if (idx < 0) continue;
        const h = p.hands[idx];
        const r = rand();
        const a = r < 0.15 ? 'split' : r < 0.3 ? 'double' : handValue(h.cards).total < 15 ? 'hit' : 'stand';
        g.action(id, { a, h: idx, n: h.cards.length });
        if (rand() < 0.05) g.action(id, { a: 'hit', h: idx, n: h.cards.length }); // stale duplicate: must be ignored
      }
    } else if (s.phase === 'gameover') {
      gameovers++;
      assert.ok(s.winner && s.players[s.winner.id].bank >= RULES.goal);
      g.action(ids[0], { a: 'newMatch' });
      assert.equal(g.s.phase, 'betting');
      assert.ok(Object.values(g.s.players).every((p) => p.bank === RULES.startBank));
    }
    // random disconnect / reconnect churn
    if (rand() < 0.002) { const id = ids[1 + Math.floor(rand() * (players - 1))]; g.leave(id); }
    if (rand() < 0.01) for (const id of ids) if (!g.s.players[id].connected) g.join(id, 'Bot ' + id, '🤖');
  }
  if (settledRounds !== rounds) console.log(JSON.stringify({phase: g.s.phase, timer: !!g.timer, deadline: g.s.deadline, now: Date.now(), order: g.s.order, players: Object.values(g.s.players).map(p => [p.id, p.connected, p.ready, p.bet, p.bank, p.hands.length])}));
  assert.equal(settledRounds, rounds, `stalled: only ${settledRounds} rounds in phase ${g.s.phase}`);
  g.destroy();
  return { gameovers, fxCount };
}

// Money conservation through a restore (host migration) mid-round.
async function migration() {
  let last = null;
  const g = new HostGame({ code: 'M', hostPid: 'a', onState: (s) => { last = s; }, timing: { ...FAST, turnTime: 100000 } });
  g.join('a', 'A', '🦊'); g.join('b', 'B', '🐼');
  g.action('a', { a: 'bet', amount: 300 }); g.action('b', { a: 'bet', amount: 200 });
  g.action('a', { a: 'ready' }); g.action('b', { a: 'ready' });
  for (let i = 0; i < 50 && g.s.phase !== 'playing' && g.s.phase !== 'settle' && g.s.phase !== 'betting'; i++) await tick(1);
  await tick(5);
  const snap = JSON.parse(JSON.stringify(last));
  g.destroy();
  const g2 = new HostGame({ code: 'M', hostPid: 'b', snapshot: snap, onState: () => {}, timing: FAST });
  const banks = Object.values(g2.s.players).map((p) => p.bank).sort();
  if (snap.phase === 'settle' || snap.phase === 'betting') return; // dealer blackjack instantly settled; nothing to refund
  assert.deepEqual(banks, [1000, 1000], 'stakes not refunded on migration: ' + banks + ' phase ' + snap.phase);
  assert.equal(g2.s.phase, 'betting');
  assert.ok(Object.values(g2.s.players).every((p) => !p.connected && p.hands.length === 0));
  assert.ok(g2.join('a', 'A', '🦊'));
  g2.destroy();
}

test('restore ignores junk snapshot', () => {
  const g = new HostGame({ code: 'J', hostPid: 'z', snapshot: { players: 5 }, onState: () => {} });
  assert.equal(g.s.phase, 'betting');
  g.destroy();
});

for (let i = 0; i < 10; i++) await migration();
passed++;
let totalGameovers = 0;
for (let seed = 1; seed <= 6; seed++) {
  const r = await simulate({ players: 1 + (seed % 6), rounds: 500, seed });
  totalGameovers += r.gameovers;
}
passed++;
// Force a game over: one rich player.
{
  let lastState = null;
  const g = new HostGame({ code: 'W', hostPid: 'w', onState: (s) => { lastState = s; }, timing: FAST });
  g.join('w', 'W', '👑');
  g.s.players.w.bank = 9990;
  let rounds = 0;
  while (g.s.phase !== 'gameover' && rounds < 2000) {
    await tick(0);
    const s = g.s;
    if (s.phase === 'betting') {
      const p = s.players.w;
      if (p.bank < 10) { p.bank = 9990; }
      g.action('w', { a: 'bet', amount: Math.min(p.bank, 9000) });
      g.action('w', { a: 'ready' });
    } else if (s.phase === 'playing') {
      const p = s.players.w; const idx = p.hands.findIndex((h) => !h.done);
      if (idx >= 0) g.action('w', { a: 'stand', h: idx, n: p.hands[idx].cards.length });
    } else if (s.phase === 'settle') rounds++;
  }
  assert.equal(g.s.phase, 'gameover');
  assert.equal(lastState.winner.id, 'w');
  g.destroy();
  passed++;
}
console.log(`ok — ${passed} test groups passed; ${totalGameovers} natural game-overs during simulation`);
process.exit(0);
