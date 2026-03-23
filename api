export default async function handler(req, res) {
  /* CORS — allow your site to call this */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY  = process.env.NEWS_API_KEY;
  const FINNHUB_KEY   = process.env.FINNHUB_KEY;

  if (!ANTHROPIC_KEY) return res.status(500).json({error:'ANTHROPIC_KEY not set in Vercel env vars'});

  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({error:'Missing prompt'});

  /* Fetch news headlines server-side (NewsAPI blocks browsers) */
  let headlines = '(News headlines unavailable)';
  if (NEWS_API_KEY) {
    try {
      const [topRes, finRes] = await Promise.all([
        fetch(`https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=15&apiKey=${NEWS_API_KEY}`),
        fetch(`https://newsapi.org/v2/everything?q=stock+market+federal+reserve+economy&language=en&sortBy=publishedAt&pageSize=10&apiKey=${NEWS_API_KEY}`)
      ]);
      const topData = topRes.ok ? await topRes.json() : {articles:[]};
      const finData = finRes.ok ? await finRes.json() : {articles:[]};
      const all = [...(topData.articles||[]), ...(finData.articles||[])];
      const seen = new Set();
      headlines = all
        .filter(a => { if (!a.title || seen.has(a.title)) return false; seen.add(a.title); return true; })
        .slice(0, 20)
        .map(a => `• ${a.title}${a.description ? ' — ' + a.description.slice(0,120) : ''} [${a.source?.name||'Unknown'}, ${a.publishedAt?.slice(0,10)}]`)
        .join('\n');
    } catch(e) { headlines = '(News fetch failed)'; }
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
        model: 'claude-sonnet-4-6',
        max_tokens: 1400,
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!anthropicRes.ok) {
      const err = await anthropicRes.text();
      return res.status(502).json({error:'Anthropic API error', detail: err});
    }

    const data = await anthropicRes.json();
    const text = data?.content?.find(b => b.type === 'text')?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const json = JSON.parse(clean);
    return res.status(200).json(json);
  } catch(e) {
    return res.status(500).json({error:'Brief generation failed', detail: e.message});
  }
}
