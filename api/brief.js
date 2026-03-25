export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY  = process.env.NEWS_API_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });
  }

  const dateKey = getETDateKey();
  const cacheKey = `brief_v2_${dateKey}`;

  if (req.method === 'GET') {
  const cached = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
  if (cached) {
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
    return res.status(200).json(cached);
  }
  return res.status(204).end();
}

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const existing = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
if (existing) {
  await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
  return res.status(200).json(existing);
}

  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  let headlines = '(News headlines unavailable)';
  if (NEWS_API_KEY) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);

      const r = await fetch(
        `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${NEWS_API_KEY}`,
        { signal: ctrl.signal }
      );

      clearTimeout(timer);

      if (r.ok) {
        const d = await r.json();
        headlines = (d.articles || [])
          .slice(0, 15)
          .map(a => `• ${a.title}${a.description ? ' — ' + a.description.slice(0, 100) : ''} [${a.source?.name || 'Unknown'}]`)
          .join('\n');

        if (!headlines.trim()) headlines = '(News headlines unavailable)';
      }
    } catch {}
  }

  try {
    const fullPrompt = `${prompt}\n\nTODAY'S NEWS HEADLINES:\n${headlines}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({
        error: 'Anthropic error',
        detail: err.slice(0, 300)
      });
    }

    const data = await r.json();
    const text = data?.content?.find(b => b.type === 'text')?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'Empty model response' });
    }

    let brief;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      brief = JSON.parse(clean);
    } catch {
      return res.status(500).json({
        error: 'Invalid JSON from model',
        detail: text.slice(0, 500)
      });
    }

    const archivedBrief = {
      dateKey,
      ...brief
    };

    // save the daily brief without expiration
    await upstashSet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey, archivedBrief);

    // update archive index
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);

    return res.status(200).json(archivedBrief);
  } catch (e) {
    return res.status(500).json({
      error: 'Generation failed',
      detail: e.message
    });
  }
}

function getETDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  return `${y}-${m}-${d}`;
}

async function upstashGet(url, token, key) {
  if (!url || !token) return null;

  try {
    const r = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;

    const d = await r.json();
    if (!d.result) return null;

    const parsed = JSON.parse(d.result);
    if (typeof parsed === 'string') return JSON.parse(parsed);
    return parsed;
  } catch {
    return null;
  }
}

async function upstashSet(url, token, key, value, exSeconds = null) {
  if (!url || !token) return;

  const suffix = exSeconds ? `?EX=${exSeconds}` : '';

  try {
    await fetch(`${url}/set/${key}${suffix}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
  } catch {}
}

async function addToArchiveIndex(url, token, dateKey) {
  const indexKey = 'brief_archive_index';
  const current = (await upstashGet(url, token, indexKey)) || [];

  const next = [dateKey, ...current.filter(d => d !== dateKey)].slice(0, 90);
  await upstashSet(url, token, indexKey, next);
}
