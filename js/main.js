// App shell: lobby, identity, room lifecycle, top-bar controls.

import { Room, makeCode, cleanCode } from './net.js';
import { Table, esc } from './table.js';
import { unlockAudio, sfx, isMuted, setMuted } from './audio.js';

const AVATARS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐺', '🐨', '🐵', '🦉', '🐲', '👽', '🤠', '😎', '🎩'];
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

// ---------- identity: stable per browser, unique per open tab
let pid = null;
async function resolvePid() {
  let candidate = null;
  try { candidate = sessionStorage.getItem('tg_pid'); } catch {}
  candidate = candidate || store.get('tg_pid') || uuid();
  if ('BroadcastChannel' in window) {
    const ch = new BroadcastChannel('tg_pid');
    let current = candidate;
    ch.onmessage = (e) => { if (e.data && e.data.t === 'who' && e.data.pid === current) ch.postMessage({ t: 'mine', pid: current }); };
    const taken = await new Promise((res) => {
      const t = setTimeout(() => res(false), 200);
      const listener = (e) => { if (e.data && e.data.t === 'mine' && e.data.pid === candidate) { clearTimeout(t); res(true); } };
      ch.addEventListener('message', listener);
      ch.postMessage({ t: 'who', pid: candidate });
    });
    if (taken) candidate = uuid();
    current = candidate;
    window.__tgChannel = ch;
  }
  try { sessionStorage.setItem('tg_pid', candidate); } catch {}
  if (!store.get('tg_pid')) store.set('tg_pid', candidate);
  return candidate;
}

// ---------- toasts
const TOAST_ICON = { bj: '✨', big: '💰', streak: '🔥', join: '👋', leave: '🚪', reset: '↺', shuffle: '🔀', win: '🏆', dealer: '🃏', chat: '💬', info: '•', host: '★', copy: '🔗', error: '⚠' };
function toast(text, kind = 'info') {
  const box = $('toasts');
  while (box.children.length >= 4) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  const msg = String(text).length > 90 ? String(text).slice(0, 88) + '…' : String(text);
  t.innerHTML = `<span>${TOAST_ICON[kind] || '•'}</span><span>${esc(msg)}</span>`;
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, kind === 'win' ? 6000 : 3400);
}

// ---------- state
const table = new Table();
let room = null;
let wasReconnecting = false;
let lastRole = null;
let avatar = store.get('tg_avatar') || AVATARS[Math.floor(Math.random() * AVATARS.length)];

const lobby = $('lobby');
const game = $('game');
const nameInput = $('name-input');
const codeInput = $('code-input');
const lobbyError = $('lobby-error');
const params = new URLSearchParams(location.search);
let inviteCode = cleanCode(params.get('room'));

function showLobby(err = '') {
  lobby.hidden = false;
  game.hidden = true;
  lobbyError.textContent = err;
  setBusy(false);
  renderInvite();
}

function renderInvite() {
  $('join-invite').hidden = !inviteCode;
  $('lobby-actions').hidden = !!inviteCode;
  $('invite-code').textContent = inviteCode;
}

function setBusy(on) {
  for (const b of document.querySelectorAll('#lobby-form button[type=submit]')) {
    b.disabled = on;
    b.classList.toggle('loading', on && b === setBusy.active);
  }
}

function setUrl(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function inviteUrl(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

// ---------- lobby wiring
function buildAvatars() {
  const box = $('avatar-picker');
  box.innerHTML = '';
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(a === avatar));
    b.addEventListener('click', () => {
      avatar = a;
      store.set('tg_avatar', a);
      for (const x of box.children) x.setAttribute('aria-checked', String(x.textContent === a));
    });
    box.append(b);
  }
}

$('lobby-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  unlockAudio();
  const mode = (ev.submitter && ev.submitter.dataset.mode) || (inviteCode ? 'join-invite' : 'create');
  const name = nameInput.value.replace(/\s+/g, ' ').trim();
  if (!name) { lobbyError.textContent = 'Pick a name first.'; nameInput.focus(); return; }
  store.set('tg_name', name);
  let code;
  if (mode === 'join-invite') code = inviteCode;
  else if (mode === 'join') {
    code = cleanCode(codeInput.value);
    if (code.length < 4) { lobbyError.textContent = 'Room codes are 4 letters.'; codeInput.focus(); return; }
  }
  setBusy.active = ev.submitter;
  enterRoom(mode === 'create' ? 'create' : 'join', code || makeCode(), name);
});

$('not-invite').addEventListener('click', () => { inviteCode = ''; setUrl(null); renderInvite(); });
codeInput.addEventListener('input', () => { codeInput.value = cleanCode(codeInput.value); });

