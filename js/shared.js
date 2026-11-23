// Shared bits for host + phone.

// Every room becomes a PeerJS id: PEER_PREFIX + room code.
// Change the prefix if you fork this so your rooms never collide with someone else's.
export const PEER_PREFIX = 'krillion-puffer-party-v1-';

export const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // If phones on mobile data can't connect, add a TURN server here, e.g.
      // { urls: 'turn:your.turn.server:3478', username: '...', credential: '...' },
    ],
  },
};

export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(len = 4) {
  let s = '';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  for (const n of buf) s += ROOM_ALPHABET[n % ROOM_ALPHABET.length];
  return s;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Only touch the DOM when markup actually changed (keeps CSS animations from restarting).
const lastHTML = new WeakMap();
export function setHTML(el, html) {
  if (!el) return;
  if (lastHTML.get(el) === html) return;
  lastHTML.set(el, html);
  el.innerHTML = html;
}

export function strikePips(p, max) {
  let s = '';
  for (let i = 0; i < max; i++) s += `<i class="${i < p.strikes ? 'on' : ''}"></i>`;
  return `<span class="pips">${s}</span>`;
}

let wakeLock = null;
export async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* not supported or denied */ }
}
