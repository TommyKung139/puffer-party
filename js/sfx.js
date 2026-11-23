// Tiny Web Audio sound effects, no files needed.
let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, { dur = 0.12, type = 'sine', vol = 0.18, delay = 0, slide = 0 } = {}) {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.03);
}

export const sfx = {
  unlock: () => ac(),
  get muted() { return muted; },
  toggleMute() { muted = !muted; return muted; },
  join() { tone(520, { dur: 0.08 }); tone(780, { dur: 0.1, delay: 0.07 }); },
  turn() { tone(440, { dur: 0.06, type: 'triangle', vol: 0.12 }); },
  tick(sec) { tone(sec === 1 ? 990 : 760, { dur: 0.07, type: 'square', vol: 0.07 }); },
  pass() { [660, 880, 1320].forEach((f, i) => tone(f, { dur: 0.14, type: 'triangle', delay: i * 0.08 })); },
  fail() { tone(220, { dur: 0.35, type: 'sawtooth', vol: 0.13, slide: -110 }); },
  pop() {
    tone(180, { dur: 0.5, type: 'sawtooth', vol: 0.15, slide: -140 });
    tone(1200, { dur: 0.08, type: 'square', vol: 0.12, delay: 0.02, slide: -900 });
  },
  newcat() { [392, 523, 659, 784].forEach((f, i) => tone(f, { dur: 0.12, type: 'triangle', delay: i * 0.07 })); },
  win() { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, { dur: 0.18, type: 'triangle', delay: i * 0.12 })); },
};
