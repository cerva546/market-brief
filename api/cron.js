import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_KEY);

export default async function handler(req, res) {
  const SITE_URL = process.env.SITE_URL || `https://${req.headers.host}`;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // 1. Check if today's brief already exists
    let briefRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });

    // 2. If not, generate it
    if (briefRes.status !== 200) {
 const prompt = `You are the editor of Mkt Brief, a daily market briefing for general readers.

Before writing, rank all available stories by likely market impact and general importance, then write only from the top-ranked themes.

Your job is to write the one most relevant market brief of the day in clear, simple, intelligent language.

IMPORTANT PRIORITY:
Choose the biggest story or stories actually driving markets and investor attention in this edition window.
Do not lead with minor or niche business stories unless they are clearly the main market-moving development.

FOCUS FIRST ON:
- major geopolitical events, including the Middle East, war, energy shocks, or global conflict
- major U.S. political actions, including Trump, the White House, Congress, tariffs, trade, or regulation
- the Fed, rates, inflation, jobs, consumer spending, recession risk, and major macro data
- major stock market moves
- major crypto moves
- major company news only if it is genuinely one of the biggest stories in this edition window

TIME RULES:
- Treat this as the current 8:00 AM ET daily edition.
- Only prioritize developments that are new, materially updated, or newly market-moving since the previous 8:00 AM ET edition.
- If a story is ongoing, include it only if there is a meaningful fresh development in this edition window.
- Do not present old developments as if they just happened.
- Avoid phrases like "today," "Tuesday," "this morning," or similar unless they are definitely correct for the current Eastern Time edition date.
- Prefer phrasing like "in the latest update," "since yesterday's edition," "overnight," or "in the newest reporting" when needed.
- If there is not enough fresh information on a story, leave it out.

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

EDITORIAL QUALITY RULES:
- do not repeat the same idea across intro, macro, and events
- each paragraph must add something new
- the intro explains the main fresh development
- the macro section explains why it matters for markets
- the events section includes only additional developments not already covered
- it is better to cover 2–4 important fresh themes well than 6 weak ones badly

Return ONLY valid JSON with no markdown or extra text:
{
  "headline": "short, strong headline, max 12 words",
  "deck": "one clear sentence that sums up the day",
  "intro": "3-4 sentence opening paragraph explaining the main fresh market story in simple language",
  "macro": "one paragraph on the main big-picture forces moving markets in this edition window",
  "events": "one paragraph on the most important additional company, political, economic, or crypto developments worth knowing that were not already covered",
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

      const postData = await postRes.json().catch(() => ({}));

      if (!postRes.ok) {
        return res.status(500).json({
          ok: false,
          error: 'Brief generation failed',
          detail: postData
        });
      }

      briefRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });
    }

    if (briefRes.status !== 200) {
      return res.status(500).json({
        ok: false,
        error: 'Brief unavailable after generation'
      });
    }

    const brief = await briefRes.json();

    // 3. Load subscribers
   const subRes = await fetch(`${UPSTASH_URL}/smembers/subscribers`, {
  headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
});

const subData = await subRes.json().catch(() => ({}));

const subscribers = (subData.result || [])
  .map(e => String(e).trim())
  .map(e => {
    if (e.startsWith('["') && e.endsWith('"]')) {
      try {
        const parsed = JSON.parse(e);
        return Array.isArray(parsed) ? String(parsed[0] || '').trim().toLowerCase() : e;
      } catch {
        return e;
      }
    }
    return e.toLowerCase();
  })
  .filter(e => /^\S+@\S+\.\S+$/.test(e));

    // 4. If no subscribers yet, just finish successfully
    if (!subscribers.length) {
      return res.status(200).json({
        ok: true,
        generated: true,
        sent: 0,
        message: 'No subscribers yet'
      });
    }

    // 5. Send email
    const html = `
  <div style="max-width:700px;margin:0 auto;padding:32px 20px;font-family:Arial,sans-serif;color:#111;background:#faf8f2;">

    <div style="font-size:12px;margin-bottom:14px;">
      <a href="${SITE_URL}" style="color:#8a6a00;text-decoration:none;">
        Read this brief online →
      </a>
    </div>

    <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8a6a00;margin-bottom:16px;">
      Mkt Brief
    </div>

    <h1 style="font-size:36px;line-height:1.1;margin:0 0 12px;font-family:Georgia,serif;">
      <a href="${SITE_URL}" style="color:#111;text-decoration:none;">
        ${brief.headline || ''}
      </a>
    </h1>

    <p style="font-size:20px;line-height:1.5;color:#555;font-style:italic;margin:0 0 24px;">
      ${brief.deck || ''}
    </p>

    <p style="font-size:16px;line-height:1.8;">${brief.intro || ''}</p>
    <p style="font-size:16px;line-height:1.8;">${brief.macro || ''}</p>
    ${brief.events ? `<p style="font-size:16px;line-height:1.8;">${brief.events}</p>` : ''}
    <p style="font-size:16px;line-height:1.8;"><strong>What to watch:</strong> ${brief.close || ''}</p>

    <hr style="margin:28px 0;border:none;border-top:1px solid #ddd;">

    <p style="font-size:13px;color:#666;margin:0 0 8px;">
      Continue reading at
      <a href="${SITE_URL}" style="color:#8a6a00;text-decoration:none;">
        mktbrief.com
      </a>
    </p>

    <p style="font-size:12px;color:#666;">
      This email was generated automatically from today’s published Mkt Brief edition.
    </p>
  </div>
`;
const text = `
${brief.headline || ''}

${brief.deck || ''}

${brief.intro || ''}

${brief.macro || ''}

${brief.events || ''}

What to watch: ${brief.close || ''}
`;
const { data, error } = await resend.emails.send({
  from: 'Mkt Brief <brief@mktbrief.com>',
  to: 'brief@mktbrief.com',        // required
  bcc: subscribers,               // 👈 hides all emails
  replyTo: 'brief@mktbrief.com',
  subject: brief.headline || 'Today’s Mkt Brief',
  html,
  text
});

if (error) {
  return res.status(500).json({
    ok: false,
    error: 'Resend send failed',
    detail: error
  });
}

 return res.status(200).json({
  ok: true,
  generated: true,
  sent: subscribers.length,
  resendId: data?.id || null
});
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
