/* quotes.js — Twelve Data API with Upstash caching
   All visitors read from cache. Cache refreshes every 30 min server-side.
   This way we never exceed the 8 calls/min rate limit. */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TWELVE_KEY    = process.env.TWELVE_DATA_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!TWELVE_KEY) return res.status(500).json({error:'TWELVE_DATA_KEY not set'});

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({error:'Missing symbols param'});

  const syms = symbols.split(',').map(s => s.trim()).slice(0, 20);
  const cacheKey = `mkt_${syms.join('_')}`;

  /* ── Check cache first (30 min TTL) ── */
  const cached = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
  if (cached) return res.status(200).json({results: cached, cached: true});

  /* ── Fetch fresh from Twelve Data ── */
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${syms.join(',')}&apikey=${TWELVE_KEY}`;
    const r = await fetch(url, {signal: AbortSignal.timeout(8000)});
    if (!r.ok) return res.status(502).json({error:'Twelve Data error ' + r.status});

    const data = await r.json();

    const results = syms.map(sym => {
      const q = syms.length === 1 ? data : data[sym];
      if (!q || q.status === 'error' || !q.close) return {sym, error: true};
      const price = parseFloat(q.close);
      const prev  = parseFloat(q.previous_close);
      if (isNaN(price) || isNaN(prev)) return {sym, error: true};
      const chg = price - prev;
      const pct = (chg / prev) * 100;
      return {sym, price, chg, pct, high: parseFloat(q.high), low: parseFloat(q.low), open: parseFloat(q.open), prev};
    });

    /* Cache for 30 minutes */
    await upstashSet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey, results, 30 * 60);

    return res.status(200).json({results});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}

async function upstashGet(url, token, key) {
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${key}`, {headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return null;
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function upstashSet(url, token, key, value, exSeconds) {
  if (!url || !token) return;
  try {
    await fetch(`${url}/set/${key}?EX=${exSeconds}`, {
      method: 'POST',
      headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch {}
}
