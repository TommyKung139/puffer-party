// Host / big screen. This browser IS the game server: it owns the Engine,
// keeps the clock, talks to the AI judge, and pushes state to every phone.
import { Engine, PHASE, normalizeAnswer } from './engine.js';
import { CATEGORIES } from './categories.js';
import { pufferSVG } from './puffer.js';
import { sfx } from './sfx.js';
import {
  PEER_PREFIX, PEER_OPTIONS, randomCode, escapeHtml as esc, shuffle, setHTML, strikePips, keepAwake,
} from './shared.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const DEV = params.has('dev'); // ?dev lets you start with 1+ players for testing

// ---------------- settings ----------------
const SETTINGS_KEY = 'kpp-host-settings';
const settings = Object.assign(
  { turnSeconds: 5, judge: 'ai', source: 'bank', custom: '' },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })(),
);
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ } };

// ---------------- categories ----------------
let aiAvailable = false;
const cats = (() => {
  const used = new Set();
  let bank = [];
  const aiQueue = [];
  let fetching = false;
  const customList = () => settings.custom.split('\n').map((s) => s.trim()).filter(Boolean);

  async function fetchAI() {
    if (fetching || !aiAvailable || settings.source !== 'ai') return;
    fetching = true;
    try {
      const r = await fetch('api/category', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exclude: [...used].slice(-60) }),
      });
      const j = await r.json();
      if (Array.isArray(j.categories)) {
        for (const c of j.categories) if (typeof c === 'string' && c.trim() && !used.has(c)) aiQueue.push(c.trim());
      }
    } catch { /* fall back to the bank */ } finally { fetching = false; }
  }

  return {
    next() {
      let c;
      if (settings.source === 'custom') c = shuffle(customList().filter((x) => !used.has(x)))[0];
      if (!c && settings.source === 'ai') {
        c = aiQueue.shift();
        if (aiQueue.length < 3) fetchAI();
      }
      while (!c) {
        if (!bank.length) {
          bank = shuffle(CATEGORIES.filter((x) => !used.has(x)));
          if (!bank.length) { used.clear(); bank = shuffle(CATEGORIES); }
        }
        const cand = bank.shift();
        if (!used.has(cand)) c = cand;
      }
      used.add(c);
      return c;
    },
    prime: fetchAI,
  };
})();

// ---------------- engine + clock ----------------
const engine = new Engine({
  minPlayers: DEV ? 1 : 4,
  maxPlayers: 8,
  maxStrikes: 3,
  turnSeconds: settings.turnSeconds,
  pickCategory: () => cats.next(),
});

const DURATION = { [PHASE.NEWCAT]: 3200, [PHASE.VERDICT]: 2600 };
let phaseKey = '';
let phaseEndsAt = 0;
let timer = null;
let paused = false;
let pausedRemaining = 0;
let judgeState = null; // { turnNo, status: 'ai' | 'manual' }
let lastTickSec = null;

function phaseDuration(ph) {
  return ph === PHASE.TURN ? engine.settings.turnSeconds * 1000 : DURATION[ph] || 0;
}

function enterPhase(ph) {
  const dur = phaseDuration(ph);
  if (paused) pausedRemaining = dur;
  else phaseEndsAt = Date.now() + dur;
  lastTickSec = null;
  if (ph === PHASE.NEWCAT) sfx.newcat();
  if (ph === PHASE.TURN) sfx.turn();
  if (ph === PHASE.VERDICT) playVerdictSound();
  if (ph === PHASE.OVER) sfx.win();
}

function playVerdictSound() {
  const v = engine.verdict;
  if (!v) return;
  if (v.pass) sfx.pass();
  else if (v.eliminates) sfx.pop();
  else sfx.fail();
}

function schedule() {
  clearTimeout(timer);
  timer = null;
  if (paused) return;
  if (![PHASE.NEWCAT, PHASE.TURN, PHASE.VERDICT].includes(engine.phase)) return;
  timer = setTimeout(onPhaseTimer, Math.max(0, phaseEndsAt - Date.now()));
}

