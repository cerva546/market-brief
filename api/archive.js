export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const dates = (await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, 'brief_archive_index')) || [];

    const briefs = [];
    for (const dateKey of dates.slice(0, 30)) {
      const item = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, `brief_v2_${dateKey}`);
      if (item) briefs.push(item);
    }

    return res.status(200).json({ items: briefs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function upstashGet(url, token, key) {
  if (!url || !token) return null;

  try {
    const r = await fetch(`${url}/get/${key}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!r.ok) return null;

    const d = await r.json();
    if (!d.result) return null;

    const parsed = JSON.parse(d.result);
    if (typeof parsed === 'string') return JSON.parse(parsed);
    return parsed;
  } catch {
    return null;
  }
}
