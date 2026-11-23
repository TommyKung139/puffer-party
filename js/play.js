// Phone controller. Shows the category and whose turn it is; lets you type and send.
import { pufferSVG } from './puffer.js';
import { PEER_PREFIX, PEER_OPTIONS, escapeHtml as esc, setHTML, strikePips, keepAwake } from './shared.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

let room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
let myId = sessionStorage.getItem('kpp-id');
if (!myId) {
  myId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem('kpp-id', myId);
}
let myName = localStorage.getItem('kpp-name') || '';

let peer = null;
let conn = null;
let status = 'idle'; // idle | connecting | open | reconnecting | rejected
let joined = false;
let state = null;
let localDeadline = 0;
let lastVibeTurn = -1;
let retries = 0;
let retryTimer = null;
let openTimer = null;

// ---------------- join form ----------------
const joinForm = $('#joinForm');
const roomInput = $('#roomInput');
const nameInput = $('#nameInput');
const joinErr = $('#joinErr');

$('#brandFish').innerHTML = pufferSVG({ color: '#ffd23f', strikes: 1 });
roomInput.value = room;
$('#roomField').hidden = !!room;
nameInput.value = myName;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const r = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const n = nameInput.value.trim().slice(0, 12);
  if (!r) return showJoinError('請輸入房號');
  if (!n) return showJoinError('請輸入名字');
  room = r;
  myName = n;
  try { localStorage.setItem('kpp-name', n); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.set('room', room);
  history.replaceState(null, '', u);
  showJoinError('');
  $('#joinBtn').disabled = true;
  $('#joinBtn').textContent = '連線中…';
  retries = 0;
  connect();
  keepAwake();
});

function showJoinError(msg) {
  joinErr.textContent = msg;
  $('#joinBtn').disabled = false;
  $('#joinBtn').textContent = '加入遊戲';
}

function showJoinView(msg) {
  joined = false;
  $('#joinView').hidden = false;
  $('#gameView').hidden = true;
  $('#roomField').hidden = false;
  showJoinError(msg || '');
}

// ---------------- networking ----------------
function connect() {
  clearTimeout(retryTimer);
  clearTimeout(openTimer);
  if (peer) { try { peer.destroy(); } catch { /* ignore */ } }
  conn = null;
  status = joined ? 'reconnecting' : 'connecting';
  renderConn();

  peer = new window.Peer(PEER_OPTIONS);
  peer.on('open', () => {
    conn = peer.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
    conn.on('open', () => {
      clearTimeout(openTimer);
      status = 'open';
      retries = 0;
      conn.send({ t: 'join', id: myId, name: myName });
      renderConn();
    });
    conn.on('data', onMsg);
    conn.on('close', onDrop);
    conn.on('error', onDrop);
  });
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable' && !joined) {
      status = 'idle';
      try { peer.destroy(); } catch { /* ignore */ }
      showJoinError(`找不到房間 ${room}，請確認房號，或請主持人重新開房`);
      return;
    }
    onDrop();
  });
  // WebRTC sometimes just hangs instead of erroring.
  openTimer = setTimeout(() => { if (status !== 'open') onDrop(); }, 12000);
}

function onDrop() {
  if (status === 'rejected' || status === 'idle') return;
  clearTimeout(openTimer);
  status = joined ? 'reconnecting' : 'connecting';
  conn = null;
  renderConn();
  clearTimeout(retryTimer);
  retries++;
  if (!joined && retries > 3) {
    status = 'idle';
    try { peer && peer.destroy(); } catch { /* ignore */ }
    showJoinError('連不上主持人。試試和主持人連同一個 Wi-Fi，再加入一次。');
    return;
  }
  retryTimer = setTimeout(connect, Math.min(800 * 2 ** retries, 8000));
}

function send(msg) {
  try { if (conn && conn.open) conn.send(msg); } catch { /* ignore */ }
}

