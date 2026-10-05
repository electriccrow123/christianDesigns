// Stock Trader Training Game — local server.
// Serves the web app and proxies real market data (stocks + option chains)
// from Yahoo Finance so the browser can read it without CORS problems.
// Zero dependencies: requires Node 18+ (built-in fetch).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------- Yahoo session (cookie + crumb) ----------
let session = null; // { cookie, crumb, at }
let sessionPromise = null;

async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 30 * 60 * 1000) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const res = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!crumbRes.ok || !crumb || crumb.includes('<')) throw new Error('Could not obtain Yahoo crumb');
    session = { cookie, crumb, at: Date.now() };
    return session;
  })().finally(() => { sessionPromise = null; });
  return sessionPromise;
}

async function yahoo(url, { needsCrumb = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = needsCrumb ? await getSession(attempt > 0) : null;
    const u = new URL(url);
    if (s) u.searchParams.set('crumb', s.crumb);
    const res = await fetch(u, { headers: { 'User-Agent': UA, ...(s ? { Cookie: s.cookie } : {}) } });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (!res.ok) throw new Error(`Upstream ${res.status}`);
    return res.json();
  }
  throw new Error('Upstream auth failed');
}

// ---------- tiny TTL cache so we stay polite to the data source ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

const SYMBOL_RE = /^[A-Za-z0-9.^=\-]{1,15}$/;
function cleanSymbols(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => SYMBOL_RE.test(s))
    .slice(0, 50);
}

function pickQuote(q) {
  return {
    symbol: q.symbol,
    name: q.longName || q.shortName || q.displayName || q.symbol,
    type: q.quoteType,
    exchange: q.fullExchangeName || q.exchange,
    currency: q.currency,
    price: q.regularMarketPrice,
    change: q.regularMarketChange,
    changePercent: q.regularMarketChangePercent,
    previousClose: q.regularMarketPreviousClose,
    open: q.regularMarketOpen,
    dayHigh: q.regularMarketDayHigh,
    dayLow: q.regularMarketDayLow,
    volume: q.regularMarketVolume,
    avgVolume: q.averageDailyVolume3Month,
    bid: q.bid,
    ask: q.ask,
    marketCap: q.marketCap,
    pe: q.trailingPE,
    fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: q.fiftyTwoWeekLow,
    fiftyDayAverage: q.fiftyDayAverage,
    twoHundredDayAverage: q.twoHundredDayAverage,
    earningsTimestamp: q.earningsTimestamp,
    dividendYield: q.dividendYield,
    marketState: q.marketState,
    preMarketPrice: q.preMarketPrice,
    postMarketPrice: q.postMarketPrice,
    time: q.regularMarketTime,
  };
}

function pickContract(c) {
  return {
    contract: c.contractSymbol,
    strike: c.strike,
    last: c.lastPrice ?? 0,
    bid: c.bid ?? 0,
    ask: c.ask ?? 0,
    change: c.change ?? 0,
    percentChange: c.percentChange ?? 0,
    volume: c.volume ?? 0,
    openInterest: c.openInterest ?? 0,
    iv: c.impliedVolatility ?? 0,
    itm: !!c.inTheMoney,
    expiration: c.expiration,
    lastTradeDate: c.lastTradeDate,
  };
}

// ---------- API handlers ----------
const api = {
  async quote(params) {
    const symbols = cleanSymbols(params.get('symbols'));
    if (!symbols.length) return { quotes: [] };
    const key = 'q:' + symbols.join(',');
    return cached(key, 10_000, async () => {
      const data = await yahoo(
        `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`,
      );
      const result = data?.quoteResponse?.result || [];
      return { quotes: result.map(pickQuote), fetchedAt: Date.now() };
    });
  },

  async chart(params) {
    const [symbol] = cleanSymbols(params.get('symbol'));
    if (!symbol) throw Object.assign(new Error('symbol required'), { status: 400 });
    const ranges = { '1d': '5m', '5d': '15m', '1mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' };
    const range = ranges[params.get('range')] ? params.get('range') : '1d';
    const interval = ranges[range];
    return cached(`c:${symbol}:${range}`, range === '1d' ? 30_000 : 300_000, async () => {
      const data = await yahoo(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`,
        { needsCrumb: false },
      );
      const r = data?.chart?.result?.[0];
      if (!r) throw Object.assign(new Error('No chart data'), { status: 404 });
      const ts = r.timestamp || [];
      const close = r.indicators?.quote?.[0]?.close || [];
      const points = [];
      for (let i = 0; i < ts.length; i++) if (close[i] != null) points.push([ts[i], close[i]]);
      return { symbol, range, previousClose: r.meta?.chartPreviousClose ?? r.meta?.previousClose, points };
    });
  },

  async options(params) {
    const [symbol] = cleanSymbols(params.get('symbol'));
    if (!symbol) throw Object.assign(new Error('symbol required'), { status: 400 });
    const date = /^\d{9,11}$/.test(params.get('date') || '') ? params.get('date') : '';
    return cached(`o:${symbol}:${date}`, 15_000, async () => {
      const data = await yahoo(
        `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}${date ? `?date=${date}` : ''}`,
      );
      const r = data?.optionChain?.result?.[0];
      if (!r) throw Object.assign(new Error('No options for this symbol'), { status: 404 });
      const chain = r.options?.[0] || { calls: [], puts: [] };
      return {
        symbol,
        expirations: r.expirationDates || [],
        expiration: chain.expirationDate ?? null,
        underlying: r.quote ? pickQuote(r.quote) : null,
        calls: (chain.calls || []).map(pickContract),
        puts: (chain.puts || []).map(pickContract),
        fetchedAt: Date.now(),
      };
    });
  },

  async search(params) {
    const q = String(params.get('q') || '').trim().slice(0, 40);
    if (!q) return { results: [] };
    return cached(`s:${q.toLowerCase()}`, 600_000, async () => {
      const data = await yahoo(
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`,
      );
      const results = (data?.quotes || [])
        .filter((x) => x.symbol && ['EQUITY', 'ETF', 'INDEX'].includes(x.quoteType))
        .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, type: x.quoteType, exchange: x.exchDisp }));
      return { results };
    });
  },
};

// ---------- HTTP server ----------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname)).replace(/^([/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const handler = api[url.pathname.slice(5)];
    if (!handler || req.method !== 'GET') return send(res, 404, { error: 'Unknown endpoint' });
    try {
      send(res, 200, await handler(url.searchParams));
    } catch (err) {
      send(res, err.status || 502, { error: err.message || 'Market data unavailable' });
    }
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`\n  📈 Stock Trader Training Game running at http://localhost:${PORT}\n`);
});
