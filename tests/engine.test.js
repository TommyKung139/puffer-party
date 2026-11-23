import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, PHASE, normalizeAnswer } from '../js/engine.js';

function setup(n = 4, extra = {}) {
  let c = 0;
  const e = new Engine({ pickCategory: () => `cat${++c}`, ...extra });
  for (let i = 0; i < n; i++) e.addPlayer(`p${i}`, `P${i}`);
  return e;
}
const first = () => 0; // rng -> always player 0 starts

function failTurn(e) {
  assert.equal(e.phase, PHASE.TURN);
  e.timeout();
  e.commit();
}
function passTurn(e, text) {
  assert.equal(e.phase, PHASE.TURN);
  const r = e.submit(e.currentId, text);
  assert.ok(r.judge);
  e.judged(r.turnNo, { pass: true });
  e.commit();
}

test('needs 4-8 players', () => {
  const e = setup(3);
  assert.equal(e.canStart(), false);
  e.addPlayer('p3', 'P3');
  assert.equal(e.canStart(), true);
  for (let i = 4; i < 8; i++) e.addPlayer(`p${i}`, `P${i}`);
  assert.equal(e.addPlayer('p9', 'late').ok, false);
});

test('random starter, then turns go in order', () => {
  const e = setup(4);
  e.start(() => 0.6); // index 2
  assert.equal(e.currentId, 'p2');
  assert.equal(e.phase, PHASE.NEWCAT);
  e.beginTurn();
  passTurn(e, 'a');
  assert.equal(e.currentId, 'p3');
  passTurn(e, 'b');
  assert.equal(e.currentId, 'p0');
});

test('3 strikes and you are out; out players are skipped', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  // p0 fails, others pass, three laps
  for (let lap = 0; lap < 3; lap++) {
    failTurn(e);
    passTurn(e, `x${lap}a`);
    passTurn(e, `x${lap}b`);
    passTurn(e, `x${lap}c`);
  }
  assert.equal(e.player('p0').out, true);
  assert.equal(e.player('p0').strikes, 3);
  assert.equal(e.currentId, 'p1');
});

test('whole lap of failures -> new category for the player it came back to', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  assert.equal(e.categoryNo, 1);
  failTurn(e); // p0
  failTurn(e); // p1
  failTurn(e); // p2
  failTurn(e); // p3 -> back to p0 who already failed
  assert.equal(e.phase, PHASE.NEWCAT);
  assert.equal(e.catReason, 'stuck');
  assert.equal(e.categoryNo, 2);
  assert.equal(e.currentId, 'p0');
  assert.equal(e.answers.length, 0);
});

test('a correct answer resets the stuck streak', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  failTurn(e); // p0
  failTurn(e); // p1
  passTurn(e, 'ok'); // p2
  failTurn(e); // p3
  assert.equal(e.phase, PHASE.TURN); // back to p0, no new category
  assert.equal(e.currentId, 'p0');
  assert.equal(e.categoryNo, 1);
});

test('stuck streak still works when the first failer got eliminated', () => {
  const e = setup(4);
  e.start(first);
  e.player('p0').strikes = 2;
  e.beginTurn();
  failTurn(e); // p0 out
  failTurn(e); // p1
  failTurn(e); // p2
  failTurn(e); // p3 -> next alive is p1, who already failed
  assert.equal(e.player('p0').out, true);
  assert.equal(e.phase, PHASE.NEWCAT);
  assert.equal(e.currentId, 'p1');
});

test('duplicates fail without the judge, including spacing/case variants', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  passTurn(e, '周杰倫 晴天');
  const r = e.submit('p1', '周杰倫晴天！');
  assert.equal(r.judge, false);
  assert.equal(e.phase, PHASE.VERDICT);
  assert.equal(e.verdict.pass, false);
  assert.equal(normalizeAnswer('Hello, World'), normalizeAnswer('hello world'));
});

test('only the current player can answer, and stale judge results are ignored', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  assert.equal(e.submit('p1', 'nope').ok, false);
  const r = e.submit('p0', 'yes');
  e.skipCategory();
  assert.equal(e.judged(r.turnNo, { pass: true }), false);
});

test('overrule flips the verdict and the elimination preview', () => {
  const e = setup(4);
  e.start(first);
  e.player('p0').strikes = 2;
  e.beginTurn();
  const r = e.submit('p0', 'x');
  e.judged(r.turnNo, { pass: false });
  assert.equal(e.verdict.eliminates, true);
  e.overrule();
  assert.equal(e.verdict.pass, true);
  assert.equal(e.verdict.eliminates, false);
  e.commit();
  assert.equal(e.player('p0').out, false);
  assert.equal(e.answers.length, 1);
});

test('game ends with one puffer left', () => {
  const e = setup(4);
  e.start(first);
  for (const id of ['p1', 'p2', 'p3']) e.player(id).strikes = 2;
  e.beginTurn();
  passTurn(e, 'a'); // p0
  failTurn(e); // p1 out
  failTurn(e); // p2 out
  failTurn(e); // p3 out
  assert.equal(e.phase, PHASE.OVER);
  assert.equal(e.winnerId, 'p0');
});

test('kicking the current player mid-game moves on', () => {
  const e = setup(4);
  e.start(first);
  e.beginTurn();
  e.removePlayer('p0');
  assert.equal(e.player('p0').out, true);
  assert.equal(e.currentId, 'p1');
  assert.equal(e.phase, PHASE.TURN);
});

test('rematch resets strikes', () => {
  const e = setup(4);
  e.start(first);
  e.player('p1').strikes = 2;
  e.phase = PHASE.OVER;
  assert.ok(e.start(first));
  assert.equal(e.player('p1').strikes, 0);
});
