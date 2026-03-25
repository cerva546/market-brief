export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FINNHUB_KEY   = process.env.FINNHUB_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY not set' });
  }

  const { symbols } = req.query;
  if (!symbols) {
    return res.status(400).json({ error: 'Missing symbols param' });
  }

  const syms = symbols.split(',').map(s => s.trim().toUpperCase()).slice(0, 20);
  const cacheKey = `mkt_v4_${[...syms].sort().join('_')}`;

  let cached = null;

  // Read cache first and RETURN IT immediately if available
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${cacheKey}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });

      if (r.ok) {
        const d = await r.json();
        if (d.result) {
          cached = JSON.parse(d.result);

          // support old cache format
          if (Array.isArray(cached)) {
            cached = {
              updatedAt: null,
              results: cached
            };
          }

          if (cached?.results?.length) {
            const hasData = cached.results.some(q => !q.error && q.price);
            if (hasData) {
              return res.status(200).json({
                results: cached.results,
                cached: true,
                updatedAt: cached.updatedAt || null
              });
            }
          }
        }
      }
    } catch {}
  }

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

    let merged = fresh;

    if (cached?.results && Array.isArray(cached.results)) {
      const cachedMap = Object.fromEntries(cached.results.map(q => [q.sym, q]));
      merged = fresh.map(q => {
        if (!q.error) return q;
        return cachedMap[q.sym] || q;
      });
    }

    const hasData = merged.some(q => !q.error && q.price);
    const payload = {
      updatedAt: new Date().toISOString(),
      results: merged
    };

    if (hasData && UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        await fetch(`${UPSTASH_URL}/set/${cacheKey}?EX=${30 * 60}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(JSON.stringify(payload))
        });
      } catch {}
    }

    return res.status(200).json({
      results: merged,
      cached: false,
      updatedAt: payload.updatedAt
    });
  } catch (e) {
    if (cached?.results) {
      return res.status(200).json({
        results: cached.results,
        cached: true,
        stale: true,
        updatedAt: cached.updatedAt || null
      });
    }

    return res.status(500).json({ error: e.message });
  }
}
