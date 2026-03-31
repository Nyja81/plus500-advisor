// Vercel Cron — checks market conditions and sends push alerts on trend reversals
// Env vars: KV_REST_API_URL, KV_REST_API_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
import webpush from 'web-push';

const FUNDAMENTALS = {
  WTI: {
    name: 'Ropa WTI', symbol: 'CL=F',
    floor: 50, fairLow: 58, fairMid: 65, fairHigh: 75, ceiling: 90, extreme: 110,
  },
  NG: {
    name: 'Gaz ziemny', symbol: 'NG=F',
    floor: 1.80, fairLow: 2.50, fairMid: 3.50, fairHigh: 4.50, ceiling: 6.00, extreme: 8.00,
    seasonality: {1:1.25,2:1.20,3:1.05,4:0.85,5:0.80,6:0.80,7:0.85,8:0.90,9:0.95,10:1.00,11:1.10,12:1.20},
  },
  EUA: {
    name: 'Emisje CO2', symbol: 'KRBN',
    floor: 45, fairLow: 55, fairMid: 70, fairHigh: 85, ceiling: 100, extreme: 130,
    krbnRatio: 2.27,
  },
};

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
  let resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
  });
  if (!resp.ok) {
    resp = await fetch(url.replace('query1', 'query2'), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
  }
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const json = await resp.json();
  const result = json.chart.result[0];
  return result.indicators.quote[0].close.filter(v => v != null);
}

