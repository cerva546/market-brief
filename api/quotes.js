export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FINNHUB_KEY = process.env.FINNHUB_KEY;
  if (!FINNHUB_KEY) return res.status(500).json({error:'FINNHUB_KEY not set'});

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({error:'Missing symbols param'});

  const syms = symbols.split(',').slice(0, 20); // max 20 at once

  try {
    const results = await Promise.all(syms.map(async sym => {
      try {
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym.trim())}&token=${FINNHUB_KEY}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (!r.ok) return { sym, error: true };
        const d = await r.json();
        if (!d.c || d.c === 0) return { sym, error: true };
        return {
          sym,
          price: d.c,
          chg:   d.c - d.pc,
          pct:   ((d.c - d.pc) / d.pc) * 100,
          high:  d.h,
          low:   d.l,
          open:  d.o,
          prev:  d.pc
        };
      } catch { return { sym, error: true }; }
    }));

    return res.status(200).json({ results });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