function onMsg(msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'welcome') {
    joined = true;
    if (msg.id && msg.id !== myId) {
      myId = msg.id;
      sessionStorage.setItem('kpp-id', myId);
    }
    $('#joinView').hidden = true;
    $('#gameView').hidden = false;
    render();
  } else if (msg.t === 'reject') {
    status = 'rejected';
    try { peer && peer.destroy(); } catch { /* ignore */ }
    showJoinView(msg.reason || '無法加入');
    status = 'idle';
  } else if (msg.t === 'state') {
    const prevCat = state ? state.categoryNo : null;
    state = msg.s;
    if (prevCat !== null && state.categoryNo !== prevCat) {
      // New category: whatever was typed is for the old one.
      input.value = '';
      lastDraft = '';
    }
    if (state.phase === 'turn' && typeof state.timeLeftMs === 'number') {
      localDeadline = Date.now() + state.timeLeftMs;
    }
    render();
  }
}

function renderConn() {
  const el = $('#conn');
  const show = joined && status !== 'open';
  el.hidden = !show;
  el.textContent = retries > 4 ? '一直連不上…主持人可能關掉或重新整理了房間' : '重新連線中…';
}

// ---------------- rendering ----------------
const answerForm = $('#answerForm');
const input = $('#answerInput');
const sendBtn = $('#sendBtn');
const skipBtn = $('#skipBtn');

function isMyTurn() {
  return !!state && state.phase === 'turn' && state.currentId === myId && !state.paused && status === 'open';
}

function render() {
  if (!state || !joined) return;
  const me = state.players.find((p) => p.id === myId);
  const cur = state.players.find((p) => p.id === state.currentId);
  const myTurn = isMyTurn();
  const max = state.settings.maxStrikes;
  const inGame = ['newcat', 'turn', 'judging', 'verdict'].includes(state.phase);

  document.body.style.setProperty('--pc', me ? me.color : '#ffd23f');
  document.body.classList.toggle('my-turn', myTurn);

  setHTML($('#me'), me
    ? `<div class="p-fish">${pufferSVG(me)}</div>
       <div class="p-who"><div class="p-name">${esc(me.name)}</div>${strikePips(me, max)}</div>
       <div class="p-room">房號 ${esc(state.room || room)}</div>`
    : '');

  const cat = state.category ? `<div class="p-label">題目</div><div class="p-cat">${esc(state.category)}</div>` : '';
  const curName = cur ? `<b style="color:${cur.color}">${esc(cur.name)}</b>` : '';
  let stage = '';
  switch (state.phase) {
    case 'lobby':
      stage = `<div class="p-big">🎉 加入成功！</div>
        <p>看大螢幕，等主持人開始</p>
        <p class="muted">${state.players.length} 位玩家：${state.players.map((p) => `<b style="color:${p.color}">${esc(p.name)}</b>`).join('、')}</p>`;
      break;
    case 'newcat':
      stage = `<div class="p-label">${state.catReason === 'stuck' ? '一輪都答不出來，換題！' : '新題目！'}</div>
        <div class="p-cat">${esc(state.category)}</div>
        <p>由 ${curName} 開始${cur && cur.id === myId ? '（就是你！先想好答案）' : ''}</p>`;
      break;
    case 'turn':
      stage = `${cat}<div class="p-turn ${myTurn ? 'mine' : ''}">${cur && cur.id === myId ? '輪到你！' : `輪到 ${curName}`}</div>`;
      break;
    case 'judging':
      stage = `${cat}<div class="p-said">${curName}：「${esc(state.pendingText || '')}」</div><p class="muted"><span class="spinner"></span> 查核中…</p>`;
      break;
    case 'verdict': {
      const v = state.verdict || {};
      const mine = v.playerId === myId;
      stage = `${cat}<div class="p-verdict ${v.pass ? 'ok' : 'bad'}">${v.pass ? '✅ 通過' : v.eliminates ? '💥 出局' : '❌ 不通過'}</div>
        <p>${mine ? '你' : curName}${v.text ? `：「${esc(v.text)}」` : ''}</p>
        <p class="muted">${esc(v.reason || '')}</p>`;
      break;
    }
    case 'over': {
      const w = state.players.find((p) => p.id === state.winnerId);
      stage = w && w.id === myId
        ? '<div class="p-big">🏆 你是最後的河豚！</div><p>看大螢幕，等主持人開下一局</p>'
        : `<div class="p-big">🏆</div><div class="p-cat">${w ? `${curNameOf(w)} 獲勝！` : '遊戲結束'}</div><p class="muted">等主持人開下一局</p>`;
      break;
    }
    default:
      break;
  }
  if (me && me.out && inGame) stage = `<div class="p-out">💥 你出局了，當觀眾吧 👀</div>${stage}`;
  if (state.paused && inGame) stage = `<div class="p-paused">⏸ 暫停中</div>${stage}`;
  setHTML($('#stage'), stage);

  const canPlay = inGame && me && !me.out;
  answerForm.hidden = !canPlay;
  skipBtn.hidden = !myTurn;
  sendBtn.disabled = !myTurn;
  input.placeholder = myTurn ? '快！輸入答案按送出' : '還沒輪到你，可以先打好答案…';
  $('#pbarWrap').hidden = state.phase !== 'turn';

  const answers = inGame ? [...state.answers].reverse() : [];
  setHTML($('#pAnswers'), answers.length
    ? `<div class="p-label">已經答過（不能重複）</div><div class="p-chips">${answers.map((a) => {
      const p = state.players.find((x) => x.id === a.playerId);
      return `<span class="ans" style="--pc:${p ? p.color : '#fff'}">${esc(a.text)}</span>`;
    }).join('')}</div>`
    : '');

  if (myTurn && state.turnNo !== lastVibeTurn) {
    lastVibeTurn = state.turnNo;
    try { navigator.vibrate && navigator.vibrate([90, 50, 90]); } catch { /* ignore */ }
    input.focus();
  }
}

