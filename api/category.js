// POST /api/category { exclude: string[] } -> { categories: string[] }
import { askClaude, extractJSON, clip, readBody, sameOrigin, hasKey } from './_anthropic.js';

const SYSTEM = `You write categories for a fast party word game played by friends in Taiwan.
Players take turns naming one thing that fits the category, with only a few seconds each, until nobody can think of more.

Good categories:
- have MANY valid answers (at least 30), so a group of 8 can go around several times;
- are fact-checkable by an AI referee;
- can be answered in a few words;
- mix topics: pop culture, music, food, Taiwan life, geography, sports (baseball is popular), science, brands, language games;
- sometimes include a factual condition, like "YouTube 點擊量 50 萬以上的華語歌" or "1990 年後成立的公司".

Write each category in Traditional Chinese (繁體中文), 20 characters or fewer.
Reply with ONLY JSON: {"categories":["...", "..."]} containing 8 new categories.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden origin' });
  if (!hasKey()) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set' });

  const body = readBody(req);
  const exclude = Array.isArray(body.exclude) ? body.exclude.slice(-60).map((x) => clip(x, 60)).filter(Boolean) : [];
  const user = exclude.length
    ? `Already used (do not repeat or closely copy these):\n${exclude.map((e) => `- ${e}`).join('\n')}`
    : 'Give me 8 categories.';

  try {
    const text = await askClaude({ system: SYSTEM, user, maxTokens: 500, timeoutMs: 15000 });
    const j = extractJSON(text);
    const categories = (Array.isArray(j.categories) ? j.categories : [])
      .map((c) => clip(c, 40))
      .filter(Boolean)
      .slice(0, 10);
    return res.status(200).json({ categories });
  } catch (err) {
    console.error('category error', err);
    return res.status(502).json({ error: String(err.message || err) });
  }
}