// ---------- room lifecycle
async function enterRoom(mode, code, name) {
  if (room) room.leave();
  lobbyError.textContent = '';
  setBusy(true);
  if (!pid) pid = await resolvePid();
  const me = { id: pid, name, avatar };
  table.reset();
  table.attach({ meId: pid, act: (a, extra) => room && room.act(a, extra), toast });
  let shown = false;
  const knownRoom = !!store.get('tg_room_' + code);
  lastRole = null;
  wasReconnecting = false;
  const r = new Room({
    code, me,
    onState: (s) => {
      if (r !== room) return;
      if (!shown) {
        shown = true;
        lobby.hidden = true;
        game.hidden = false;
        setBusy(false);
      }
      table.update(s);
    },
    onFx: (fx) => { if (r === room) table.fx(fx); },
    onStatus: (st) => {
      if (r !== room) return;
      if (!shown && mode === 'join' && !knownRoom && st.state === 'online' && st.role === 'host') {
        toast(`Nobody was in room ${st.code} — you're hosting it. Share the invite link!`, 'host');
      }
      onStatus(st, shown);
    },
    onFatal: (msg) => {
      if (r !== room) return;
      room.leave();
      room = null;
      setUrl(null);
      showLobby(msg);
    },
  });
  room = r;
  try {
    if (mode === 'create') await r.create();
    else await r.establish(false);
  } catch (e) {
    if (r !== room) return;
    r.leave();
    room = null;
    showLobby(friendlyError(e));
  }
}

function friendlyError(e) {
  const t = e && e.type;
  if (t === 'browser-incompatible') return 'This browser does not support WebRTC. Try Chrome, Safari or Firefox.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error' || t === 'timeout') return 'Could not reach the matchmaking server. Check your connection and try again.';
  return (e && e.message) || 'Something went wrong. Try again.';
}

function onStatus(st, shown) {
  const dot = $('net-dot');
  const banner = $('net-banner');
  if (st.state === 'online') {
    dot.classList.add('online');
    banner.hidden = true;
    $('room-code').textContent = st.code;
    setUrl(st.code);
    inviteCode = st.code;
    if (wasReconnecting && st.role === 'host' && lastRole !== 'host') toast("You're now hosting this room", 'host');
    else if (wasReconnecting) toast('Reconnected', 'info');
    wasReconnecting = false;
    lastRole = st.role;
  } else {
    dot.classList.remove('online');
    if (shown) {
      wasReconnecting = true;
      banner.hidden = false;
      $('net-banner-text').textContent = st.attempt ? `Reconnecting… (try ${st.attempt + 1})` : 'Connection lost — reconnecting…';
    } else if (st.attempt) {
      lobbyError.textContent = `Still trying to reach the room… (attempt ${st.attempt + 1})`;
    }
  }
}

// ---------- top bar
$('room-pill').addEventListener('click', async () => {
  if (!room) return;
  const url = inviteUrl(room.code);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Ten Grand — blackjack', text: `Join my blackjack table (room ${room.code})`, url }); return; } catch {}
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied — send it to your friends', 'copy');
  } catch {
    const i = document.createElement('input');
    i.value = url;
    document.body.append(i);
    i.select();
    document.execCommand('copy');
    i.remove();
    toast('Invite link copied', 'copy');
  }
});

const resetBtn = $('reset-btn');
let resetTimer = null;
resetBtn.addEventListener('click', () => {
  if (!room) return;
  if (!resetBtn.classList.contains('confirm')) {
    resetBtn.classList.add('confirm');
    resetBtn.querySelector('span').textContent = 'Reset to $1,000?';
    resetBtn.title = 'Click again to confirm';
    clearTimeout(resetTimer);
    resetTimer = setTimeout(clearResetConfirm, 3000);
    return;
  }
  clearResetConfirm();
  sfx.chips(5);
  room.act('reset');
});
function clearResetConfirm() {
  clearTimeout(resetTimer);
  resetBtn.classList.remove('confirm');
  resetBtn.querySelector('span').textContent = 'Reset';
  resetBtn.title = 'Reset your bankroll to $1,000';
}

const soundBtn = $('sound-btn');
soundBtn.classList.toggle('muted', isMuted());
soundBtn.addEventListener('click', () => {
  setMuted(!isMuted());
  soundBtn.classList.toggle('muted', isMuted());
  unlockAudio();
  sfx.click();
});

const side = $('side');
$('panel-btn').addEventListener('click', () => { side.classList.add('open'); $('chat-badge').hidden = true; });
$('close-side').addEventListener('click', () => side.classList.remove('open'));
document.addEventListener('pointerdown', (e) => {
  if (side.classList.contains('open') && !side.contains(e.target) && !e.target.closest('#panel-btn')) side.classList.remove('open');
});

$('leave-btn').addEventListener('click', () => {
  if (room) room.leave();
  room = null;
  table.reset();
  inviteCode = '';
  setUrl(null);
  showLobby();
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !room) return;
  room.act('chat', { text });
  input.value = '';
});

$('newmatch-btn').addEventListener('click', () => { if (room) room.act('newMatch'); });
$('victory-close').addEventListener('click', () => { $('victory').hidden = true; });

// First interaction anywhere unlocks audio (autoplay policy).
addEventListener('pointerdown', unlockAudio, { capture: true });
addEventListener('keydown', unlockAudio, { capture: true });
addEventListener('pagehide', () => { if (room) room.leave(); });
// Restored from the back/forward cache with a dead connection: start over cleanly.
addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });

// ---------- boot
if (!nameInput.value) nameInput.value = store.get('tg_name') || '';
buildAvatars();
renderInvite();
if (!window.Peer) {
  showLobby('Could not load the networking library. Check your connection and refresh.');
} else if (inviteCode && nameInput.value) {
  // Returning player with a room link (or a refresh): drop straight back in.
  setBusy.active = document.querySelector('[data-mode="join-invite"]');
  enterRoom('join', inviteCode, nameInput.value);
} else {
  showLobby();
  (inviteCode ? nameInput : nameInput.value ? $('lobby-actions').querySelector('.btn') : nameInput).focus();
}
