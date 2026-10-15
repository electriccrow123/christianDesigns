// Market data for the self-hosted paper desk, from Yahoo Finance's public endpoints
// (may be delayed up to 15 minutes). Same interface as the Robinhood market adapter.

import { round, uniq, chunk } from '../core/util.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DAY = 86400;

let session = null;
let sessionPromise = null;
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < 30 * 60 * 1000) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const res = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
    const crumbRes = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
    const crumb = (await crumbRes.text()).trim();
    if (!crumbRes.ok || !crumb || crumb.includes('<')) throw new Error('Could not start a Yahoo Finance session');
    session = { cookie, crumb, at: Date.now() };
    return session;
  })().finally(() => {
    sessionPromise = null;
  });
  return sessionPromise;
}

async function yahoo(url, { needsCrumb = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = needsCrumb ? await getSession(attempt > 0) : null;
    const u = new URL(url);
    if (s) u.searchParams.set('crumb', s.crumb);
    const res = await fetch(u, { headers: { 'User-Agent': UA, ...(s ? { Cookie: s.cookie } : {}) } });
    if ((res.status === 401 || res.status === 403) && attempt === 0) continue;
    if (!res.ok) throw new Error(`Market data unavailable (${res.status})`);
    return res.json();
  }
  throw new Error('Market data unavailable');
}

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return value;
}

const BIG_CAPS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V', 'MA', 'UNH', 'XOM', 'LLY', 'COST', 'NFLX', 'AMD', 'ORCL', 'CRM', 'ADBE', 'INTC', 'QCOM', 'BAC', 'WMT', 'HD', 'DIS', 'PLTR', 'COIN', 'UBER', 'SHOP'];

