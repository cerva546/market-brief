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

  /* Check Upstash cache first (30 min TTL) */
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const r = await fetch(`${UPSTASH_URL}/get/${cacheKey}`, {
        headers: {Authorization: `Bearer ${UPSTASH_TOKEN}`}
      });
      if (r.ok) {
        const d = await r.json();
        if (d.result) {
          /* Parse once — stored as JSON string */
          const cached = JSON.parse(d.result);
          return res.status(200).json({results: cached, cached: true});
        }
      }
    } catch {}
  }

  /* Fetch fresh from Twelve Data */
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

    /* Cache for 30 min — store as single JSON string */
    if (UPSTASH_URL && UPSTASH_TOKEN) {
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