function onPhaseTimer() {
  const ph = engine.phase;
  if (ph === PHASE.NEWCAT) engine.beginTurn();
  else if (ph === PHASE.TURN) engine.timeout();
  else if (ph === PHASE.VERDICT) engine.commit();
  update();
}

// The one place every change flows through.
function update() {
  const key = `${engine.phase}|${engine.turnNo}|${engine.categoryNo}`;
  if (key !== phaseKey) {
    phaseKey = key;
    enterPhase(engine.phase);
    prejudgeUpcoming();
  }
  schedule();
  render();
  broadcast();
}

function timeLeft() {
  if (engine.phase !== PHASE.TURN) return null;
  return paused ? pausedRemaining : Math.max(0, phaseEndsAt - Date.now());
}

// ---------------- judging ----------------
async function callJudge(category, answer, previous) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch('api/judge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category, answer, previous }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!['pass', 'fail', 'unsure'].includes(j.verdict)) throw new Error('bad verdict');
    return { pass: j.verdict !== 'fail', unsure: j.verdict === 'unsure', reason: j.reason || '' };
  } finally {
    clearTimeout(t);
  }
}

// ---- pre-checking ----
// Phones stream what players are typing (drafts). For the player on the clock
// and the next two in line, we ask the AI *before* they hit send, so by the
// time they submit the verdict is usually already cached -> instant.
// Cache key = category + answer + how many answers exist so far (the AI also
// checks for "same thing, different words" duplicates against that list).
const PRECHECK_AHEAD = 2;
const precheck = new Map(); // key -> { promise, result }
const drafts = new Map(); // playerId -> latest typed text
let precheckCat = 0;

function aiOn() { return settings.judge === 'ai' && aiAvailable; }

function judgeKey(category, text, n) {
  return `${category}\u0000${normalizeAnswer(text)}\u0000${n}`;
}

function judgeCached(category, text, previous) {
  const key = judgeKey(category, text, previous.length);
  let e = precheck.get(key);
  if (!e) {
    e = { promise: callJudge(category, text, previous), result: null };
    e.promise.then((r) => { e.result = r; }, () => { precheck.delete(key); });
    precheck.set(key, e);
  }
  return e;
}

function upcomingIds() {
  const ids = [];
  const n = engine.players.length;
  const start = engine.players.findIndex((p) => p.id === engine.currentId);
  if (start < 0) return ids;
  for (let i = 0; i < n && ids.length <= PRECHECK_AHEAD; i++) {
    const p = engine.players[(start + i) % n];
    if (!p.out) ids.push(p.id);
  }
  return ids;
}

function prejudge(id) {
  if (!aiOn() || ![PHASE.NEWCAT, PHASE.TURN, PHASE.VERDICT].includes(engine.phase)) return;
  if (!upcomingIds().includes(id)) return;
  const text = drafts.get(id);
  const key = normalizeAnswer(text);
  const previous = engine.answers.map((a) => a.text);
  // While a correct answer is on screen it's about to join the list, so check against that future list.
  const v = engine.verdict;
  if (engine.phase === PHASE.VERDICT && v && v.pass && v.text) previous.push(v.text);
  if (!key || previous.some((t) => normalizeAnswer(t) === key)) return; // empty or exact duplicate: no AI needed
  judgeCached(engine.category, text, previous).promise.catch(() => {});
}

function prejudgeUpcoming() {
  if (engine.categoryNo !== precheckCat) {
    // New category: old drafts and results are useless.
    precheckCat = engine.categoryNo;
    precheck.clear();
    drafts.clear();
  }
  for (const id of upcomingIds()) prejudge(id);
}

