// Pure game logic. The host browser owns one Engine; phones only send intents.
// No timers or networking in here, so it can be unit-tested with Node.

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  NEWCAT: 'newcat', // showing a fresh category before the turn starts
  TURN: 'turn', // current player is on the clock
  JUDGING: 'judging', // answer submitted, waiting for AI / host
  VERDICT: 'verdict', // showing pass / fail (host can overrule)
  OVER: 'over',
});

export const COLORS = [
  '#ffd23f', '#ff6b6b', '#3ddc97', '#4cc9f0',
  '#c77dff', '#ff9f1c', '#f15bb5', '#a3e635',
];

export function normalizeAnswer(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export class Engine {
  constructor(opts = {}) {
    const { pickCategory, ...settings } = opts;
    this.settings = { turnSeconds: 5, maxStrikes: 3, minPlayers: 4, maxPlayers: 8, ...settings };
    this.pickCategory = pickCategory || (() => '自由發揮');
    this.players = [];
    this.phase = PHASE.LOBBY;
    this._resetRound();
  }

  _resetRound() {
    this.currentId = null;
    this.category = null;
    this.categoryNo = 0;
    this.catReason = null; // 'start' | 'stuck' | 'skip'
    this.answers = [];
    this.failed = new Set(); // players who failed since the last correct answer
    this.pending = null;
    this.verdict = null;
    this.lastVerdict = null;
    this.winnerId = null;
    this.turnNo = 0;
    this.outCounter = 0;
  }

  // ---------- players ----------
  player(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  alive() {
    return this.players.filter((p) => !p.out);
  }

  addPlayer(id, rawName) {
    if (this.phase !== PHASE.LOBBY) return { ok: false, reason: 'started' };
    if (this.player(id)) return { ok: true, player: this.player(id) };
    if (this.players.length >= this.settings.maxPlayers) return { ok: false, reason: 'full' };
    let name = String(rawName ?? '').trim().slice(0, 12) || '河豚';
    const taken = new Set(this.players.map((p) => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has(`${name}${n}`.toLowerCase())) n++;
      name = `${name}${n}`;
    }
    const used = new Set(this.players.map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[this.players.length % COLORS.length];
    const player = { id, name, color, strikes: 0, out: false, connected: true, correct: 0, outOrder: 0 };
    this.players.push(player);
    return { ok: true, player };
  }

  // Lobby: remove entirely. In game: forfeit (counts as eliminated).
  removePlayer(id) {
    const p = this.player(id);
    if (!p) return false;
    if (this.phase === PHASE.LOBBY || this.phase === PHASE.OVER) {
      this.players = this.players.filter((x) => x.id !== id);
      return true;
    }
    if (!p.out) {
      p.out = true;
      p.strikes = this.settings.maxStrikes;
      p.outOrder = ++this.outCounter;
    }
    this.failed.delete(id);
    if (this.currentId === id) {
      this.pending = null;
      this.verdict = null;
      this._advance();
    } else if (this.alive().length <= this._endAt()) {
      this._finish();
    }
    return true;
  }

  canStart() {
    const n = this.players.length;
    return (
      (this.phase === PHASE.LOBBY || this.phase === PHASE.OVER) &&
      n >= this.settings.minPlayers &&
      n <= this.settings.maxPlayers
    );
  }

  // ---------- flow ----------
  start(rng = Math.random) {
    if (!this.canStart()) return false;
    this._resetRound();
    for (const p of this.players) {
      p.strikes = 0;
      p.out = false;
      p.correct = 0;
      p.outOrder = 0;
    }
    const starter = this.players[Math.floor(rng() * this.players.length)];
    this.currentId = starter.id;
    this._newCategory('start');
    return true;
  }

  backToLobby() {
    this.phase = PHASE.LOBBY;
    this._resetRound();
    for (const p of this.players) {
      p.strikes = 0;
      p.out = false;
    }
  }

  // Host pressed "next category" by hand. Same player keeps the turn.
  skipCategory() {
    if (![PHASE.NEWCAT, PHASE.TURN, PHASE.JUDGING].includes(this.phase)) return false;
    this.pending = null;
    this._newCategory('skip');
    return true;
  }

  beginTurn() {
    if (this.phase !== PHASE.NEWCAT) return false;
    this._beginTurn();
    return true;
  }

  submit(playerId, raw) {
    if (this.phase !== PHASE.TURN || playerId !== this.currentId) return { ok: false };
    const text = String(raw ?? '').trim().slice(0, 60);
    const key = normalizeAnswer(text);
    if (!key) return { ok: false };
    const dup = this.answers.find((a) => a.key === key);
    if (dup) {
      this._setVerdict({ pass: false, text, key, reason: `重複了！「${dup.text}」已經有人說過` });
      return { ok: true, judge: false };
    }
    this.phase = PHASE.JUDGING;
    this.pending = { text, key, playerId, turnNo: this.turnNo };
    return {
      ok: true,
      judge: true,
      text,
      turnNo: this.turnNo,
      category: this.category,
      previous: this.answers.map((a) => a.text),
    };
  }

  skip(playerId) {
    if (this.phase !== PHASE.TURN || playerId !== this.currentId) return false;
    this._setVerdict({ pass: false, text: null, reason: '不知道～' });
    return true;
  }

  timeout() {
    if (this.phase !== PHASE.TURN) return false;
    this._setVerdict({ pass: false, text: null, reason: '時間到！', timeout: true });
    return true;
  }

  // Result from AI or host. Ignored if it's for a stale turn.
  judged(turnNo, { pass, reason = '', unsure = false } = {}) {
    if (this.phase !== PHASE.JUDGING || !this.pending || this.pending.turnNo !== turnNo) return false;
    const { text, key } = this.pending;
    this.pending = null;
    this._setVerdict({ pass: !!pass, unsure: !!unsure, reason, text, key });
    return true;
  }

  overrule() {
    if (this.phase !== PHASE.VERDICT || !this.verdict) return false;
    const v = this.verdict;
    v.pass = !v.pass;
    v.overruled = !v.overruled;
    v.eliminates = this._wouldEliminate(v);
    return true;
  }

  commit() {
    if (this.phase !== PHASE.VERDICT || !this.verdict) return false;
    const v = this.verdict;
    const p = this.player(v.playerId);
    if (p) {
      if (v.pass) {
        if (v.text) this.answers.push({ text: v.text, key: v.key || normalizeAnswer(v.text), playerId: p.id });
        p.correct++;
        this.failed.clear();
      } else {
        p.strikes++;
        if (p.strikes >= this.settings.maxStrikes && !p.out) {
          p.out = true;
          p.outOrder = ++this.outCounter;
        }
        this.failed.add(p.id);
      }
    }
    this.lastVerdict = v;
    this.verdict = null;
    this._advance();
    return true;
  }

  // ---------- internals ----------
  _endAt() {
    // Normal games end with one puffer left. Solo dev games end at zero.
    return this.players.length > 1 ? 1 : 0;
  }

  _wouldEliminate(v) {
    const p = this.player(v.playerId);
    return !!p && !v.pass && p.strikes + 1 >= this.settings.maxStrikes;
  }

  _setVerdict(v) {
    this.verdict = { overruled: false, unsure: false, ...v, playerId: this.currentId };
    this.verdict.eliminates = this._wouldEliminate(this.verdict);
    this.phase = PHASE.VERDICT;
  }

  _newCategory(reason) {
    this.category = this.pickCategory();
    this.categoryNo++;
    this.catReason = reason;
    this.answers = [];
    this.failed.clear();
    this.verdict = null;
    this.phase = PHASE.NEWCAT;
  }

  _beginTurn() {
    this.turnNo++;
    this.phase = PHASE.TURN;
  }

  _nextAliveAfter(id) {
    const n = this.players.length;
    const idx = this.players.findIndex((p) => p.id === id);
    for (let i = 1; i <= n; i++) {
      const p = this.players[(idx + i + n) % n];
      if (!p.out) return p;
    }
    return null;
  }

  _finish() {
    const alive = this.alive();
    this.phase = PHASE.OVER;
    this.winnerId = alive.length === 1 ? alive[0].id : null;
    this.currentId = null;
    this.pending = null;
    this.verdict = null;
  }

  _advance() {
    if (this.alive().length <= this._endAt()) return this._finish();
    const next = this._nextAliveAfter(this.currentId);
    this.currentId = next.id;
    // Everyone since the last correct answer got stuck and it's back to
    // someone who already failed on this category -> fresh category.
    if (this.failed.has(next.id)) return this._newCategory('stuck');
    this._beginTurn();
  }

  publicState() {
    return {
      phase: this.phase,
      players: this.players.map(({ id, name, color, strikes, out, connected, correct, outOrder }) => ({
        id, name, color, strikes, out, connected, correct, outOrder,
      })),
      currentId: this.currentId,
      category: this.category,
      categoryNo: this.categoryNo,
      catReason: this.catReason,
      answers: this.answers.map(({ text, playerId }) => ({ text, playerId })),
      pendingText: this.pending ? this.pending.text : null,
      verdict: this.verdict,
      winnerId: this.winnerId,
      turnNo: this.turnNo,
      settings: {
        turnSeconds: this.settings.turnSeconds,
        maxStrikes: this.settings.maxStrikes,
        minPlayers: this.settings.minPlayers,
        maxPlayers: this.settings.maxPlayers,
      },
    };
  }
}