function curNameOf(p) {
  return `<b style="color:${p.color}">${esc(p.name)}</b>`;
}

function frame() {
  requestAnimationFrame(frame);
  if (!state || state.phase !== 'turn') return;
  const total = state.settings.turnSeconds * 1000;
  const left = state.paused ? state.timeLeftMs : Math.max(0, localDeadline - Date.now());
  const bar = $('#pbar');
  bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
  bar.classList.toggle('danger', left < 2000);
  $('#pcd').textContent = String(Math.ceil(left / 1000));
}

// ---------------- answering ----------------
answerForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  if (!isMyTurn()) {
    answerForm.classList.remove('shake');
    void answerForm.offsetWidth;
    answerForm.classList.add('shake');
    return;
  }
  send({ t: 'answer', text: text.slice(0, 60) });
  input.value = '';
  input.focus();
});

// Stream what you're typing so the host can fact-check it before you hit send.
let draftTimer = null;
let lastDraft = '';
let composing = false; // Chinese IME: wait until the characters are picked
function queueDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(sendDraft, 350);
}
function sendDraft() {
  if (!state || composing) return;
  const text = input.value.trim();
  const sig = `${state.categoryNo}|${text}`;
  if (sig === lastDraft) return;
  lastDraft = sig;
  send({ t: 'draft', text, cat: state.categoryNo });
}
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => { composing = false; queueDraft(); });
input.addEventListener('input', (e) => { if (!e.isComposing) queueDraft(); });

skipBtn.addEventListener('click', () => {
  if (isMyTurn()) send({ t: 'skip' });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  keepAwake();
  if (joined && status !== 'open' && status !== 'rejected') { retries = 0; connect(); }
});

if (!window.Peer) {
  showJoinError('載入連線元件失敗，請重新整理');
}
requestAnimationFrame(frame);