async function rawQuotes(symbols) {
  symbols = uniq(symbols.map((s) => s.toUpperCase()));
  if (!symbols.length) return [];
  const parts = await Promise.all(
    chunk(symbols, 40).map((g) => cached('q:' + g.join(','), 8000, () => yahoo(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(g.join(','))}`))),
  );
  return parts.flatMap((p) => p?.quoteResponse?.result || []);
}

export function createYahooMarket({ watchlist = () => [] } = {}) {
  async function quotes(symbols) {
    return (await rawQuotes(symbols)).map((q) => ({
      symbol: q.symbol,
      price: q.regularMarketPrice,
      prevClose: q.regularMarketPreviousClose,
      change: q.regularMarketChange,
      changePct: round(q.regularMarketChangePercent, 2),
      bid: q.bid || undefined,
      ask: q.ask || undefined,
      time: (q.regularMarketTime || 0) * 1000,
    }));
  }

  async function bars(symbols, { interval = 'day', days = 400 } = {}) {
    const intraday = interval !== 'day';
    const yi = { day: '1d', '5minute': '5m', '10minute': '15m', hour: '60m', week: '1wk' }[interval] || '1d';
    const range = intraday ? '5d' : days > 370 ? '2y' : '1y';
    const out = {};
    await Promise.all(
      uniq(symbols.map((s) => s.toUpperCase())).map(async (s) => {
        try {
          const data = await cached(`c:${s}:${yi}:${range}`, intraday ? 60_000 : 30 * 60_000, () =>
            yahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${yi}&includePrePost=false`, { needsCrumb: false }),
          );
          const r = data?.chart?.result?.[0];
          const ts = r?.timestamp || [];
          const q = r?.indicators?.quote?.[0] || {};
          const rows = [];
          for (let i = 0; i < ts.length; i++) if (q.close?.[i] != null && q.open?.[i] != null) rows.push({ t: ts[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 });
          out[s] = rows;
        } catch {
          out[s] = [];
        }
      }),
    );
    return out;
  }

  async function fundamentals(symbols) {
    const out = {};
    for (const q of await rawQuotes(symbols))
      out[q.symbol] = { marketCapB: q.marketCap ? round(q.marketCap / 1e9, 2) : undefined, pe: q.trailingPE, high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow, avgVolume: q.averageDailyVolume3Month, dividendYield: q.dividendYield, sector: q.sector };
    return out;
  }

  const chainRaw = (symbol, unix) =>
    cached(`o:${symbol}:${unix || ''}`, 15_000, async () => {
      const data = await yahoo(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}${unix ? `?date=${unix}` : ''}`);
      return data?.optionChain?.result?.[0] || null;
    });

  async function expirations(symbol) {
    const r = await chainRaw(symbol.toUpperCase());
    return (r?.expirationDates || []).map((u) => new Date(u * 1000).toISOString().slice(0, 10));
  }

  const toContract = (symbol, right) => (c) => ({
    id: c.contractSymbol,
    symbol,
    right,
    strike: c.strike,
    expiration: new Date(c.expiration * 1000).toISOString().slice(0, 10),
    bid: c.bid || 0,
    ask: c.ask || 0,
    mark: c.bid && c.ask ? (c.bid + c.ask) / 2 : c.lastPrice || 0,
    last: c.lastPrice || 0,
    iv: c.impliedVolatility || undefined,
    openInterest: c.openInterest || 0,
    volume: c.volume || 0,
    prevClose: c.lastPrice && c.change != null ? c.lastPrice - c.change : undefined,
  });

  async function chain(symbol, iso, { spot } = {}) {
    symbol = symbol.toUpperCase();
    const unix = Math.round(Date.parse(iso + 'T00:00:00Z') / 1000);
    const r = await chainRaw(symbol, unix);
    const ch = r?.options?.[0];
    if (!ch) return [];
    let all = [...(ch.calls || []).map(toContract(symbol, 'call')), ...(ch.puts || []).map(toContract(symbol, 'put'))];
    if (spot) {
      const strikes = [...new Set(all.map((c) => c.strike))].sort((a, b) => a - b);
      const at = Math.max(0, strikes.findIndex((k) => k >= spot));
      const keep = new Set(strikes.slice(Math.max(0, at - 14), at + 14));
      all = all.filter((c) => keep.has(c.strike));
    }
    return all;
  }

  /** OCC symbol → { symbol, expiration, right, strike } */
  function parseOcc(id) {
    const m = String(id).match(/^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
    if (!m) return null;
    return { symbol: m[1], expiration: `20${m[2]}-${m[3]}-${m[4]}`, right: m[5] === 'C' ? 'call' : 'put', strike: Number(m[6]) / 1000 };
  }

  async function optionQuotes(contracts) {
    const groups = new Map();
    for (const c of contracts) {
      const id = c.id || c.contractId;
      const meta = parseOcc(id) || c;
      if (!meta.symbol || !meta.expiration) continue;
      const key = `${meta.symbol}|${meta.expiration}`;
      if (!groups.has(key)) groups.set(key, { ...meta, ids: [] });
      groups.get(key).ids.push(id);
    }
    const out = {};
    await Promise.all(
      [...groups.values()].map(async (g) => {
        const list = await chain(g.symbol, g.expiration).catch(() => []);
        for (const c of list) if (g.ids.includes(c.id)) out[c.id] = c;
      }),
    );
    return out;
  }

  async function earnings({ days = 10 } = {}) {
    const syms = uniq([...BIG_CAPS, ...watchlist()]);
    const now = Date.now() / 1000;
    const qs = await rawQuotes(syms).catch(() => []);
    return qs
      .filter((q) => q.earningsTimestamp && q.earningsTimestamp >= now - DAY && q.earningsTimestamp <= now + days * DAY)
      .map((q) => {
        const d = new Date(q.earningsTimestamp * 1000);
        const hourNY = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }));
        return { symbol: q.symbol, date: d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), timing: hourNY < 12 ? 'am' : 'pm', big: true, verified: !q.isEarningsDateEstimate };
      });
  }

  async function ratings(symbols) {
    const out = {};
    for (const q of await rawQuotes(symbols)) if (q.averageAnalystRating) out[q.symbol] = { consensus: q.averageAnalystRating, targetMean: q.targetMeanPrice };
    return out;
  }

  async function search(q) {
    const data = await yahoo(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`);
    return (data?.quotes || []).filter((x) => x.symbol && ['EQUITY', 'ETF'].includes(x.quoteType)).map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol }));
  }

  return { quotes, bars, fundamentals, expirations, chain, optionQuotes, earnings, ratings, search };
}
