export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY  = process.env.NEWS_API_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });

  const dateKey  = getETDateKey();
  const cacheKey = `brief_v2_${dateKey}`;

  /* ── GET: return today's cached brief ── */
  if (req.method === 'GET') {
    const cached = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
    if (cached) {
      await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
      return res.status(200).json(cached);
    }
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  /* ── POST: return cached if exists, otherwise generate ── */
  const existing = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
  if (existing) {
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
    return res.status(200).json(existing);
  }

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  /* ── Fetch headlines ── */
  const headlines = await fetchHeadlines(NEWS_API_KEY);

  /* ── Today's date label in ET ── */
  const dateLabel = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  try {
    const fullPrompt = `${prompt}

TODAY'S DATE (ET): ${dateLabel}

LATEST HEADLINES (last 24 hours):
${headlines}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1400,
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({ error: 'Anthropic error', detail: err.slice(0, 400) });
    }

    const data = await r.json();
    const text = data?.content?.find(b => b.type === 'text')?.text || '';
    if (!text) return res.status(500).json({ error: 'Empty model response' });

    let brief;
    try {
      brief = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      return res.status(500).json({ error: 'Invalid JSON from model', detail: text.slice(0, 700) });
    }

    const archivedBrief = { dateKey, ...brief };
    await upstashSet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey, archivedBrief);
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);

    return res.status(200).json(archivedBrief);
  } catch (e) {
    return res.status(500).json({ error: 'Generation failed', detail: e.message });
  }
}

/* ── Fetch strongest market-relevant headlines ── */
async function fetchHeadlines(newsApiKey) {
  if (!newsApiKey) return '(News headlines unavailable — NEWS_API_KEY not set)';

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    /* Top business + broader market / macro / geopolitical query */
    const [r1, r2] = await Promise.all([
      fetch(
        `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${newsApiKey}`,
        { signal: ctrl.signal }
      ),
      fetch(
        `https://newsapi.org/v2/everything?q=${encodeURIComponent(
          'markets OR "stock market" OR "federal reserve" OR inflation OR tariffs OR trump OR bitcoin OR crypto OR "oil prices" OR geopolitics OR war OR conflict OR sanctions OR earnings OR economy OR "interest rates" OR stocks OR rally OR selloff'
        )}&language=en&sortBy=publishedAt&pageSize=50&apiKey=${newsApiKey}`,
        { signal: ctrl.signal }
      )
    ]);

    clearTimeout(timer);

    const [d1, d2] = await Promise.all([
      r1.ok ? r1.json() : { articles: [] },
      r2.ok ? r2.json() : { articles: [] }
    ]);

    const seen = new Set();
    const all = [...(d1.articles || []), ...(d2.articles || [])];

    function normalizeTitle(title) {
      return String(title || '')
        .toLowerCase()
        .replace(/\W+/g, '')
        .slice(0, 80);
    }

    function score(article) {
      const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
      let s = 0;

      // Macro / Fed / rates / economy
      if (/fed|federal reserve|inflation|rates|interest rates|cpi|jobs|recession|gdp|economy/.test(text)) s += 5;

      // Geopolitics / wars / sanctions
      if (/war|conflict|geopolitics|geopolitical|military|tensions|sanctions/.test(text)) s += 5;

      // Energy / oil
      if (/oil|energy|opec|crude/.test(text)) s += 4;

      // Policy / politics / trade
      if (/trump|white house|tariffs|trade|policy|congress/.test(text)) s += 4;

      // Markets / stocks
      if (/stocks|equities|market|selloff|rally|treasury yields|bond market/.test(text)) s += 3;

      // Crypto
      if (/bitcoin|crypto/.test(text)) s += 3;

      // Company news
      if (/earnings|deal|acquisition|merger/.test(text)) s += 2;

      // Recent items get a boost
      const ageHours = (Date.now() - new Date(article.publishedAt)) / 1000 / 60 / 60;
      if (ageHours < 2) s += 2;
      if (ageHours < 1) s += 2;

      return s;
    }

    const ranked = all
      .filter(a => a?.title && a.title !== '[Removed]')
      .filter(a => {
        const key = normalizeTitle(a.title);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => {
        const diff = score(b) - score(a);
        if (diff !== 0) return diff;
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      })
      .slice(0, 30);

    if (!ranked.length) return '(No headlines found)';

    return ranked.map(a => {
      const src = a.source?.name || 'Unknown';
      const desc = a.description ? ` — ${a.description.slice(0, 140)}` : '';
      return `• ${a.title}${desc} [${src}]`;
    }).join('\n');
  } catch {
    return '(News fetch failed)';
  }
}

function getETDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

async function upstashGet(url, token, key) {
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.result) return null;
    const parsed = JSON.parse(d.result);
    return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
  } catch { return null; }
}

async function upstashSet(url, token, key, value) {
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  } catch {}
}

async function addToArchiveIndex(url, token, dateKey) {
  const indexKey = 'brief_archive_index';
  const current  = (await upstashGet(url, token, indexKey)) || [];
  const next     = [dateKey, ...current.filter(d => d !== dateKey)].slice(0, 120);
  await upstashSet(url, token, indexKey, next);
}
