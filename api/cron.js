export default async function handler(req, res) {
  const SITE_URL = process.env.SITE_URL || `https://${req.headers.host}`;

  try {
    const getRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });

    if (getRes.status === 200) {
      return res.status(200).json({ ok: true, cached: true });
    }

    const prompt = `You are the editor of Mkt Brief, a daily market briefing for general readers. 
    Before writing, mentally rank all available stories by likely market impact and general importance, then write only from the top-ranked themes.

Your job is to write the ONE most relevant market brief of the day in clear, simple, intelligent language.

IMPORTANT PRIORITY:
Choose the biggest story or stories actually driving markets and investor attention today.
Do not lead with minor or niche business stories unless they are clearly the main market-moving development.

Focus first on the topics most likely to matter to a broad audience and to financial markets, such as:
- major geopolitical events, including the Middle East, war, energy shocks, or global conflict
- major U.S. political actions, including Trump, the White House, Congress, tariffs, trade, or regulation
- the Fed, rates, inflation, jobs, consumer spending, recession risk, and major macro data
- major stock market moves
- major crypto moves
- major company news only if it is genuinely one of the biggest stories of the day

WRITING STYLE:
- write for an average reader, not a finance professional
- keep the tone smart, calm, direct, and modern
- avoid jargon where possible
- if you use a financial term, explain it simply
- prefer short, clear sentences
- sound like a sharp morning news editor, not a robot
- do not exaggerate
- do not make up facts, quotes, or events
- do not include quotes from named people
- only use what is supported by the provided headlines and market data

EDITORIAL RULES:
- rank the day’s news by importance before writing
- lead with the biggest and most market-relevant development
- if geopolitical risk, oil, rates, Fed policy, tariffs, or a major political development is the dominant story, make that the headline and lead
- if a niche story is less important than a broader macro or geopolitical theme, mention it later or leave it out
- do not force equal attention to every headline
- it is better to cover 2–4 important themes well than 6 weak ones badly

LIVE MARKET DATA:
${mktLines}

TODAY'S NEWS HEADLINES:
${headlines}

Return ONLY valid JSON with no markdown or extra text:
{
  "headline": "short, strong headline, max 12 words",
  "deck": "one clear sentence that sums up the day",
  "intro": "3-4 sentence opening paragraph explaining the main market story in simple language",
  "macro": "one paragraph on the main big-picture forces moving markets today",
  "events": "one paragraph on the most important company, political, economic, or crypto developments worth knowing",
  "movers": [
    {"sym":"SPY","name":"S&P 500","dir":"up","pct":"0.4"},
    {"sym":"BTC","name":"Bitcoin","dir":"up","pct":"1.2"}
  ],
  "close": "one short paragraph on what readers should watch next",
  "sources": ["list", "of", "source", "names", "used"]
}`;

    const postRes = await fetch(`${SITE_URL}/api/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    const data = await postRes.json().catch(() => ({}));

    if (!postRes.ok) {
      return res.status(500).json({
        ok: false,
        error: 'Brief generation failed',
        detail: data
      });
    }

    return res.status(200).json({ ok: true, generated: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
