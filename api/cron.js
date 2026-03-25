export default async function handler(req, res) {
  const SITE_URL = process.env.SITE_URL || `https://${req.headers.host}`;

  try {
    const getRes = await fetch(`${SITE_URL}/api/brief`, { cache: 'no-store' });
    if (getRes.status === 200) {
      return res.status(200).json({ ok: true, cached: true });
    }

    const prompt = `You are the editor of Market Brief, a short daily market and business news summary.

Write in clear, simple, user-friendly language for an average reader.

Focus on the biggest market-moving stories: stocks, crypto, macro, major company news, political and economic developments.

Return ONLY valid JSON.`;

    const postRes = await fetch(`${SITE_URL}/api/brief`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    const data = await postRes.json().catch(() => ({}));

    if (!postRes.ok) {
      return res.status(500).json({ ok: false, error: 'Brief generation failed', detail: data });
    }

    return res.status(200).json({ ok: true, generated: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
