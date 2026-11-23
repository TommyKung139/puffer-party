// Shared helpers for the API routes. Files starting with "_" are not deployed as routes on Vercel.

export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
// Used when the main model keeps failing (overloaded / rate limited).
// Rate limits are per model, so a second model is a separate "lane".
// Set ANTHROPIC_FALLBACK_MODEL=none to disable.
export const FALLBACK_MODEL = process.env.ANTHROPIC_FALLBACK_MODEL === 'none'
  ? null
  : (process.env.ANTHROPIC_FALLBACK_MODEL || 'claude-sonnet-5-5');

export function hasKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AIError extends Error {
  constructor(message, { status = 0, kind = 'other', retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // auth | credit | rate | overloaded | model | timeout | network | other
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function classify(status, bodyText, headers) {
  const ra = Number(headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : null;
  const msg = bodyText.slice(0, 300);
  if (status === 401 || status === 403) return new AIError(msg, { status, kind: 'auth' });
  if (status === 400 && /credit|balance|billing/i.test(bodyText)) return new AIError(msg, { status, kind: 'credit' });
  if (status === 404) return new AIError(msg, { status, kind: 'model' });
  if (status === 429) return new AIError(msg, { status, kind: 'rate', retryable: true, retryAfterMs });
  if (status === 529 || status === 503) return new AIError(msg, { status, kind: 'overloaded', retryable: true, retryAfterMs });
  if (status >= 500) return new AIError(msg, { status, kind: 'other', retryable: true, retryAfterMs });
  return new AIError(msg, { status, kind: 'other' });
}

async function callOnce({ model, system, user, maxTokens, timeoutMs }) {
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AIError(String(err && err.message), { kind: timeout ? 'timeout' : 'network', retryable: true });
  }
  if (!r.ok) throw classify(r.status, await r.text(), r.headers);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const limit = Number(r.headers.get('anthropic-ratelimit-requests-limit'));
  const remaining = Number(r.headers.get('anthropic-ratelimit-requests-remaining'));
  return {
    text,
    model,
    rateLimit: Number.isFinite(limit) && limit > 0 ? { limit, remaining: Number.isFinite(remaining) ? remaining : null } : null,
  };
}

// Retries transient failures (rate limit, overloaded, 5xx, network) with backoff,
// switches to the fallback model after repeated failures, and never runs past budgetMs.
export async function askClaude({ system, user, maxTokens = 300, budgetMs = 8000 }) {
  const start = Date.now();
  const left = () => budgetMs - (Date.now() - start);
  let attempt = 0;
  let lastErr = null;
  while (left() > 400) {
    const useFallback = FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && (attempt >= 2 || (lastErr && lastErr.kind === 'model'));
    const model = useFallback ? FALLBACK_MODEL : MODEL;
    try {
      const res = await callOnce({ model, system, user, maxTokens, timeoutMs: Math.min(left(), 5000) });
      res.attempts = attempt + 1;
      return res;
    } catch (err) {
      lastErr = err instanceof AIError ? err : new AIError(String(err), { retryable: true });
      const canRetry = lastErr.retryable || (lastErr.kind === 'model' && !useFallback && FALLBACK_MODEL);
      if (!canRetry) throw lastErr;
      attempt++;
      const backoff = lastErr.retryAfterMs ?? Math.min(250 * 2 ** attempt, 1500);
      const wait = Math.min(backoff, left() - 600);
      if (wait < 0) break;
      await sleep(wait);
    }
  }
  throw lastErr || new AIError('out of time', { kind: 'timeout' });
}

export function extractJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new AIError('no JSON in model reply', { kind: 'other' });
  return JSON.parse(m[0]);
}

export function clip(v, n) {
  return typeof v === 'string' ? v.trim().slice(0, n) : '';
}

export function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export function sendAIError(res, err) {
  const kind = (err && err.kind) || 'other';
  const status = kind === 'rate' ? 429 : kind === 'auth' || kind === 'credit' ? 401 : 502;
  return res.status(status).json({ error: String((err && err.message) || err).slice(0, 300), kind });
}

// Light protection so random sites can't spend your API credits through this endpoint.
// (Not bulletproof — anyone can fake the header with curl. Set a spend limit in the Claude Console too.)
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
