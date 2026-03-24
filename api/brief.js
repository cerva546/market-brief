export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY  = process.env.NEWS_API_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({error:'ANTHROPIC_KEY not set in Vercel env vars'});

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({error:'Missing prompt'});

  /* Fetch news with a strict 5s timeout so it never blocks the brief */
  let headlines = '(News headlines unavailable)';
  if (NEWS_API_KEY) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(
        `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${NEWS_API_KEY}`,
        {signal: ctrl.signal}
      );
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        const articles = d.articles || [];
        headlines = articles.slice(0, 15).map(a =>
          `• ${a.title}${a.description ? ' — ' + a.description.slice(0,100) : ''} [${a.source?.name||'Unknown'}]`
        ).join('\n');
      }
    } catch(e) {
      headlines = '(News fetch timed out — brief based on market data only)';
    }
  }

  /* Call Anthropic */
  try {
    const fullPrompt = prompt + '\n\nTODAY\'S NEWS HEADLINES:\n' + headlines;
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
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

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      return res.status(502).json({error:'Anthropic API error', detail: err.slice(0,200)});
    }

    const data = await anthropicRes.json();
    const text = data?.content?.find(b => b.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    return res.status(200).json(json);
  } catch(e) {
    return res.status(500).json({error: 'Brief generation failed', detail: e.message});
  }
}
