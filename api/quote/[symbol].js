export default async function handler(req, res) {
  const { symbol } = req.query;

  if (!symbol || !['CL=F', 'NG=F', 'KRBN', 'ALI=F'].includes(symbol)) {
    return res.status(400).json({ error: 'Invalid symbol' });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });

    if (!resp.ok) {
      // Fallback to query2
      const resp2 = await fetch(url.replace('query1', 'query2'), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      if (!resp2.ok) throw new Error(`Yahoo HTTP ${resp2.status}`);
      var json = await resp2.json();
    } else {
      var json = await resp.json();
    }

    const result = json.chart.result[0];
    const closes = result.indicators.quote[0].close.filter(v => v != null);

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      symbol,
      closes,
      timestamps: result.timestamp,
      current: closes[closes.length - 1],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
