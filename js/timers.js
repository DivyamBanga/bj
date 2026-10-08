// Game-clock timers that keep their pace when the host's tab is in the background
// (main-thread timers in hidden tabs are clamped to ~1s; timers inside a worker are not).
// Falls back to plain setTimeout outside the browser (Node tests).

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    const src = 'const t=new Map();onmessage=(e)=>{const d=e.data;if(d.c){clearTimeout(t.get(d.id));t.delete(d.id);return;}'
      + 't.set(d.id,setTimeout(()=>{t.delete(d.id);postMessage(d.id);},d.ms));};';
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    worker.onmessage = (e) => {
      const fn = pending.get(e.data);
      pending.delete(e.data);
      if (fn) fn();
    };
    worker.onerror = () => { worker = false; };
  } catch {
    worker = false;
  }
  return worker;
}

// Returns a handle with cancel().
export function later(fn, ms) {
  const w = typeof Worker !== 'undefined' && typeof document !== 'undefined' ? getWorker() : false;
  if (!w) {
    const h = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(h) };
  }
  const id = ++seq;
  pending.set(id, fn);
  w.postMessage({ id, ms });
  return { cancel: () => { if (pending.delete(id)) w.postMessage({ id, c: 1 }); } };
}

// Repeating version of later(); returns a handle with cancel().
export function every(fn, ms) {
  let h = null;
  let live = true;
  const tick = () => { if (!live) return; h = later(tick, ms); fn(); };
  h = later(tick, ms);
  return { cancel: () => { live = false; if (h) h.cancel(); } };
}
