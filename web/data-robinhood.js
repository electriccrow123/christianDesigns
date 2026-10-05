// Market data provider for the published web version.
// Reads real stock and option prices through the viewer's Robinhood connector (read-only tools only;
// this game never places real orders), and saves each player's game to their own private store.
// Same exports as public/js/data.js.

const SERVER = 'Robinhood';
const DAY = 86400000;

export const priceLabel = 'Mark';

// ---------------------------------------------------------------- connector plumbing
let mcpPromise = null;
let serverName = SERVER;

function useCap(name) {
  return window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
}

function mcp() {
  if (!mcpPromise) {
    mcpPromise = (async () => {
      const m = await useCap('mcp');
      if (!m) throw friendly({ code: 'not_granted' });
      try {
        const { servers } = await m.listTools();
        const hit = servers.find((s) => /robinhood/i.test(s.server));
        if (hit) serverName = hit.server;
      } catch {
        /* fall back to the declared name */
      }
      return m;
    })();
    mcpPromise.catch(() => (mcpPromise = null));
  }
  return mcpPromise;
}

function friendly(err) {
  const messages = {
    server_not_connected: 'Connect Robinhood in claude.ai Settings → Connectors, then reload this page.',
    selection_required: 'Choose which Robinhood connection this page should use, then reload.',
    needs_reauth: 'Your Robinhood connection expired. Reconnect it in claude.ai Settings → Connectors.',
    not_in_manifest: 'Robinhood is turned off for this page. Allow it from the page’s Permissions menu.',
    blocked_by_policy: 'Your organization blocks Robinhood market data for this page.',
    approval_required: 'Your organization requires approval for Robinhood market data.',
    server_unavailable: 'Robinhood market data is temporarily unreachable. Retrying shortly.',
    not_granted: 'Open this game on claude.ai while signed in to load live prices.',
    capability_disabled: 'Live prices are not available in this view. Open the game on claude.ai.',
  };
  const e = new Error(messages[err?.code] || err?.message || 'Market data request failed.');
  e.code = err?.code;
  e.retryable = !!err?.retryable;
  e.retryAfterMs = err?.retryAfterMs;
  return e;
}

async function call(tool, input) {
  const m = await mcp();
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await m.callTool(serverName, tool, input, { cache: false });
      const p = r.payload;
      return p && typeof p === 'object' && 'data' in p ? p.data : p;
    } catch (err) {
      if (err?.retryable && attempt === 0) {
        await new Promise((res) => setTimeout(res, (err.retryAfterMs || 800) + Math.random() * 700));
        continue;
      }
      throw friendly(err);
    }
  }
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const num = (v) => (v == null || v === '' ? undefined : Number(v));
const pos = (v) => (num(v) > 0 ? num(v) : undefined);
const isoToUnix = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 1000;
const unixToIso = (u) => new Date(u * 1000).toISOString().slice(0, 10);

// small TTL cache
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- names
const NAMES = {
  SPY: 'SPDR S&P 500 ETF Trust', QQQ: 'Invesco QQQ Trust', AAPL: 'Apple Inc.', MSFT: 'Microsoft Corporation',
  NVDA: 'NVIDIA Corporation', TSLA: 'Tesla, Inc.', AMZN: 'Amazon.com, Inc.', GOOGL: 'Alphabet Inc.', META: 'Meta Platforms, Inc.',
  VOO: 'Vanguard S&P 500 ETF', IWM: 'iShares Russell 2000 ETF', AMD: 'Advanced Micro Devices, Inc.', NFLX: 'Netflix, Inc.',
};
const NAMES_KEY = 'tradetrainer.names.v1';
try {
  Object.assign(NAMES, JSON.parse(localStorage.getItem(NAMES_KEY) || '{}'));
} catch {
  /* browser storage unavailable */
}
function rememberName(symbol, name) {
  if (!symbol || !name || NAMES[symbol]) return;
  NAMES[symbol] = name;
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify(NAMES));
  } catch {
    /* browser storage unavailable */
  }
}
const lookingUp = new Set();
function lookupName(symbol) {
  if (NAMES[symbol] || lookingUp.has(symbol)) return;
  lookingUp.add(symbol);
  search(symbol).catch(() => {});
}

// ---------------------------------------------------------------- market clock (US equities, regular session)
function marketState(now = new Date()) {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  if (day === 0 || day === 6) return 'CLOSED';
  if (mins >= 570 && mins < 960) return 'REGULAR';
  if (mins >= 240 && mins < 570) return 'PRE';
  if (mins >= 960 && mins < 1200) return 'POST';
  return 'CLOSED';
}

// ---------------------------------------------------------------- quotes
function fundamentals(symbols) {
  return Promise.all(
    chunk(symbols, 10).map((group) =>
      cached('f:' + group.join(','), 5 * 60 * 1000, () => call('get_equity_fundamentals', { symbols: group })).catch(() => null),
    ),
  ).then((parts) => {
    const out = {};
    for (const p of parts) for (const f of p?.results || []) out[f.symbol] = f;
    return out;
  });
}

