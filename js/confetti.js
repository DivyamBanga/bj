// Lightweight canvas confetti.

const COLORS = ['#e3c27a', '#f6efdc', '#c8463b', '#2f8f6b', '#f2d28b', '#ffffff'];
let canvas = null;
let cx = null;
let parts = [];
let running = false;

function setup() {
  canvas = document.getElementById('confetti');
  cx = canvas.getContext('2d');
  const fit = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  addEventListener('resize', fit);
}

export function confetti({ x = 0.5, y = 0.45, count = 120, power = 1, spread = Math.PI * 2 } = {}) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!canvas) setup();
  const ox = x * innerWidth;
  const oy = y * innerHeight;
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * spread;
    const v = (6 + Math.random() * 9) * power;
    parts.push({
      x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      w: 5 + Math.random() * 6, h: 8 + Math.random() * 8,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      c: COLORS[(Math.random() * COLORS.length) | 0], life: 0, max: 140 + Math.random() * 80,
    });
  }
  if (!running) { running = true; requestAnimationFrame(step); }
}

function step() {
  cx.clearRect(0, 0, innerWidth, innerHeight);
  parts = parts.filter((p) => p.life < p.max && p.y < innerHeight + 40);
  for (const p of parts) {
    p.life++;
    p.vx *= 0.985;
    p.vy = p.vy * 0.985 + 0.28;
    p.x += p.vx;
    p.y += p.vy;
    p.r += p.vr;
    const fade = Math.min(1, (p.max - p.life) / 30);
    cx.save();
    cx.globalAlpha = fade;
    cx.translate(p.x, p.y);
    cx.rotate(p.r);
    cx.scale(1, Math.cos(p.life * 0.12 + p.r));
    cx.fillStyle = p.c;
    cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    cx.restore();
  }
  if (parts.length) requestAnimationFrame(step);
  else { running = false; cx.clearRect(0, 0, innerWidth, innerHeight); }
}
