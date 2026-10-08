# Ten Grand — multiplayer blackjack

Live at **https://divyambanga.github.io/bj/**

Everyone sits down with $1,000. First to $10,000 takes the table.

## Playing

1. Enter a name, pick a token, **Create a room**.
2. Click the room pill in the top bar to copy the invite link and send it to friends (up to 6 per table).
3. Drop chips on your spot and hit **Deal**. Once anyone is ready, a 15s countdown starts; if everyone's ready it deals immediately.
4. Everyone plays their hands at the same time (30s timer). Keys: `H` hit · `S` stand · `D` double · `P` split · `1–5` chips · `Enter` deal.
5. **Reset** (top bar) puts you back to $1,000 any time you're not mid-hand; **Rebuy** appears when you're broke.

House rules: 6-deck shoe (reshuffled at 75%), blackjack pays 3:2, dealer stands on all 17s and peeks for blackjack, double on any two cards (including after a split), split up to 4 hands, split aces get one card each.

## How it works

No backend of our own. Rooms run over public MQTT brokers via secure WebSockets (EMQX, HiveMQ and shiftr.io at once, de-duplicated), so it works on any network — no peer-to-peer connection needed.

- Everything is end-to-end encrypted with a key derived from the room code; the brokers and strangers only see noise. Each player's actions are encrypted to the host with their own key, so nobody can act for someone else.
- One player's browser is the **host** and runs the authoritative game (`js/host.js`). If the host leaves, refreshes or drops, the next player takes over from the last state within a few seconds (a hand in progress is refunded). Every browser also keeps the latest state, so refreshing drops you back into your seat with your bankroll.

| File | Role |
| --- | --- |
| `js/engine.js` | Pure rules: shoe, hand values, payouts |
| `js/host.js` | Authoritative state machine (betting → dealing → playing → dealer → settle) |
| `js/net.js` | Encrypted rooms over MQTT, heartbeats, host election & migration |
| `js/table.js` | Rendering + animations (FLIP-keyed cards, chip flights, reactions) |
| `js/main.js` | Lobby, identity, top bar |

## Tests

```
node tests/sim.test.mjs
```

Rules unit tests plus a multi-bot simulation of thousands of rounds (chip conservation, payout correctness, dealer rules, hidden-card privacy, disconnect churn, host-migration refunds, game over).