/** 50- and 200-day moving averages from daily bars (cached for an hour). */
function movingAverages(symbols) {
  const start = new Date(Date.now() - 300 * DAY).toISOString().slice(0, 10) + 'T00:00:00Z';
  return Promise.all(
    chunk(symbols, 10).map((group) =>
      cached('ma:' + group.join(','), 60 * 60 * 1000, () => call('get_equity_historicals', { symbols: group, start_time: start, interval: 'day' })).catch(() => null),
    ),
  ).then((parts) => {
    const out = {};
    for (const p of parts)
      for (const r of p?.results || []) {
        const closes = (r.bars || []).filter((b) => !b.interpolated).map((b) => Number(b.close_price));
        const avg = (n) => (closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : undefined);
        out[r.symbol] = { fiftyDayAverage: avg(50), twoHundredDayAverage: avg(200) };
      }
    return out;
  });
}

export async function quotes(symbols) {
  symbols = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  if (!symbols.length) return [];
  const [parts, fund, mas] = await Promise.all([
    Promise.all(chunk(symbols, 20).map((group) => call('get_equity_quotes', { symbols: group }))),
    fundamentals(symbols),
    movingAverages(symbols),
  ]);
  const state = marketState();
  const out = [];
  for (const p of parts)
    for (const r of p?.results || []) {
      const q = r.quote;
      if (!q) continue;
      const regT = Date.parse(q.venue_last_trade_time || 0);
      const extT = Date.parse(q.venue_last_non_reg_trade_time || 0);
      const price = extT > regT && pos(q.last_non_reg_trade_price) ? num(q.last_non_reg_trade_price) : num(q.last_trade_price);
      const prev = num(q.adjusted_previous_close) ?? num(q.previous_close);
      const f = fund[q.symbol] || {};
      lookupName(q.symbol);
      out.push({
        symbol: q.symbol,
        name: NAMES[q.symbol] || q.symbol,
        price,
        change: prev ? price - prev : 0,
        changePercent: prev ? (price / prev - 1) * 100 : 0,
        previousClose: prev,
        open: num(f.open),
        dayHigh: num(f.high),
        dayLow: num(f.low),
        volume: num(f.volume),
        avgVolume: num(f.average_volume_30_days) ?? num(f.average_volume),
        bid: pos(q.bid_price),
        ask: pos(q.ask_price),
        marketCap: num(f.market_cap),
        pe: num(f.pe_ratio),
        fiftyTwoWeekHigh: num(f.high_52_weeks),
        fiftyTwoWeekLow: num(f.low_52_weeks),
        dividendYield: num(f.dividend_yield),
        ...(mas[q.symbol] || {}),
        marketState: state,
        time: regT / 1000,
      });
    }
  return out;
}