function onDraft(id, raw) {
  const p = engine.player(id);
  if (!p || p.out) return;
  if (Number(raw && raw.cat) !== engine.categoryNo) return; // typed for an older category
  drafts.set(id, String((raw && raw.text) || '').trim().slice(0, 60));
  prejudge(id);
}

async function runJudge(sub) {
  const useAI = aiOn();
  judgeState = { turnNo: sub.turnNo, status: useAI ? 'ai' : 'manual' };
  if (!useAI) { render(); return; }
  const e = judgeCached(sub.category, sub.text, sub.previous);
  if (e.result) { // pre-checked: instant verdict
    if (engine.judged(sub.turnNo, e.result)) update();
    return;
  }
  render();
  try {
    const res = await e.promise;
    if (engine.judged(sub.turnNo, res)) update();
  } catch (err) {
    console.warn('AI judge failed', err);
    if (judgeState && judgeState.turnNo === sub.turnNo) {
      judgeState.status = 'manual';
      judgeState.error = true;
      render();
    }
  }
}

function manualJudge(pass) {
  if (engine.phase !== PHASE.JUDGING || !engine.pending) return;
  const ok = engine.judged(engine.pending.turnNo, { pass, reason: pass ? '主持人判定通過' : '主持人判定不通過' });
  if (ok) update();
}

function overrule() {
  if (!engine.overrule()) return;
  prejudgeUpcoming();
  if (!paused) phaseEndsAt = Math.max(phaseEndsAt, Date.now() + 1800);
  playVerdictSound();
  update();
}

// ---------------- host actions ----------------
function startGame() {
  engine.settings.turnSeconds = settings.turnSeconds;
  if (!engine.start()) return;
  paused = false;
  judgeState = null;
  update();
}

function togglePause() {
  if (![PHASE.NEWCAT, PHASE.TURN, PHASE.JUDGING, PHASE.VERDICT].includes(engine.phase)) return;
  if (!paused) {
    paused = true;
    pausedRemaining = Math.max(0, phaseEndsAt - Date.now());
  } else {
    paused = false;
    phaseEndsAt = Date.now() + pausedRemaining;
  }
  update();
}

function skipCategory() {
  if (engine.skipCategory()) update();
}

function backToLobby() {
  if (engine.phase !== PHASE.OVER && !confirm('結束這一局，回到大廳？')) return;
  engine.backToLobby();
  paused = false;
  update();
}

function kick(id) {
  const c = conns.get(id);
  if (c) {
    send(c, { t: 'reject', reason: '你被主持人移出房間了' });
    connIds.delete(c);
    conns.delete(id);
    setTimeout(() => { try { c.close(); } catch { /* already closed */ } }, 300);
  }
  engine.removePlayer(id);
  update();
}

// ---------------- networking (PeerJS) ----------------
let peer = null;
let roomCode = null;
let netStatus = 'connecting';
const conns = new Map(); // playerId -> DataConnection
const connIds = new Map(); // DataConnection -> playerId

