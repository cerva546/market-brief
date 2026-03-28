export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).send('Missing Upstash configuration');
  }

  if (req.method === 'GET') {
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Unsubscribe — Mkt Brief</title>
        <style>
          body {
            margin: 0;
            background: #f7f5f0;
            color: #1a1814;
            font-family: Arial, sans-serif;
          }
          .wrap {
            max-width: 680px;
            margin: 0 auto;
            padding: 48px 20px;
          }
          .kicker {
            font-size: 12px;
            letter-spacing: 1.5px;
            text-transform: uppercase;
            color: #9a7000;
            margin-bottom: 12px;
          }
          h1 {
            font-family: Georgia, serif;
            font-size: 36px;
            line-height: 1.1;
            margin: 0 0 14px;
          }
          p {
            font-size: 16px;
            line-height: 1.8;
            color: #3a3830;
            margin: 0 0 14px;
          }
          input {
            width: 100%;
            box-sizing: border-box;
            padding: 12px 14px;
            border: 1px solid #ddd9cc;
            background: #fff;
            color: #1a1814;
            font-size: 14px;
            margin: 10px 0 12px;
          }
          button {
            padding: 12px 16px;
            border: 1px solid #1a1814;
            background: #1a1814;
            color: #fff;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            cursor: pointer;
          }
          button:hover {
            background: #fffef9;
            color: #1a1814;
          }
          .msg {
            margin-top: 14px;
            font-size: 14px;
            color: #3a3830;
          }
          a {
            color: #9a7000;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <div class="kicker">Mkt Brief</div>
          <h1>Unsubscribe</h1>
          <p>Enter the email address you want removed from the Mkt Brief newsletter.</p>

          <input id="email" type="email" placeholder="you@example.com" />
          <button onclick="unsubscribe()">Unsubscribe</button>

          <div id="msg" class="msg"></div>

          <p style="margin-top:24px;"><a href="https://mktbrief.com">Return to mktbrief.com</a></p>
        </div>

        <script>
          async function unsubscribe() {
            const email = document.getElementById('email').value.trim().toLowerCase();
            const msg = document.getElementById('msg');

            msg.textContent = '';

            if (!email || !/^\\S+@\\S+\\.\\S+$/.test(email)) {
              msg.textContent = 'Please enter a valid email address.';
              return;
            }

            try {
              const res = await fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
              });

              const data = await res.json().catch(() => ({}));

              if (!res.ok) {
                msg.textContent = data.error || 'Unable to unsubscribe.';
                return;
              }

              msg.textContent = 'You have been unsubscribed.';
              document.getElementById('email').value = '';
            } catch {
              msg.textContent = 'Network error. Please try again.';
            }
          }
        </script>
      </body>
      </html>
    `);
  }

  if (req.method === 'POST') {
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    try {
      const r = await fetch(
        `${UPSTASH_URL}/srem/subscribers/${encodeURIComponent(email)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`
          }
        }
      );

      if (!r.ok) {
        const text = await r.text().catch(() => '');
        return res.status(500).json({
          error: 'Could not unsubscribe',
          detail: text
        });
      }

      return res.status(200).json({ ok: true, unsubscribed: email });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
