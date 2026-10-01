// Tiny synthesized sound kit (WebAudio) — no audio files to load.

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem('tg_muted') === '1'; } catch {}

export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
}

export const isMuted = () => muted;
export function setMuted(v) {
  muted = v;
  try { localStorage.setItem('tg_muted', v ? '1' : '0'); } catch {}
}

const live = () => ctx && !muted && ctx.state === 'running';

function tone(freq, { type = 'sine', dur = 0.15, gain = 0.15, when = 0, attack = 0.004, slide = 0 } = {}) {
  if (!live()) return;
  const t = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ dur = 0.08, gain = 0.3, freq = 3000, q = 0.8, when = 0, type = 'bandpass' } = {}) {
  if (!live()) return;
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random() * 0.3);
  src.stop(t + dur + 0.05);
}

export const sfx = {
  card() { noise({ dur: 0.09, freq: 2200 + Math.random() * 900, q: 0.6, gain: 0.32 }); noise({ dur: 0.03, freq: 5200, q: 1.2, gain: 0.12, when: 0.05 }); },
  flip() { noise({ dur: 0.05, freq: 3800, q: 1, gain: 0.18 }); },
  chip() {
    const f = 2600 + Math.random() * 500;
    tone(f, { type: 'triangle', dur: 0.06, gain: 0.09 });
    tone(f * 1.48, { dur: 0.05, gain: 0.05, when: 0.03 });
    noise({ dur: 0.03, freq: 6000, q: 2, gain: 0.08 });
  },
  chips(n = 3) { for (let i = 0; i < n; i++) setTimeout(() => sfx.chip(), i * 55); },
  tick() { tone(1800, { type: 'square', dur: 0.018, gain: 0.025 }); },
  click() { tone(900, { type: 'triangle', dur: 0.04, gain: 0.05 }); },
  turn() { tone(880, { dur: 0.12, gain: 0.08 }); tone(1318.5, { dur: 0.18, gain: 0.07, when: 0.1 }); },
  win() { [523.25, 659.25, 783.99].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.28, gain: 0.11, when: i * 0.08 })); },
  bj() {
    [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, { type: 'triangle', dur: 0.4, gain: 0.1, when: i * 0.07 }));
    for (let i = 0; i < 6; i++) tone(2000 + Math.random() * 2000, { dur: 0.08, gain: 0.03, when: 0.35 + i * 0.05 });
  },
  push() { tone(440, { type: 'triangle', dur: 0.16, gain: 0.06 }); tone(440, { type: 'triangle', dur: 0.16, gain: 0.05, when: 0.14 }); },
  lose() { tone(196, { dur: 0.4, gain: 0.09, slide: -50 }); tone(147, { dur: 0.45, gain: 0.06, when: 0.12, slide: -30 }); },
  shuffle() { for (let i = 0; i < 16; i++) noise({ dur: 0.035, freq: 2600 + Math.random() * 1600, q: 0.9, gain: 0.16, when: i * 0.055 + Math.random() * 0.02 }); },
  sweep() { noise({ dur: 0.32, freq: 1600, q: 0.4, gain: 0.14 }); },
  pop() { tone(520, { dur: 0.09, gain: 0.06, slide: 500 }); },
  message() { tone(1046.5, { dur: 0.08, gain: 0.04 }); tone(1568, { dur: 0.1, gain: 0.03, when: 0.06 }); },
  victory() {
    const seq = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
    seq.forEach((f, i) => tone(f, { type: 'triangle', dur: 0.32, gain: 0.11, when: i * 0.11 }));
    tone(261.63, { type: 'sine', dur: 1.2, gain: 0.08, when: 0.66 });
  },
};