function openRoom() {
  roomCode = randomCode();
  netStatus = 'connecting';
  peer = new window.Peer(PEER_PREFIX + roomCode, PEER_OPTIONS);
  peer.on('open', () => { netStatus = 'ok'; render(); });
  peer.on('connection', onConnection);
  peer.on('disconnected', () => {
    netStatus = 'reconnecting';
    render();
    setTimeout(() => { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1500);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') { peer.destroy(); openRoom(); return; }
    if (err.type === 'peer-unavailable') return;
    console.warn('peer error', err.type, err);
    if (err.type === 'browser-incompatible') netStatus = 'unsupported';
    else if (!peer.open) netStatus = 'error';
    render();
  });
}

function onConnection(conn) {
  conn.on('data', (msg) => onMessage(conn, msg));
  conn.on('close', () => onConnClose(conn));
  conn.on('error', () => onConnClose(conn));
}

function send(conn, msg) {
  try { if (conn && conn.open) conn.send(msg); } catch { /* channel closing */ }
}

function snapshot() {
  return { ...engine.publicState(), timeLeftMs: timeLeft(), paused, room: roomCode };
}

function broadcast() {
  const s = snapshot();
  for (const c of conns.values()) send(c, { t: 'state', s });
}

function attach(conn, id) {
  const old = conns.get(id);
  if (old && old !== conn) {
    connIds.delete(old);
    try { old.close(); } catch { /* ignore */ }
  }
  conns.set(id, conn);
  connIds.set(conn, id);
  const p = engine.player(id);
  if (p) p.connected = true;
}

function onMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'join') return handleJoin(conn, msg);
  const id = connIds.get(conn);
  if (!id) return;
  if (msg.t === 'answer') {
    if (paused) return;
    const r = engine.submit(id, msg.text);
    if (!r.ok) return;
    update();
    if (r.judge) runJudge(r);
  } else if (msg.t === 'draft') {
    onDraft(id, msg);
  } else if (msg.t === 'skip') {
    if (!paused && engine.skip(id)) update();
  }
}

function handleJoin(conn, msg) {
  const id = String(msg.id || '').slice(0, 64);
  const name = String(msg.name || '').trim().slice(0, 12);
  if (!id || !name) return send(conn, { t: 'reject', reason: '請輸入名字' });

  let p = engine.player(id);
  // Phone lost its session mid-game? Let it take back its seat by name.
  if (!p && engine.phase !== PHASE.LOBBY) {
    p = engine.players.find((x) => !x.connected && x.name.toLowerCase() === name.toLowerCase()) || null;
  }
  if (p) {
    attach(conn, p.id);
    send(conn, { t: 'welcome', id: p.id });
    update();
    return;
  }
  if (engine.phase !== PHASE.LOBBY) {
    return send(conn, { t: 'reject', reason: '遊戲已經開始了，等下一局吧！' });
  }
  const r = engine.addPlayer(id, name);
  if (!r.ok) {
    return send(conn, { t: 'reject', reason: r.reason === 'full' ? '房間滿了（最多 8 人）' : '無法加入' });
  }
  attach(conn, id);
  send(conn, { t: 'welcome', id });
  sfx.join();
  update();
}

function onConnClose(conn) {
  const id = connIds.get(conn);
  if (!id) return;
  connIds.delete(conn);
  if (conns.get(id) === conn) {
    conns.delete(id);
    const p = engine.player(id);
    if (p) p.connected = false;
    update();
  }
}

// ---------------- rendering ----------------
let currentView = null;

