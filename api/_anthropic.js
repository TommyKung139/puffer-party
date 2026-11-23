// Shared helpers for the API routes. Files starting with "_" are not deployed as routes on Vercel.

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function askClaude({ system, user, maxTokens = 300, timeoutMs = 8000 }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export function extractJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON in model reply');
  return JSON.parse(m[0]);
}

export function clip(v, n) {
  return typeof v === 'string' ? v.trim().slice(0, n) : '';
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

// Light protection so random sites can't spend your API credits through this endpoint.
// (Not bulletproof — anyone can fake the header with curl. Set a spend limit in the Anthropic console too.)
export function sameOrigin(req) {
  if (process.env.ALLOW_ANY_ORIGIN === '1') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
