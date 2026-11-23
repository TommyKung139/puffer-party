import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ANTHROPIC_API_KEY = 'x';
const keep = setInterval(() => {}, 1000); test.after(() => clearInterval(keep));
const { askClaude } = await import('../api/_anthropic.js');
const judge = (await import('../api/judge.js')).default;

function mockFetch(seq) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body); seen.push(body.model);
    const step = seq.shift();
    if (step === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
    const [status, extra = {}] = step;
    const headers = new Headers({ 'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '41', ...(extra.headers || {}) });
    const text = extra.text ?? JSON.stringify({ content: [{ type: 'text', text: '{"verdict":"pass","reason":"對"}' }] });
    return new Response(text, { status, headers });
  };
  return seen;
}
const res = () => ({ status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } });
const req = (body) => ({ method: 'POST', headers: { origin: 'https://a.vercel.app', host: 'a.vercel.app' }, body });

test('429 then success, honors retry-after', async () => {
  const seen = mockFetch([[429, { headers: { 'retry-after': '1' }, text: '{}' }], [200]]);
  const t = Date.now(); const r = await askClaude({ system: 's', user: 'u' });
  assert.equal(r.attempts, 2); assert.ok(Date.now() - t >= 950); assert.equal(seen.length, 2);
  assert.deepEqual(r.rateLimit, { limit: 50, remaining: 41 });
});
test('overloaded twice -> fallback model', async () => {
  const seen = mockFetch([[529, { text: '{}' }], [529, { text: '{}' }], [200]]);
  const r = await askClaude({ system: 's', user: 'u' });
  assert.deepEqual(seen, ['claude-haiku-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5']); assert.equal(r.model, 'claude-sonnet-5-5');
});
test('bad key fails fast as auth', async () => {
  const seen = mockFetch([[401, { text: '{"error":"invalid x-api-key"}' }]]);
  const r = res(); await judge(req({ category: 'c', answer: 'a' }), r);
  assert.equal(r.code, 401); assert.equal(r.body.kind, 'auth'); assert.equal(seen.length, 1);
});
test('no credit detected', async () => {
  mockFetch([[400, { text: '{"error":{"message":"Your credit balance is too low"}}' }]]);
  const r = res(); await judge(req({ category: 'c', answer: 'a' }), r);
  assert.equal(r.body.kind, 'credit');
});
test('hanging request stays within budget', async () => {
  mockFetch(['hang', 'hang', 'hang']);
  const t = Date.now();
  await assert.rejects(askClaude({ system: 's', user: 'u', budgetMs: 3000 }));
  assert.ok(Date.now() - t < 3500, `took ${Date.now() - t}`);
});
test('judge happy path returns verdict + rate limit', async () => {
  mockFetch([[200]]);
  const r = res(); await judge(req({ category: 'c', answer: 'a', previous: [] }), r);
  assert.equal(r.code, 200); assert.equal(r.body.verdict, 'pass'); assert.equal(r.body.rateLimit.limit, 50);
});