function computeTechnicals(closes) {
  const n = closes.length;
  if (n < 30) return null;
  const current = closes[n - 1];
  const sma = (arr, p) => arr.slice(-p).reduce((a, b) => a + b, 0) / Math.min(p, arr.length);
  const sma20 = sma(closes, 20);
  const sma50 = n >= 50 ? sma(closes, 50) : sma(closes, n);
  const sma200 = n >= 200 ? sma(closes, 200) : sma(closes, n);

  let gains = 0, losses = 0;
  for (let i = n - 14; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const rsi = 100 - 100 / (1 + (losses === 0 ? 100 : gains / losses));

  const tail20 = closes.slice(-20);
  const std20 = Math.sqrt(tail20.reduce((s, v) => s + (v - sma20) ** 2, 0) / 20);
  const bbUpper = sma20 + 2 * std20;
  const bbLower = sma20 - 2 * std20;

  const pct5d = n >= 6 ? (current / closes[n - 6] - 1) * 100 : 0;

  return { current, sma20, sma50, sma200, rsi, bbUpper, bbLower, pct5d };
}

function getZone(key, price) {
  const f = FUNDAMENTALS[key];
  let fairMid = f.fairMid;
  if (key === 'NG') {
    const m = new Date().getMonth() + 1;
    fairMid *= (f.seasonality[m] || 1);
  }
  if (key === 'EUA' && f.krbnRatio) price *= f.krbnRatio;

  if (price <= f.floor) return 'PODLOGA';
  if (price <= f.fairLow) return 'TANIO';
  if (price <= fairMid) return 'FAIR_LOW';
  if (price <= f.fairHigh) return 'FAIR_HIGH';
  if (price <= f.ceiling) return 'DROGIE';
  if (price <= f.extreme) return 'B_DROGIE';
  return 'EKSTREMALNIE';
}

function getRecommendation(fundScore, techScore) {
  const total = fundScore * 0.5 + techScore * 0.3;
  if (total > 25) return 'KUP';
  if (total > 10) return 'KUP_OSTROZNIE';
  if (total < -25) return 'SPRZEDAJ';
  if (total < -10) return 'SPRZEDAJ_OSTROZNIE';
  return 'WSTRZYMAJ';
}

function scoreFundamental(key, price) {
  const f = FUNDAMENTALS[key];
  let fairMid = f.fairMid;
  if (key === 'NG') {
    const m = new Date().getMonth() + 1;
    fairMid *= (f.seasonality[m] || 1);
  }
  if (key === 'EUA' && f.krbnRatio) price *= f.krbnRatio;

  if (price <= f.floor) return 80;
  if (price <= f.fairLow) return 50;
  if (price <= fairMid) return 20;
  if (price <= f.fairHigh) return -10;
  if (price <= f.ceiling) return -40;
  if (price <= f.extreme) return -70;
  return -90;
}

function scoreTechnical(tech) {
  let s = 0;
  if (tech.current > tech.sma50 && tech.sma50 > tech.sma200) s += 20;
  else if (tech.current < tech.sma50 && tech.sma50 < tech.sma200) s -= 20;
  else if (tech.current > tech.sma20) s += 10;
  else s -= 10;

  if (tech.rsi > 70) s -= 25;
  else if (tech.rsi > 60) s -= 10;
  else if (tech.rsi < 30) s += 25;
  else if (tech.rsi < 40) s += 10;

  if (tech.current >= tech.bbUpper) s -= 15;
  else if (tech.current <= tech.bbLower) s += 15;

  if (tech.pct5d > 5) s -= 10;
  else if (tech.pct5d < -5) s += 10;

  return s;
}

// Alert conditions — detect significant changes
function detectAlerts(key, tech, prevState) {
  const alerts = [];
  const f = FUNDAMENTALS[key];
  const price = key === 'EUA' ? tech.current * f.krbnRatio : tech.current;

  const fundScore = scoreFundamental(key, tech.current);
  const techScore = scoreTechnical(tech);
  const rec = getRecommendation(fundScore, techScore);
  const zone = getZone(key, tech.current);

  // 1. Recommendation changed
  if (prevState && prevState.rec && prevState.rec !== rec) {
    const dirChange = (prevState.rec.includes('KUP') && rec.includes('SPRZEDAJ')) ||
                      (prevState.rec.includes('SPRZEDAJ') && rec.includes('KUP'));
    if (dirChange) {
      alerts.push({
        type: 'REVERSAL',
        title: `${f.name}: ODWROCENIE TRENDU`,
        body: `${prevState.rec} → ${rec} | Cena: ${price.toFixed(2)} | RSI: ${tech.rsi.toFixed(0)}`,
        priority: 'high',
      });
    } else {
      alerts.push({
        type: 'REC_CHANGE',
        title: `${f.name}: zmiana rekomendacji`,
        body: `${prevState.rec} → ${rec} | Cena: ${price.toFixed(2)}`,
        priority: 'medium',
      });
    }
  }

  // 2. RSI extreme crossings
  if (prevState) {
    if (tech.rsi > 70 && prevState.rsi <= 70) {
      alerts.push({ type: 'RSI_HIGH', title: `${f.name}: RSI > 70 (wykupiony)`, body: `RSI = ${tech.rsi.toFixed(0)} | Cena: ${price.toFixed(2)} — rozważ SPRZEDAJ`, priority: 'medium' });
    }
    if (tech.rsi < 30 && prevState.rsi >= 30) {
      alerts.push({ type: 'RSI_LOW', title: `${f.name}: RSI < 30 (wyprzedany)`, body: `RSI = ${tech.rsi.toFixed(0)} | Cena: ${price.toFixed(2)} — rozważ KUP`, priority: 'medium' });
    }
  }

  // 3. Zone change (fundamental band crossing)
  if (prevState && prevState.zone && prevState.zone !== zone) {
    alerts.push({
      type: 'ZONE_CHANGE',
      title: `${f.name}: zmiana strefy cenowej`,
      body: `${prevState.zone} → ${zone} | Cena: ${price.toFixed(2)}`,
      priority: 'low',
    });
  }

  // 4. Large 1-day move (>3%)
  const pct1d = tech.current / (tech.current / (1 + tech.pct5d / 500)) - 1;
  // Use actual closes for 1d change
  if (Math.abs(tech.pct5d) > 8) {
    alerts.push({
      type: 'BIG_MOVE',
      title: `${f.name}: duzy ruch ${tech.pct5d > 0 ? '+' : ''}${tech.pct5d.toFixed(1)}% (5d)`,
      body: `Cena: ${price.toFixed(2)} | RSI: ${tech.rsi.toFixed(0)} — sprawdz czy to okazja mean reversion`,
      priority: 'medium',
    });
  }

  return { alerts, currentState: { rec, rsi: tech.rsi, zone, price, ts: Date.now() } };
}

async function kvGet(url, token, key) {
  const resp = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
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

export default async function handler(req, res) {
  // Verify cron secret (Vercel sends CRON_SECRET header)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'push@plus500.app'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  try {
    // Get previous state
    const prevRaw = await kvGet(kvUrl, kvToken, 'alert_state');
    const prevState = prevRaw ? JSON.parse(prevRaw) : {};

    // Fetch market data and check alerts
    const allAlerts = [];
    const newState = {};
    const keys = ['WTI', 'NG', 'EUA'];

    for (const key of keys) {
      try {
        const closes = await fetchYahoo(FUNDAMENTALS[key].symbol);
        const tech = computeTechnicals(closes);
        if (!tech) continue;

        const { alerts, currentState } = detectAlerts(key, tech, prevState[key]);
        newState[key] = currentState;
        allAlerts.push(...alerts);
      } catch (e) {
        console.error(`Error checking ${key}:`, e.message);
        if (prevState[key]) newState[key] = prevState[key]; // keep old state
      }
    }

    // Save new state
    await kvSet(kvUrl, kvToken, 'alert_state', JSON.stringify(newState));

    // Send push notifications if there are alerts
    if (allAlerts.length > 0) {
      const subsRaw = await kvGet(kvUrl, kvToken, 'push_subs');
      const subs = subsRaw ? JSON.parse(subsRaw) : [];

      const highPriority = allAlerts.filter(a => a.priority === 'high');
      const toSend = highPriority.length > 0 ? highPriority : allAlerts.slice(0, 2);

      let sent = 0, failed = 0;
      for (const sub of subs) {
        for (const alert of toSend) {
          try {
            await webpush.sendNotification(sub, JSON.stringify({
              title: alert.title,
              body: alert.body,
              type: alert.type,
              url: '/',
              timestamp: Date.now(),
            }));
            sent++;
          } catch (e) {
            failed++;
            // Remove expired subscriptions
            if (e.statusCode === 410 || e.statusCode === 404) {
              const filtered = subs.filter(s => s.endpoint !== sub.endpoint);
              await kvSet(kvUrl, kvToken, 'push_subs', JSON.stringify(filtered));
            }
          }
        }
      }

      // Also save last alerts for the UI to display
      await kvSet(kvUrl, kvToken, 'last_alerts', JSON.stringify({
        alerts: allAlerts,
        ts: Date.now(),
      }));

      return res.status(200).json({ alerts: allAlerts.length, sent, failed, state: newState });
    }

    return res.status(200).json({ alerts: 0, message: 'No alerts triggered', state: newState });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
