import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  const cleanEmail = (email || '').trim().toLowerCase();

  if (!cleanEmail || !/^\S+@\S+\.\S+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // Store as a plain set member, not as a JSON array string
    const saveRes = await fetch(
      `${UPSTASH_URL}/sadd/subscribers/${encodeURIComponent(cleanEmail)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`
        }
      }
    );

    if (!saveRes.ok) {
      return res.status(500).json({ error: 'Could not save subscriber' });
    }

    await resend.emails.send({
      from: 'Mkt Brief <brief@mktbrief.com>',
      to: cleanEmail,
      replyTo: 'brief@mktbrief.com',
      subject: 'You’re subscribed to Mkt Brief',
      html: `
        <div style="max-width:680px;margin:0 auto;padding:36px 20px;background:#f7f5f0;color:#1a1814;font-family:Arial,sans-serif;">
          <div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#9a7000;margin-bottom:12px;">
            Mkt Brief
          </div>

          <h1 style="font-family:Georgia,serif;font-size:34px;line-height:1.1;margin:0 0 14px;">
            You’re subscribed
          </h1>

          <p style="font-size:18px;line-height:1.6;color:#4a4740;margin:0 0 18px;font-style:italic;">
            The daily market brief will hit your inbox each morning.
          </p>

          <p style="font-size:15px;line-height:1.8;">
            You’ll get a clear, fast read on the biggest stories moving markets — from macro trends to crypto, policy, and major headlines.
          </p>

          <p style="font-size:15px;line-height:1.8;">
            Same edition as the site. No noise. Just what matters.
          </p>

          <hr style="margin:28px 0;border:none;border-top:1px solid #ddd9cc;">

          <p style="font-size:12px;color:#7a7870;">
            Mkt Brief · Published daily at 8 AM ET
          </p>
        </div>
      `
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