const TEMPLATES = {
  lobby: () => `
  <section class="lobby">
    <header class="brand">
      <div class="brand-fish">${pufferSVG({ color: '#ffd23f', strikes: 1 })}</div>
      <div>
        <h1>河豚派對</h1>
        <p class="sub">KRILLION PUFFER PARTY</p>
      </div>
    </header>
    <div class="lobby-grid">
      <div class="join-card">
        <div class="qr" id="qr"><div class="qr-wait">開房中…</div></div>
        <div class="join-label">手機掃描加入，或輸入房號</div>
        <div class="room" id="roomCode">····</div>
        <div class="join-url" id="joinUrl"></div>
        <div class="warn" id="netWarn" hidden></div>
      </div>
      <div class="side">
        <div class="players-head"><h2>玩家</h2><span id="pcount"></span></div>
        <div class="slots" id="slots"></div>
        <div class="settings">
          <label>每回合
            <select id="setSeconds">
              ${[3, 5, 7, 10, 15].map((n) => `<option value="${n}">${n} 秒</option>`).join('')}
            </select>
          </label>
          <label>判定
            <select id="setJudge">
              <option value="ai">AI 事實查核</option>
              <option value="host">主持人判定</option>
            </select>
          </label>
          <label>題目
            <select id="setSource">
              <option value="bank">內建題庫</option>
              <option value="ai">AI 出題</option>
              <option value="custom">自訂題目</option>
            </select>
          </label>
          <textarea id="setCustom" rows="3" placeholder="自訂題目：一行一題，例如&#10;YouTube 點擊量 50 萬以上的音樂"></textarea>
          <p class="ai-status" id="aiStatus"></p>
        </div>
        <button class="btn big primary" id="startBtn" data-action="start">開始遊戲</button>
      </div>
    </div>
    <footer class="rules">
      <span>🐡 輪流回答題目</span>
      <span>⏱ <b id="ruleSec">5</b> 秒內沒答 = ✕</span>
      <span>❌ 答錯或重複 = ✕</span>
      <span>💥 3 個 ✕ 出局</span>
      <span>🔄 一輪都答不出來就換題</span>
      <span>🏆 最後一隻河豚獲勝</span>
    </footer>
  </section>`,

  game: () => `
  <section class="game">
    <div class="topbar">
      <div class="chip">房號 <b id="gRoom"></b></div>
      <div class="chip" id="gCatNo"></div>
      <div class="chip" id="gJudge"></div>
      <div class="spacer"></div>
      <button class="btn ghost" data-action="pause" id="pauseBtn">⏸ 暫停</button>
      <button class="btn ghost" data-action="skipcat">🔀 換題</button>
      <button class="btn ghost" data-action="mute" id="muteBtn">🔊</button>
      <button class="btn ghost" data-action="fullscreen">⛶</button>
      <button class="btn ghost" data-action="lobby">⏹ 結束</button>
    </div>
    <div class="category-card" id="category"></div>
    <div class="arena">
      <div class="spotlight" id="spotlight"></div>
      <aside class="answers">
        <h3>已經答過 <span id="ansCount"></span></h3>
        <div class="answer-list" id="answers"></div>
      </aside>
    </div>
    <div class="roster" id="roster"></div>
    <div class="overlay" id="overlay" hidden></div>
    <div class="keys">Y 通過 · N 不通過 · O 推翻判決 · 空白鍵 暫停 · S 換題 · F 全螢幕 · M 靜音</div>
  </section>`,

  over: () => `
  <section class="over">
    <div class="over-title">🏆 最後的河豚</div>
    <div class="winner" id="winner"></div>
    <ol class="ranking" id="ranking"></ol>
    <div class="actions">
      <button class="btn big primary" data-action="rematch">再來一局</button>
      <button class="btn big ghost" data-action="lobby">回大廳</button>
    </div>
  </section>`,
};

function render() {
  const ph = engine.phase;
  const view = ph === PHASE.LOBBY ? 'lobby' : ph === PHASE.OVER ? 'over' : 'game';
  if (view !== currentView) {
    currentView = view;
    $('#view').innerHTML = TEMPLATES[view]();
    if (view === 'lobby') mountLobby();
  }
  if (view === 'lobby') renderLobby();
  else if (view === 'game') renderGame();
  else renderOver();
}

function joinUrl() {
  const u = new URL('play.html', location.href);
  u.search = `?room=${roomCode}`;
  return u.href;
}

function qrSVG(text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#0b2340"/></svg>`;
}

let qrFor = null;
function renderQR() {
  const el = $('#qr');
  if (!el || !roomCode || netStatus !== 'ok') return;
  if (qrFor === roomCode && el.querySelector('svg')) return;
  qrFor = roomCode;
  try { el.innerHTML = qrSVG(joinUrl()); } catch { el.innerHTML = '<div class="qr-wait">QR 載入失敗</div>'; }
}