// ---------------------------------------------------------------- charts
export async function chart(symbol, range) {
  const now = Date.now();
  const spec = {
    '1d': [5, '5minute'],
    '5d': [9, '30minute'],
    '1mo': [31, 'day'],
    '6mo': [183, 'day'],
    '1y': [366, 'day'],
    '5y': [5 * 366, 'week'],
  }[range] || [5, '5minute'];
  const start = new Date(now - spec[0] * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
  const res = await cached(`c:${symbol}:${range}`, range === '1d' ? 30_000 : 5 * 60_000, () =>
    call('get_equity_historicals', { symbols: [symbol], start_time: start, interval: spec[1] }),
  );
  let bars = (res?.results?.[0]?.bars || []).filter((b) => !b.interpolated);
  const dateOf = (b) => new Date(b.begins_at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (range === '1d' && bars.length) {
    const last = dateOf(bars[bars.length - 1]);
    bars = bars.filter((b) => dateOf(b) === last);
  } else if (range === '5d') {
    const days = [...new Set(bars.map(dateOf))].slice(-5);
    bars = bars.filter((b) => days.includes(dateOf(b)));
  }
  let previousClose;
  if (range === '1d') {
    const q = await call('get_equity_quotes', { symbols: [symbol] }).catch(() => null);
    previousClose = num(q?.results?.[0]?.quote?.adjusted_previous_close);
  }
  return { symbol, range, previousClose, points: bars.map((b) => [Date.parse(b.begins_at) / 1000, Number(b.close_price)]) };
}

// ---------------------------------------------------------------- options
const STRIKES_EACH_SIDE = 30;

async function chainInfo(symbol) {
  return cached('ch:' + symbol, 10 * 60_000, async () => {
    const r = await call('get_option_chains', { underlying_symbol: symbol });
    const chains = (r?.chains || []).filter((c) => c.symbol === symbol);
    const main = chains.find((c) => c.underlying_instruments?.length && c.can_open_position) || chains[0];
    if (!main) {
      const e = new Error('No listed options');
      e.code = 'no_options';
      throw e;
    }
    return main;
  });
}

async function instruments(chainId, isoDate) {
  return cached(`in:${chainId}:${isoDate}`, 10 * 60_000, async () => {
    const all = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const r = await call('get_option_instruments', { chain_id: chainId, expiration_dates: isoDate, state: 'active', ...(cursor ? { cursor } : {}) });
      all.push(...(r?.instruments || r?.results || []));
      cursor = r?.next;
      if (!cursor) break;
    }
    return all;
  });
}

async function quoteIds(ids) {
  const parts = await Promise.all(chunk(ids, 20).map((group) => call('get_option_quotes', { instrument_ids: group })));
  const out = {};
  for (const p of parts)
    for (const r of p?.results || []) {
      const q = r.quote;
      if (q) out[q.instrument_id] = { q, close: num(r.close?.price) ?? num(q.previous_close_price) };
    }
  return out;
}

function toContract(inst, qc, spot) {
  const q = qc?.q || {};
  const strike = Number(inst.strike_price);
  const right = inst.type;
  const mark = num(q.mark_price) || 0;
  return {
    contract: inst.id,
    symbol: inst.chain_symbol,
    right,
    strike,
    expiration: isoToUnix(inst.expiration_date),
    bid: num(q.bid_price) || 0,
    ask: num(q.ask_price) || 0,
    last: mark,
    change: qc?.close ? mark - qc.close : 0,
    percentChange: qc?.close ? (mark / qc.close - 1) * 100 : 0,
    volume: q.volume || 0,
    openInterest: q.open_interest || 0,
    iv: num(q.implied_volatility) || 0,
    itm: spot ? (right === 'call' ? strike < spot : strike > spot) : false,
  };
}

export async function chain(symbol, date) {
  const info = await chainInfo(symbol);
  const expirations = (info.expiration_dates || []).map(isoToUnix);
  if (!expirations.length) throw new Error('No option expirations listed');
  const exp = date && expirations.includes(Number(date)) ? Number(date) : expirations[0];
  const [insts, [underlying]] = await Promise.all([instruments(info.id, unixToIso(exp)), quotes([symbol])]);
  const spot = underlying?.price || 0;
  const strikes = [...new Set(insts.map((i) => Number(i.strike_price)))].sort((a, b) => a - b);
  const at = Math.max(0, strikes.findIndex((k) => k >= spot));
  const keep = new Set(strikes.slice(Math.max(0, at - STRIKES_EACH_SIDE), at + STRIKES_EACH_SIDE));
  const used = insts.filter((i) => keep.has(Number(i.strike_price)));
  const qs = await quoteIds(used.map((i) => i.id));
  const contracts = used.map((i) => toContract(i, qs[i.id], spot)).sort((a, b) => a.strike - b.strike);
  return {
    symbol,
    expirations,
    expiration: exp,
    underlying,
    calls: contracts.filter((c) => c.right === 'call'),
    puts: contracts.filter((c) => c.right === 'put'),
  };
}

export async function contractQuotes(contracts) {
  if (!contracts.length) return {};
  const qs = await quoteIds(contracts.map((c) => c.contract));
  const out = {};
  for (const c of contracts) {
    if (!qs[c.contract]) continue;
    const inst = { id: c.contract, chain_symbol: c.symbol, strike_price: c.strike, type: c.right, expiration_date: unixToIso(c.expiration) };
    out[c.contract] = toContract(inst, qs[c.contract], 0);
    delete out[c.contract].itm;
  }
  return out;
}

// ---------------------------------------------------------------- search
export async function search(q) {
  const r = await call('search', { query: q, limit: 8 });
  return (r?.results || []).map((x) => {
    const name = x.simple_name || x.name || x.symbol;
    rememberName(x.symbol, name);
    return { symbol: x.symbol, name, type: 'EQUITY', exchange: '' };
  });
}

// ---------------------------------------------------------------- per-player save (private to each signed-in player)
let docPromise = null;
function gameDoc() {
  if (!docPromise) {
    docPromise = (async () => {
      const [db, user] = await Promise.all([useCap('db'), useCap('user')]);
      if (!db || !user) return null;
      const id = await user.id().catch(() => null);
      return id ? db.doc(`data/users/${id}/game`) : null;
    })().catch(() => null);
  }
  return docPromise;
}

export async function loadGame() {
  const ref = await gameDoc();
  if (!ref) return null;
  const snap = await ref.get();
  if (!snap.exists) return null;
  const body = snap.data();
  return { game: JSON.parse(body.game), watchlist: body.watchlist || [] };
}

let saveTimer = null;
let saving = false;
let pending = null;
export function saveGame(game, watchlist) {
  pending = { game, watchlist };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 3000);
}
async function flush() {
  if (saving || !pending) return;
  const ref = await gameDoc();
  if (!ref) return;
  const { game, watchlist } = pending;
  pending = null;
  saving = true;
  try {
    // keep the saved copy well under the store's per-document limit
    const slim = { ...game, history: game.history.slice(0, 300), equityHistory: game.equityHistory.slice(-600) };
    await ref.set({ game: JSON.stringify(slim), watchlist: watchlist.slice(0, 40), savedAt: game.savedAt || Date.now() });
  } catch {
    /* browser copy still holds the game; next save retries */
  } finally {
    saving = false;
    if (pending) saveTimer = setTimeout(flush, 3000);
  }
}
