export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  const NEWS_API_KEY = process.env.NEWS_API_KEY;
  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_KEY not set' });
  }

  const dateKey = getETDateKey();
  const cacheKey = `brief_v2_${dateKey}`;

  // GET today's cached brief
  if (req.method === 'GET') {
    const cached = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
    if (cached) {
      await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
      return res.status(200).json(cached);
    }
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // POST: if today's brief already exists, return it
  const existing = await upstashGet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey);
  if (existing) {
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);
    return res.status(200).json(existing);
  }

  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  // Pull fresh headline context for this edition window
  const newsContext = await buildNewsContext(NEWS_API_KEY);

  try {
    const fullPrompt = `${prompt}

EDITION DATE (ET): ${newsContext.dateLabel}
EDITION WINDOW (ET): ${newsContext.windowLabel}

TIME RULES:
- Treat this brief as the edition for the current 8:00 AM ET publication window.
- Only prioritize developments that are new, materially updated, or newly market-moving since the previous 8:00 AM ET edition.
- If a story is ongoing, only include it if there is a meaningful fresh development in this edition window.
- Do not present old developments as if they just happened.
- Avoid phrases like "today", "Tuesday", or "this morning" unless they match the current Eastern Time edition date.
- If there is not enough new information on a story, leave it out.

EDITORIAL QUALITY RULES:
- Do not repeat the same idea across intro, macro, and events.
- Each paragraph must add something new.
- The intro explains the main fresh development.
- The macro section explains why it matters for markets.
- The events section includes only additional developments not already covered.
- Prefer 2-4 important fresh themes over many weak ones.

LATEST MARKET-RELEVANT HEADLINES:
${newsContext.headlines}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1400,
        messages: [{ role: 'user', content: fullPrompt }]
      })
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(502).json({
        error: 'Anthropic error',
        detail: err.slice(0, 400)
      });
    }

    const data = await r.json();
    const text = data?.content?.find(b => b.type === 'text')?.text || '';

    if (!text) {
      return res.status(500).json({ error: 'Empty model response' });
    }

    let brief;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      brief = JSON.parse(clean);
    } catch {
      return res.status(500).json({
        error: 'Invalid JSON from model',
        detail: text.slice(0, 700)
      });
    }

    const archivedBrief = {
      dateKey,
      ...brief
    };

    await upstashSet(UPSTASH_URL, UPSTASH_TOKEN, cacheKey, archivedBrief);
    await addToArchiveIndex(UPSTASH_URL, UPSTASH_TOKEN, dateKey);

    return res.status(200).json(archivedBrief);
  } catch (e) {
    return res.status(500).json({
      error: 'Generation failed',
      detail: e.message
    });
  }
}

async function buildNewsContext(newsApiKey) {
  const { fromISO, toISO, windowLabel, dateLabel } = getEditionWindowET();

  if (!newsApiKey) {
    return {
      headlines: '(News headlines unavailable)',
      windowLabel,
      dateLabel
    };
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    const urls = [
      `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${newsApiKey}`,
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(
        '(markets OR stocks OR federal reserve OR inflation OR treasury yields OR oil OR bitcoin OR crypto OR tariffs OR trump OR middle east OR geopolitics OR earnings)'
      )}&language=en&sortBy=publishedAt&pageSize=40&from=${encodeURIComponent(fromISO)}&to=${encodeURIComponent(toISO)}&apiKey=${newsApiKey}`
    ];

    const responses = await Promise.all(
      urls.map(url => fetch(url, { signal: ctrl.signal }))
    );

    clearTimeout(timer);

    const payloads = await Promise.all(
      responses.map(async r => (r.ok ? r.json() : { articles: [] }))
    );

    const allArticles = payloads.flatMap(p => p.articles || []);

    const seenTitles = new Set();
    const filtered = allArticles
      .filter(a => a?.title && a?.publishedAt)
      .filter(a => {
        const normalized = normalizeTitle(a.title);
        if (!normalized || seenTitles.has(normalized)) return false;
        seenTitles.add(normalized);
        return true;
      })
      .filter(a => {
        const published = new Date(a.publishedAt).getTime();
        return Number.isFinite(published) && published >= new Date(fromISO).getTime();
      })
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 25);

    if (!filtered.length) {
      return {
        headlines: `(No fresh headlines found for edition window: ${windowLabel})`,
        windowLabel,
        dateLabel
      };
    }

    const headlines = filtered
      .map(a => {
        const source = a.source?.name || 'Unknown';
        const desc = a.description ? ` — ${a.description.slice(0, 160)}` : '';
        return `• ${a.title}${desc} [${source}, ${a.publishedAt}]`;
      })
      .join('\n');

    return {
      headlines,
      windowLabel,
      dateLabel
    };
  } catch {
    return {
      headlines: `(News fetch failed for edition window: ${windowLabel})`,
      windowLabel,
      dateLabel
    };
  }
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .trim();
}

function getETDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;

  return `${y}-${m}-${d}`;
}

function getEditionWindowET() {
  const now = new Date();

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);

  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);

  const year = Number(dateParts.find(p => p.type === 'year').value);
  const month = Number(dateParts.find(p => p.type === 'month').value);
  const day = Number(dateParts.find(p => p.type === 'day').value);
  const hour = Number(timeParts.find(p => p.type === 'hour').value);

  // Current ET calendar day at noon UTC placeholder
  const currentET = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  let editionDate = new Date(currentET);
  if (hour < 8) {
    editionDate.setUTCDate(editionDate.getUTCDate() - 1);
  }

  const startYear = editionDate.getUTCFullYear();
  const startMonth = editionDate.getUTCMonth() + 1;
  const startDay = editionDate.getUTCDate();

  const startDateKey = `${startYear.toString().padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

  const fromISO = etDateAtEightToISO(startDateKey);
  const toISO = new Date().toISOString();

  const prettyDate = new Date(Date.UTC(startYear, startMonth - 1, startDay, 12, 0, 0))
    .toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    });

  return {
    fromISO,
    toISO,
    windowLabel: `${startDateKey} 08:00 ET → now`,
    dateLabel: prettyDate
  };
}

function etDateAtEightToISO(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);

  // Approximate EDT/EST safely enough for your current use case:
  // Use noon UTC date holder and derive ET offset by locale.
  const utcGuess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset'
  }).formatToParts(utcGuess);

  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-4';
  const match = offsetPart.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);

  let hourOffset = -4;
  let minuteOffset = 0;

  if (match) {
    hourOffset = Number(match[1]);
    minuteOffset = Number(match[2] || 0);
  }

  const sign = hourOffset <= 0 ? '+' : '-';
  const absHour = Math.abs(hourOffset);
  const offsetMinutesTotal = absHour * 60 + minuteOffset;

  // ET 8:00 converted to UTC manually
  const utcDate = new Date(Date.UTC(y, m - 1, d, 8 + offsetMinutesTotal / 60, 0, 0));

  // The sign logic above is only for parsing display; actual UTC conversion here
  // uses ET offset magnitude, which is what we need.
  return utcDate.toISOString();
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

async function upstashSet(url, token, key, value, exSeconds = null) {
  if (!url || !token) return;

  const suffix = exSeconds ? `?EX=${exSeconds}` : '';

  try {
    await fetch(`${url}/set/${key}${suffix}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(value)
    });
  } catch {}
}

async function addToArchiveIndex(url, token, dateKey) {
  const indexKey = 'brief_archive_index';
  const current = (await upstashGet(url, token, indexKey)) || [];
  const next = [dateKey, ...current.filter(d => d !== dateKey)].slice(0, 120);
  await upstashSet(url, token, indexKey, next);
}
