export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FINNHUB_KEY   = process.env.FINNHUB_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!FINNHUB_KEY) return res.status(500).json({ error: 'FINNHUB_KEY not set' });

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'Missing symbols param' });

  const syms = symbols.split(',').map(s => s.trim().toUpperCase()).slice(0, 20);
  const cacheKey = `mkt_v3_${[...syms].sort().join('_')}`;

  let cached = null;

  // Read cache first
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${cacheKey}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      if (r.ok) {
        const d = await r.json();
        if (d.result) {
          cached = JSON.parse(d.result);
        }
      }
    } catch {}
  }

  // helper: small delay to avoid hammering Finnhub
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function fetchQuote(sym) {
    try {
      const r = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`,
        { signal: AbortSignal.timeout(6000) }
      );

      if (!r.ok) return { sym, error: true };

      const d = await r.json();
      if (!d.c || d.c === 0 || !d.pc) return { sym, error: true };

      const price = d.c;
      const prev = d.pc;
      const chg = price - prev;
      const pct = (chg / prev) * 100;

      return {
        sym,
        price,
        chg,
        pct,
        high: d.h,
        low: d.l,
        open: d.o,
        prev
      };
    } catch {
      return { sym, error: true };
    }
  }

  try {
    // Fetch in small batches instead of all at once
    const fresh = [];
    const batchSize = 3;

    for (let i = 0; i < syms.length; i += batchSize) {
      const batch = syms.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(fetchQuote));
      fresh.push(...batchResults);

      if (i + batchSize < syms.length) {
        await sleep(350);
      }
    }

    // If cache exists, fill failed fresh symbols with cached values
    let merged = fresh;
    if (cached && Array.isArray(cached)) {
      const cachedMap = Object.fromEntries(cached.map(q => [q.sym, q]));
      merged = fresh.map(q => {
        if (!q.error) return q;
        return cachedMap[q.sym] || q;
      });
    }

    const hasData = merged.some(q => !q.error && q.price);

    // Save merged results back to cache
    if (hasData && UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        await fetch(`${UPSTASH_URL}/set/${cacheKey}?EX=${30 * 60}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(JSON.stringify(merged))
        });
      } catch {}
    }

    return res.status(200).json({ results: merged });
  } catch (e) {
    // fall back to cache if available
    if (cached) {
      return res.status(200).json({ results: cached, cached: true, stale: true });
    }
    return res.status(500).json({ error: e.message });
  }
}
