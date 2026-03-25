/* quotes.js — Twelve Data API
   Supports real index symbols: SPX, IXIC, DJI
   Free tier: 800 calls/day, 8 calls/min */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const TWELVE_KEY = process.env.TWELVE_DATA_KEY;
  if (!TWELVE_KEY) return res.status(500).json({error:'TWELVE_DATA_KEY not set'});

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({error:'Missing symbols param'});

  const syms = symbols.split(',').map(s => s.trim()).slice(0, 20);

  try {
    /* Twelve Data batch quote — one call for all symbols */
    const url = `https://api.twelvedata.com/quote?symbol=${syms.join(',')}&apikey=${TWELVE_KEY}`;
    const r = await fetch(url, {signal: AbortSignal.timeout(8000)});
    if (!r.ok) return res.status(502).json({error:'Twelve Data error ' + r.status});

    const data = await r.json();

    /* If single symbol, Twelve Data returns object directly (not wrapped) */
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

    return res.status(200).json({results});
  } catch(e) {
    return res.status(500).json({error: e.message});
  }
}
