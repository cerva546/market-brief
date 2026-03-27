export default async function handler(req, res) {
  const SITE_URL      = process.env.SITE_URL || `https://${req.headers.host}`;
  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  const RESEND_KEY    = process.env.RESEND_KEY;

  try {
    /* 1. Check if today's brief already exists */
    let briefRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });

    /* 2. Generate if not cached yet */
    if (briefRes.status !== 200) {
      const prompt = `You are the editor of Mkt Brief, a daily morning market briefing in the style of Morning Brew — smart, clear, and broadly informative. Your readers are general adults who want to understand what's happening in markets and the world when they wake up.

YOUR JOB:
Write a confident, well-rounded morning brief covering everything important happening in markets, business, politics, crypto, and the world. Think of it as a morning newspaper front page mixed with a market open summary.

WHAT TO COVER (include everything relevant, not just the single biggest story):
- US stock market: futures, major index moves, sector trends
- Major individual stocks: big movers, earnings, analyst calls
- Crypto: Bitcoin, Ethereum, and any major moves
- Commodities: oil, gold, key moves
- Macro & Fed: interest rates, inflation data, jobs, economic releases
- US politics & policy: White House, Congress, tariffs, regulation — anything affecting markets or everyday life
- International: geopolitics, foreign markets, global trade, conflicts
- Major company news: layoffs, deals, IPOs, product launches worth knowing
- Anything else a smart person would want to know this morning — even if it doesn't directly move markets (e.g. major government actions, notable policy changes)

WRITING STYLE:
- Clear and conversational — write for a smart general reader, not a finance professional
- Confident and direct — don't hedge excessively
- Engaging but not sensational
- Short sentences, easy to scan
- Explain any jargon simply
- Do NOT say "as of this writing" or use vague hedges
- Do NOT say there is nothing to report — there is always something worth covering
- Do NOT repeat the same point across multiple sections
- Each section (intro, macro, events) must add something NEW

DATE RULES:
- You will be given today's date in ET
- Use that date when referencing "today," "this morning," etc.
- Do not invent a day of the week that contradicts the provided date

Return ONLY valid JSON with no markdown or extra text:
{
  "headline": "strong, specific headline — max 12 words — reflect the biggest story of the day",
  "deck": "one punchy sentence summarizing what's moving markets and why it matters",
  "intro": "3-4 sentences covering the main market story and overall mood — what's up, what's down, what's the vibe",
  "macro": "one paragraph on the big-picture forces: Fed, inflation, rates, growth, tariffs, geopolitics — what's driving investor thinking",
  "events": "one paragraph covering 2-4 additional notable stories — politics, company news, crypto, international — that a reader should know this morning",
  "movers": [
    {"sym":"SPY","name":"S&P 500","dir":"up","pct":"0.4"},
    {"sym":"BTC","name":"Bitcoin","dir":"dn","pct":"1.2"},
    {"sym":"AAPL","name":"Apple","dir":"up","pct":"0.8"}
  ],
  "close": "one sentence on what to watch today or this week",
  "sources": ["list of sources used from the headlines"]
}`;

      const postRes = await fetch(`${SITE_URL}/api/brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });

      if (!postRes.ok) {
        const detail = await postRes.json().catch(() => ({}));
        return res.status(500).json({ ok: false, error: 'Brief generation failed', detail });
      }

      /* Re-fetch after generation */
      briefRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });
    }

    if (briefRes.status !== 200) {
      return res.status(500).json({ ok: false, error: 'Brief unavailable after generation' });
    }

    const brief = await briefRes.json();

    /* 3. Send newsletter if Resend is configured */
    if (!RESEND_KEY) {
      return res.status(200).json({ ok: true, generated: true, sent: 0, message: 'No RESEND_KEY — skipping email' });
    }

    /* Load subscribers from Upstash */
    const subRes  = await fetch(`${UPSTASH_URL}/smembers/subscribers`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const subData = await subRes.json().catch(() => ({}));

    const subscribers = (subData.result || [])
      .map(e => String(e).trim())
      .map(e => {
        if (e.startsWith('["') && e.endsWith('"]')) {
          try { const p = JSON.parse(e); return Array.isArray(p) ? String(p[0] || '').trim().toLowerCase() : e; }
          catch { return e; }
        }
        return e.toLowerCase();
      })
      .filter(e => /^\S+@\S+\.\S+$/.test(e));

    if (!subscribers.length) {
      return res.status(200).json({ ok: true, generated: true, sent: 0, message: 'No subscribers yet' });
    }

    /* Build email */
    const html = `
<div style="max-width:680px;margin:0 auto;padding:32px 20px;font-family:Arial,sans-serif;color:#111;background:#faf8f2;">
  <div style="font-size:12px;margin-bottom:14px;">
    <a href="${SITE_URL}" style="color:#8a6a00;text-decoration:none;">Read this brief online →</a>
  </div>
  <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8a6a00;margin-bottom:16px;">Mkt Brief</div>
  <h1 style="font-size:32px;line-height:1.1;margin:0 0 12px;font-family:Georgia,serif;">
    <a href="${SITE_URL}" style="color:#111;text-decoration:none;">${brief.headline || ''}</a>
  </h1>
  <p style="font-size:18px;line-height:1.5;color:#555;font-style:italic;margin:0 0 24px;">${brief.deck || ''}</p>
  <p style="font-size:16px;line-height:1.8;">${brief.intro || ''}</p>
  <p style="font-size:16px;line-height:1.8;">${brief.macro || ''}</p>
  ${brief.events ? `<p style="font-size:16px;line-height:1.8;">${brief.events}</p>` : ''}
  <p style="font-size:16px;line-height:1.8;"><strong>What to watch:</strong> ${brief.close || ''}</p>
  <hr style="margin:28px 0;border:none;border-top:1px solid #ddd;">
  <p style="font-size:13px;color:#666;margin:0 0 8px;">
    Continue reading at <a href="${SITE_URL}" style="color:#8a6a00;text-decoration:none;">mktbrief.com</a>
  </p>
  <p style="font-size:11px;color:#999;margin:0;">
    AI-generated from real news headlines and market data. Not financial advice.
  </p>
</div>`;

    const text = [
      brief.headline, '', brief.deck, '',
      brief.intro, '', brief.macro, '',
      brief.events || '', '',
      `What to watch: ${brief.close || ''}`, '',
      `Read online: ${SITE_URL}`
    ].join('\n');

    const { Resend } = await import('resend');
    const resend = new Resend(RESEND_KEY);

    const { data, error } = await resend.emails.send({
      from: 'Mkt Brief <brief@mktbrief.com>',
      to: 'brief@mktbrief.com',
      bcc: subscribers,
      replyTo: 'brief@mktbrief.com',
      subject: brief.headline || "Today's Mkt Brief",
      html,
      text
    });

    if (error) {
      return res.status(500).json({ ok: false, error: 'Resend send failed', detail: error });
    }

    return res.status(200).json({ ok: true, generated: true, sent: subscribers.length, resendId: data?.id || null });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
