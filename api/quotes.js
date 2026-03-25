export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FINNHUB_KEY   = process.env.FINNHUB_KEY;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!FINNHUB_KEY) return res.status(500).json({error:'FINNHUB_KEY not set'});

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({error:'Missing symbols param'});

  const syms = symbols.split(',').map(s => s.trim()).slice(0, 20);
  const cacheKey = `mkt_v2_${syms.sort().join('_')}`;

  /* Check Upstash cache (30 min TTL) */
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${cacheKey}`, {
        headers: {Authorization: `Bearer ${UPSTASH_TOKEN}`}
      });
      if (r.ok) {
        const d = await r.json();
        if (d.result) {
          const cached = JSON.parse(d.result);
          /* Only use cache if it has valid data (no all-error entries) */
          const hasData = cached.some(q => !q.error && q.price);
          if (hasData) return res.status(200).json({results: cached, cached: true});
        }
      }
    } catch {}
  }

  /* Fetch fresh from Finnhub — one call per symbol in parallel */
  try {
    const results = await Promise.all(syms.map(async sym => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`,
          {signal: AbortSignal.timeout(6000)}
        );
        if (!r.ok) return {sym, error: true};
        const d = await r.json();
        if (!d.c || d.c === 0) return {sym, error: true};
        const price = d.c;
        const prev  = d.pc;
        const chg   = price - prev;
        const pct   = (chg / prev) * 100;
        return {sym, price, chg, pct, high: d.h, low: d.l, open: d.o, prev};
      } catch { return {sym, error: true}; }
    }));

    /* Only cache if we got real data */
    const hasData = results.some(q => !q.error && q.price);
    if (hasData && UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        await fetch(`${UPSTASH_URL}/set/${cacheKey}?EX=${30 * 60}`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json'},
          body: JSON.stringify(JSON.stringify(results))
        });
      } catch {}
    }

    return res.status(200).json({results});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
