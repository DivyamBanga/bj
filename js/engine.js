// Pure blackjack rules. No DOM, no networking — shared by host and UI, unit-tested in Node.

export const RULES = Object.freeze({
  decks: 6,
  minBet: 10,
  startBank: 1000,
  goal: 10000,
  maxPlayers: 6,
  maxHands: 4,
  reshuffleAt: 0.25, // fresh shoe when less than 25% remains
});

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['s', 'h', 'd', 'c'];

// Unbiased integer in [0, n) using crypto when available.
function randInt(n) {
  const c = globalThis.crypto;
  if (c && c.getRandomValues) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / n) * n;
    let x;
    do { c.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return x % n;
  }
  return Math.floor(Math.random() * n);
}

export function buildShoe(decks = RULES.decks) {
  const cards = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) cards.push(r + s);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export const rankOf = (c) => c.slice(0, -1);
export const suitOf = (c) => c.slice(-1);

export function cardValue(c) {
  const r = rankOf(c);
  if (r === 'A') return 11;
  if (r === 'J' || r === 'Q' || r === 'K' || r === '10') return 10;
  return Number(r);
}

// Accepts card strings or {i, c} objects; hidden cards (c === null) are skipped.
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const x of cards) {
    const c = typeof x === 'string' ? x : x && x.c;
    if (!c) continue;
    const v = cardValue(c);
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

export function isBlackjack(cards, fromSplit = false) {
  return !fromSplit && cards.length === 2 && handValue(cards).total === 21;
}

export function canDouble(hand, bank) {
  return !hand.done && hand.cards.length === 2 && bank >= hand.bet;
}

export function canSplit(hand, bank, handCount) {
  return !hand.done && hand.cards.length === 2 && handCount < RULES.maxHands && bank >= hand.bet &&
    cardValue(hand.cards[0].c) === cardValue(hand.cards[1].c);
}

// Dealer stands on all 17s.
export function dealerShouldHit(cards) {
  return handValue(cards).total < 17;
}

// payout = total returned to the player (stake included).
export function settleHand(hand, dealerCards) {
  const p = handValue(hand.cards).total;
  const d = handValue(dealerCards).total;
  const pBJ = isBlackjack(hand.cards, hand.split);
  const dBJ = isBlackjack(dealerCards);
  if (p > 21) return { result: 'bust', payout: 0 };
  if (pBJ && !dBJ) return { result: 'blackjack', payout: hand.bet + Math.round(hand.bet * 1.5) };
  if (dBJ) return pBJ ? { result: 'push', payout: hand.bet } : { result: 'lose', payout: 0 };
  if (d > 21 || p > d) return { result: 'win', payout: hand.bet * 2 };
  if (p === d) return { result: 'push', payout: hand.bet };
  return { result: 'lose', payout: 0 };
}