function mountLobby() {
  qrFor = null;
  const sec = $('#setSeconds');
  sec.value = String(settings.turnSeconds);
  sec.onchange = () => {
    settings.turnSeconds = Number(sec.value);
    engine.settings.turnSeconds = settings.turnSeconds;
    saveSettings();
    update();
  };
  const judge = $('#setJudge');
  judge.value = settings.judge;
  judge.onchange = () => { settings.judge = judge.value; saveSettings(); render(); };
  const src = $('#setSource');
  src.value = settings.source;
  src.onchange = () => { settings.source = src.value; saveSettings(); cats.prime(); render(); };
  const custom = $('#setCustom');
  custom.value = settings.custom;
  custom.oninput = () => { settings.custom = custom.value; saveSettings(); };
}

function renderLobby() {
  $('#roomCode').textContent = roomCode && netStatus === 'ok' ? roomCode : '····';
  $('#joinUrl').textContent = roomCode && netStatus === 'ok' ? joinUrl().replace(/^https?:\/\//, '') : '';
  renderQR();

  const warn = $('#netWarn');
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  let w = '';
  if (netStatus === 'error') w = '連不上配對伺服器，請檢查網路後重新整理。';
  else if (netStatus === 'unsupported') w = '這個瀏覽器不支援 WebRTC，請用 Chrome / Safari / Edge。';
  else if (netStatus === 'reconnecting') w = '重新連線中…';
  else if (isLocal) w = '你正在用 localhost 開房，手機連不到這個網址。部署到 Vercel 後再用，或改用電腦的區網 IP。';
  warn.hidden = !w;
  warn.textContent = w;

  const n = engine.players.length;
  const max = engine.settings.maxPlayers;
  const min = engine.settings.minPlayers;
  $('#pcount').textContent = `${n} / ${max} 人`;
  let slots = '';
  for (let i = 0; i < max; i++) {
    const p = engine.players[i];
    slots += p
      ? `<div class="slot filled ${p.connected ? '' : 'offline'}" style="--pc:${p.color}">
           <div class="slot-fish">${pufferSVG(p)}</div>
           <div class="slot-name">${esc(p.name)}${p.connected ? '' : ' 📵'}</div>
           <button class="kick" data-action="kick" data-id="${esc(p.id)}" title="移出">✕</button>
         </div>`
      : `<div class="slot empty"><div class="slot-fish ghost">${pufferSVG({ color: '#ffffff' })}</div><div class="slot-name">${i < min ? '等待加入…' : '（可選）'}</div></div>`;
  }
  setHTML($('#slots'), slots);

  const btn = $('#startBtn');
  btn.disabled = !engine.canStart();
  btn.textContent = engine.canStart() ? `開始遊戲（${n} 人）` : `至少要 ${min} 人才能開始（目前 ${n}）`;
  $('#ruleSec').textContent = settings.turnSeconds;

  const ai = $('#aiStatus');
  if (aiAvailable) ai.innerHTML = '✅ AI 裁判已就緒（Claude）';
  else ai.innerHTML = '⚠️ 沒偵測到 AI 裁判（Vercel 需設定 <code>ANTHROPIC_API_KEY</code>），會改用主持人判定與內建題庫。';
}

function judgeLabel() {
  if (settings.judge === 'ai' && aiAvailable) return '🤖 AI 裁判';
  return '🧑‍⚖️ 主持人判定';
}

function renderGame() {
  const ph = engine.phase;
  const cur = engine.player(engine.currentId);
  $('#gRoom').textContent = roomCode || '';
  $('#gCatNo').textContent = `第 ${engine.categoryNo} 題`;
  $('#gJudge').textContent = judgeLabel();
  $('#pauseBtn').textContent = paused ? '▶️ 繼續' : '⏸ 暫停';
  $('#muteBtn').textContent = sfx.muted ? '🔇' : '🔊';

  setHTML($('#category'), `<div class="cat-label">題目</div><div class="cat-text">${esc(engine.category)}</div>`);

  // spotlight
  let spot = '';
  if (cur) {
    const style = `style="--pc:${cur.color}"`;
    if (ph === PHASE.TURN || ph === PHASE.NEWCAT) {
      spot = `<div class="spot turn" ${style}>
        <div class="ring-wrap">
          <svg class="ring" viewBox="0 0 200 200">
            <circle class="ring-bg" cx="100" cy="100" r="92"/>
            <circle class="ring-fg" id="ringFg" cx="100" cy="100" r="92" pathLength="1000"/>
          </svg>
          <div class="ring-fish">${pufferSVG(cur)}</div>
          <div class="cd" id="cd">${engine.settings.turnSeconds}</div>
        </div>
        <div class="spot-name">${esc(cur.name)}</div>
        <div class="spot-hint">${ph === PHASE.TURN ? '輪到你了！快回答！' : '準備…'}</div>
      </div>`;
    } else if (ph === PHASE.JUDGING) {
      const aiBusy = judgeState && judgeState.status === 'ai';
      const err = judgeState && judgeState.error;
      spot = `<div class="spot judging" ${style}>
        <div class="spot-fish">${pufferSVG(cur)}</div>
        <div class="spot-name">${esc(cur.name)}</div>
        <div class="said">「${esc(engine.pending ? engine.pending.text : '')}」</div>
        <div class="checking">${aiBusy ? '<span class="spinner"></span> AI 查核中…' : err ? '⚠️ AI 沒回應，請主持人判定' : '🧑‍⚖️ 主持人，請判定'}</div>
        <div class="judge-btns ${aiBusy ? 'quiet' : ''}">
          <button class="btn pass" data-action="judge-pass">✅ 通過 <kbd>Y</kbd></button>
          <button class="btn fail" data-action="judge-fail">❌ 不通過 <kbd>N</kbd></button>
        </div>
      </div>`;
    } else if (ph === PHASE.VERDICT && engine.verdict) {
      const v = engine.verdict;
      const preview = { ...cur, strikes: v.pass ? cur.strikes : cur.strikes + 1, out: v.eliminates };
      spot = `<div class="spot verdict ${v.pass ? 'ok' : 'bad'}" ${style}>
        <div class="spot-fish ${v.eliminates ? 'popping' : ''}">${pufferSVG(preview)}</div>
        <div class="spot-name">${esc(cur.name)}</div>
        ${v.text ? `<div class="said">「${esc(v.text)}」</div>` : ''}
        <div class="stamp">${v.pass ? '通過！' : v.eliminates ? '出局！' : '✕ 不通過'}</div>
        <div class="reason">${esc(v.reason || '')}
          ${v.unsure ? '<span class="tag">AI 不太確定</span>' : ''}
          ${v.overruled ? '<span class="tag">主持人改判</span>' : ''}</div>
        <button class="btn ghost small" data-action="overrule">⚖️ 推翻判決 <kbd>O</kbd></button>
      </div>`;
    }
  }
  setHTML($('#spotlight'), spot);

  // accepted answers (newest first)
  $('#ansCount').textContent = engine.answers.length ? `(${engine.answers.length})` : '';
  const ans = [...engine.answers].reverse().map((a) => {
    const p = engine.player(a.playerId);
    return `<span class="ans" style="--pc:${p ? p.color : '#fff'}">${esc(a.text)}</span>`;
  }).join('');
  setHTML($('#answers'), ans || '<div class="empty-note">還沒有人答對</div>');

  // roster
  const max = engine.settings.maxStrikes;
  setHTML($('#roster'), engine.players.map((p) => `
    <div class="r-player ${p.id === engine.currentId ? 'current' : ''} ${p.out ? 'out' : ''} ${p.connected ? '' : 'offline'}" style="--pc:${p.color}">
      <div class="r-fish">${pufferSVG(p)}</div>
      <div class="r-name">${esc(p.name)}${p.connected ? '' : ' 📵'}</div>
      ${strikePips(p, max)}
    </div>`).join(''));

  // overlay
  const ov = $('#overlay');
  let ovHTML = '';
  if (ph === PHASE.NEWCAT && cur) {
    const label = { start: '第一題！', stuck: '一整輪都答不出來！換題', skip: '換題！' }[engine.catReason] || '新題目';
    ovHTML = `<div class="newcat">
      <div class="nc-label">${label}</div>
      <div class="nc-cat">${esc(engine.category)}</div>
      <div class="nc-first">由 <b style="color:${cur.color}">${esc(cur.name)}</b> 開始</div>
    </div>`;
  }
  if (paused) ovHTML = '<div class="paused">⏸ 暫停中<small>按空白鍵繼續</small></div>';
  ov.hidden = !ovHTML;
  setHTML(ov, ovHTML);
}

function renderOver() {
  const w = engine.player(engine.winnerId);
  setHTML($('#winner'), w
    ? `<div class="winner-fish" style="--pc:${w.color}">${pufferSVG(w)}</div><div class="winner-name" style="color:${w.color}">${esc(w.name)}</div><div class="winner-sub">答對 ${w.correct} 題</div>`
    : '<div class="winner-name">沒有贏家</div>');
  const ranked = [...engine.players].sort((a, b) => (a.out - b.out) || (b.outOrder - a.outOrder));
  setHTML($('#ranking'), ranked.map((p) => `
    <li style="--pc:${p.color}"><span class="rk-fish">${pufferSVG(p)}</span><span class="rk-name">${esc(p.name)}</span><span class="rk-stat">答對 ${p.correct}</span></li>`).join(''));
}

// Countdown ring + ticking, every frame.
function frame() {
  requestAnimationFrame(frame);
  if (engine.phase !== PHASE.TURN) return;
  const total = engine.settings.turnSeconds * 1000;
  const left = timeLeft();
  const fg = document.getElementById('ringFg');
  if (fg) {
    fg.style.strokeDashoffset = String(1000 * (1 - left / total));
    fg.classList.toggle('danger', left < 2000);
  }
  const sec = Math.ceil(left / 1000);
  const cd = document.getElementById('cd');
  if (cd) {
    cd.textContent = String(sec);
    cd.classList.toggle('danger', left < 2000);
  }
  if (!paused && sec !== lastTickSec && sec <= 3 && sec > 0) sfx.tick(sec);
  lastTickSec = sec;
}

// ---------------- input ----------------
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  sfx.unlock();
  keepAwake();
  switch (b.dataset.action) {
    case 'start':
    case 'rematch': startGame(); break;
    case 'kick': kick(b.dataset.id); break;
    case 'pause': togglePause(); break;
    case 'skipcat': skipCategory(); break;
    case 'mute': sfx.toggleMute(); render(); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'lobby': backToLobby(); break;
    case 'judge-pass': manualJudge(true); break;
    case 'judge-fail': manualJudge(false); break;
    case 'overrule': overrule(); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 'y') manualJudge(true);
  else if (k === 'n') manualJudge(false);
  else if (k === 'o') overrule();
  else if (k === ' ' || k === 'p') { e.preventDefault(); togglePause(); }
  else if (k === 's') skipCategory();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'm') { sfx.toggleMute(); render(); }
});

window.addEventListener('beforeunload', (e) => {
  if (engine.phase !== PHASE.LOBBY && engine.phase !== PHASE.OVER) {
    e.preventDefault();
    e.returnValue = '';
  }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

// ---------------- boot ----------------
async function checkAI() {
  try {
    const r = await fetch('api/judge', { cache: 'no-store' });
    const j = await r.json();
    aiAvailable = !!j.ai;
  } catch {
    aiAvailable = false;
  }
  cats.prime();
  render();
}

function boot() {
  if (!window.Peer) {
    $('#view').innerHTML = '<div class="fatal">載入連線元件失敗（PeerJS）。請檢查網路後重新整理。</div>';
    return;
  }
  render();
  openRoom();
  checkAI();
  requestAnimationFrame(frame);
}

boot();

// Handy for debugging from the console.
window.__kpp = { engine, update, settings };
