// Stores push subscription in Vercel KV (Upstash Redis)
// Env vars needed: KV_REST_API_URL, KV_REST_API_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { subscription, action } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Missing subscription' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(500).json({ error: 'KV not configured' });
  }

  try {
    if (action === 'unsubscribe') {
      // Remove subscription
      const existing = await kvGet(kvUrl, kvToken, 'push_subs');
      const subs = existing ? JSON.parse(existing) : [];
      const filtered = subs.filter(s => s.endpoint !== subscription.endpoint);
      await kvSet(kvUrl, kvToken, 'push_subs', JSON.stringify(filtered));
      return res.status(200).json({ ok: true, count: filtered.length });
    }

    // Add subscription
    const existing = await kvGet(kvUrl, kvToken, 'push_subs');
    const subs = existing ? JSON.parse(existing) : [];
    // Deduplicate by endpoint
    const idx = subs.findIndex(s => s.endpoint === subscription.endpoint);
    if (idx >= 0) subs[idx] = subscription;
    else subs.push(subscription);
    await kvSet(kvUrl, kvToken, 'push_subs', JSON.stringify(subs));
    return res.status(200).json({ ok: true, count: subs.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function kvGet(url, token, key) {
  const resp = await fetch(`${url}/get/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  return data.result;
}

async function kvSet(url, token, key, value) {
  await fetch(`${url}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([key, value]),
  });
}
