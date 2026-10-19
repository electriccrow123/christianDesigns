// claude.ai runtime: Claude through the `sample` capability, Robinhood through the viewer's own
// Robinhood connector (`mcp`), and storage in the artifact's private database (`db`).

import { num, chunk, round, parseJsonLoose, uniq } from '../core/util.js';
import { createPaperBroker } from '../core/paper.js';
import { todayNY, addDays } from '../core/market-clock.js';
import { mapAccount, mapEquityQuotes, mapHistoricals, mapFundamentals, mapOptionQuotes, mapInstruments, buildSnapshot, equityInput, optionInput, alertsOf, placedOf, optionIdOf } from './robinhood-map.js';

const SERVER = 'Robinhood';
const DAY = 86400000;

const use = (name) => (window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null));

// ------------------------------------------------------------------ errors in viewer words
const MCP_COPY = {
  server_not_connected: 'Connect Robinhood in claude.ai → Settings → Connectors, then reload.',
  selection_required: 'Choose which Robinhood connection this page should use, then reload.',
  needs_reauth: 'Your Robinhood connection expired. Reconnect it in claude.ai → Settings → Connectors.',
  not_in_manifest: 'Robinhood is turned off for this page. Turn it on from the page’s Permissions menu.',
  blocked_by_policy: 'Your organization blocks this Robinhood action for this page.',
  approval_required: 'This Robinhood action needs your approval. Press the button again and choose Allow.',
  server_unavailable: 'Robinhood is temporarily unreachable. Try again in a moment.',
  not_granted: 'Open Crow’s Nest on claude.ai while signed in to connect Robinhood.',
  capability_disabled: 'Robinhood is not available in this view. Open the page on claude.ai.',
  capability_removed: 'Robinhood is not available in this view. Open the page on claude.ai.',
};
const AI_COPY = {
  not_granted: 'Claude is not allowed for this page. Allow it from the Permissions menu to use the agents.',
  sampling_disabled: 'Claude is not available for this account.',
  rate_limited: 'You have hit a usage limit for now. Try again a little later.',
  session_expired: 'Your claude.ai session expired. Sign in again.',
  refused: 'Claude declined this request. Try rephrasing it.',
  prompt_too_large: 'Too much data for one request. Trim the watchlist and try again.',
  invalid_json: 'An agent replied in an unexpected format. Run the cycle again.',
  upstream_error: 'Claude had a temporary problem. Try again.',
  cancelled: 'Stopped.',
  capability_disabled: 'Claude is not available in this view.',
  tools_unavailable: 'Live tools are not available in this view; the agents can still answer from the desk summary.',
};

export function friendly(err, table) {
  const code = err?.code;
  const e = new Error((code && table[code]) || err?.message || 'Request failed.');
  e.code = code;
  e.retryable = !!err?.retryable;
  e.retryAfterMs = err?.retryAfterMs;
  e.raw = err;
  return e;
}

// ------------------------------------------------------------------ Robinhood connector
function connector(mcp) {
  let serverName = SERVER;
  let resolved = false;
  async function resolveName() {
    if (resolved) return;
    resolved = true;
    try {
      const { servers } = await mcp.listTools();
      const hit = servers.find((s) => /robinhood/i.test(s.server));
      if (hit) serverName = hit.server;
    } catch {
      /* keep the declared name */
    }
  }
  async function call(tool, input = {}, { write = false } = {}) {
    await resolveName();
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await mcp.callTool(serverName, tool, input, { cache: false });
        const p = r.payload;
        return p && typeof p === 'object' && 'data' in p ? p.data : p;
      } catch (err) {
        if (!write && err?.retryable && attempt === 0) {
          await new Promise((res) => setTimeout(res, (err.retryAfterMs || 800) + Math.random() * 700));
          continue;
        }
        if (err?.code === 'tool_error') {
          const msg = toolErrorText(err);
          const e = new Error(msg);
          e.code = 'tool_error';
          throw e;
        }
        throw friendly(err, MCP_COPY);
      }
    }
  }
  return { call, get server() {
    return serverName;
  } };
}

function toolErrorText(err) {
  const r = err?.result;
  const text = r?.content?.find?.((c) => c.type === 'text')?.text || err?.message || 'Robinhood reported an error.';
  try {
    const j = JSON.parse(text);
    return j.error?.message || j.message || j.detail || text;
  } catch {
    return String(text).slice(0, 400);
  }
}

// ------------------------------------------------------------------ market data via Robinhood
function createMarket(rh) {
  const cache = new Map();
  async function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return value;
  }

  async function quotes(symbols) {
    symbols = uniq(symbols.map((s) => String(s).toUpperCase()).filter(Boolean));
    if (!symbols.length) return [];
    const parts = await Promise.all(chunk(symbols, 20).map((g) => cached('q:' + g.join(','), 4000, () => rh.call('get_equity_quotes', { symbols: g }))));
    return parts.flatMap(mapEquityQuotes);
  }

  async function bars(symbols, { interval = 'day', days = 400 } = {}) {
    symbols = uniq(symbols.map((s) => s.toUpperCase()));
    const intraday = interval !== 'day' && interval !== 'week';
    const span = intraday ? Math.max(days, 4) : days;
    const start = new Date(Date.now() - span * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
    const ttl = intraday ? 60_000 : 30 * 60_000;
    const parts = await Promise.all(chunk(symbols, 10).map((g) => cached(`b:${interval}:${g.join(',')}`, ttl, () => rh.call('get_equity_historicals', { symbols: g, start_time: start, interval })).catch(() => null)));
    return Object.assign({}, ...parts.map(mapHistoricals));
  }

  async function fundamentals(symbols) {
    symbols = uniq(symbols.map((s) => s.toUpperCase()));
    const parts = await Promise.all(chunk(symbols, 10).map((g) => cached('f:' + g.join(','), 30 * 60_000, () => rh.call('get_equity_fundamentals', { symbols: g })).catch(() => null)));
    return Object.assign({}, ...parts.map(mapFundamentals));
  }

  const chainInfo = (symbol) =>
    cached('ch:' + symbol, 30 * 60_000, async () => {
      const r = await rh.call('get_option_chains', { underlying_symbol: symbol });
      const chains = (r?.chains || r?.results || []).filter((c) => c.symbol === symbol);
      return chains.find((c) => c.underlying_instruments?.length && c.can_open_position !== false) || chains[0] || null;
    });

  async function expirations(symbol) {
    const info = await chainInfo(symbol.toUpperCase());
    return info?.expiration_dates || [];
  }

  async function instruments(chainId, iso) {
    return cached(`in:${chainId}:${iso}`, 30 * 60_000, async () => {
      const all = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const r = await rh.call('get_option_instruments', { chain_id: chainId, expiration_dates: iso, state: 'active', ...(cursor ? { cursor } : {}) });
        all.push(...(r?.instruments || r?.results || []));
        cursor = r?.next;
        if (!cursor) break;
      }
      return all;
    });
  }

  async function quoteIds(ids) {
    const parts = await Promise.all(chunk(uniq(ids), 20).map((g) => rh.call('get_option_quotes', { instrument_ids: g }).catch(() => null)));
    return Object.assign({}, ...parts.map(mapOptionQuotes));
  }

  async function chain(symbol, iso, { spot } = {}) {
    symbol = symbol.toUpperCase();
    const info = await chainInfo(symbol);
    if (!info) return [];
    const insts = await instruments(info.id, iso);
    let keep = insts;
    if (spot) {
      const strikes = [...new Set(insts.map((i) => Number(i.strike_price)))].sort((a, b) => a - b);
      const at = Math.max(0, strikes.findIndex((k) => k >= spot));
      const window = new Set(strikes.slice(Math.max(0, at - 14), at + 14));
      keep = insts.filter((i) => window.has(Number(i.strike_price)));
    }
    const qs = await cached(`oq:${symbol}:${iso}:${keep.length}`, 8000, () => quoteIds(keep.map((i) => i.id)));
    return keep.map((i) => ({ id: i.id, symbol, right: i.type, strike: Number(i.strike_price), expiration: i.expiration_date, ...(qs[i.id] || { bid: 0, ask: 0 }) }));
  }

  async function optionQuotes(contracts) {
    if (!contracts.length) return {};
    const ids = contracts.map((c) => c.id || c.contractId).filter(Boolean);
    const qs = await quoteIds(ids);
    const missing = contracts.filter((c) => c.strike == null || !c.right || !c.expiration).map((c) => c.id || c.contractId);
    const meta = {};
    if (missing.length) {
      const r = await rh.call('get_option_instruments', { ids: missing.join(',') }).catch(() => null);
      Object.assign(meta, mapInstruments(r));
    }
    const out = {};
    for (const c of contracts) {
      const id = c.id || c.contractId;
      if (!qs[id]) continue;
      out[id] = { ...meta[id], right: c.right || meta[id]?.right, strike: c.strike ?? meta[id]?.strike, expiration: c.expiration || meta[id]?.expiration, ...qs[id] };
      if (out[id].mark == null) out[id].mark = out[id].bid && out[id].ask ? (out[id].bid + out[id].ask) / 2 : out[id].last;
    }
    return out;
  }

  async function earnings({ days = 10 } = {}) {
    const d = Math.min(31, Math.max(1, days));
    const r = await cached('earn:' + d, 60 * 60_000, () => rh.call('get_earnings_calendar', { days: d, filter: 'high_market_cap' }));
    return (r?.results || []).map((e) => ({ symbol: e.symbol, date: e.report?.date, timing: e.report?.timing, verified: e.report?.verified, estimate: num(e.eps?.estimate), actual: num(e.eps?.actual), big: true })).filter((e) => e.date);
  }

  async function ratings(symbols) {
    symbols = uniq(symbols.map((s) => s.toUpperCase())).slice(0, 75);
    if (!symbols.length) return {};
    const r = await cached('rt:' + symbols.join(','), 6 * 60 * 60_000, () => rh.call('get_equity_analyst_ratings', { symbols }));
    const out = {};
    for (const x of r?.results || []) {
      if (!x.ratings) continue;
      const t = x.ratings;
      out[x.symbol] = { buy: t.num_buy_ratings, hold: t.num_hold_ratings, sell: t.num_sell_ratings, targetMean: num(t.mean_price_target), targetHigh: num(t.high_price_target), targetLow: num(t.low_price_target) };
    }
    return out;
  }

  async function search(q) {
    const r = await rh.call('search', { query: q, limit: 8 });
    return (r?.results || r?.instruments || []).filter((x) => x.symbol).map((x) => ({ symbol: x.symbol, name: x.simple_name || x.name || x.symbol }));
  }

  return { quotes, bars, fundamentals, expirations, chain, optionQuotes, earnings, ratings, search };
}

// ------------------------------------------------------------------ live Robinhood broker
function createLiveBroker(rh, market) {
  let accountsCache = null;

  async function accounts() {
    if (accountsCache && Date.now() - accountsCache.at < 10 * 60_000) return accountsCache.list;
    const r = await rh.call('get_accounts');
    accountsCache = { at: Date.now(), list: r?.accounts || [] };
    return accountsCache.list;
  }

  async function pickAccount(accountNumber) {
    const list = await accounts();
    const agentic = list.filter((a) => a.agentic_allowed);
    const a = (accountNumber && agentic.find((x) => x.account_number === accountNumber)) || agentic[0];
    if (!a) {
      const e = new Error('No Robinhood account is open to this agent. Turn on agentic trading for an account in the Robinhood app.');
      e.code = 'no_agentic_account';
      throw e;
    }
    return a;
  }

  async function account({ accountNumber } = {}) {
    const a = await pickAccount(accountNumber);
    const setting = await rh.call('get_trade_approval_setting', { account_number: a.account_number }).catch(() => null);
    return mapAccount(a, setting);
  }

  async function allPages(tool, input, key, max = 4) {
    const out = [];
    let cursor;
    for (let i = 0; i < max; i++) {
      const r = await rh.call(tool, { ...input, ...(cursor ? { cursor } : {}) });
      out.push(...(r?.[key] || []));
      cursor = r?.next;
      if (!cursor) break;
    }
    return out;
  }

  async function snapshot({ accountNumber } = {}) {
    const acct = await account({ accountNumber });
    const an = acct.number;
    const since = addDays(todayNY(), -30);
    const [portfolio, stockPos, optPos, eqOrders, opOrders, approvals, pnl] = await Promise.all([
      rh.call('get_portfolio', { account_number: an }),
      allPages('get_equity_positions', { account_number: an }, 'positions'),
      allPages('get_option_positions', { account_number: an, nonzero: true }, 'positions'),
      rh.call('get_equity_orders', { account_number: an, created_at_gte: since }).catch(() => null),
      rh.call('get_option_orders', { account_number: an, created_at_gte: since }).catch(() => null),
      rh.call('get_trade_approvals', { account_number: an }).catch(() => null),
      rh.call('get_pnl_trade_history', { account_number: an, span: 'month' }).catch(() => null),
    ]);
    const held = stockPos.filter((p) => num(p.quantity) > 0);
    const quotes = Object.fromEntries((await market.quotes(held.map((p) => p.symbol)).catch(() => [])).map((q) => [q.symbol, q]));
    const optIds = optPos.map(optionIdOf).filter(Boolean);
    const optionQuotes = optIds.length ? await market.optionQuotes(optIds.map((id) => ({ id }))).catch(() => ({})) : {};
    return buildSnapshot({ account: acct, portfolio, stockPositions: stockPos, optionPositions: optPos, quotes, optionQuotes, equityOrders: eqOrders?.orders || [], optionOrders: opOrders?.orders || [], approvals: approvals?.approvals || [], pnlTrades: pnl?.trades || [] });
  }

  async function preview(t, { accountNumber } = {}) {
    const acct = await pickAccount(accountNumber);
    const an = acct.account_number;
    const r = t.kind === 'stock' ? await rh.call('review_equity_order', equityInput(t, an), { write: true }) : await rh.call('review_option_order', { ...optionInput(t, an), chain_symbol: t.symbol, underlying_type: 'equity' }, { write: true });
    const alerts = alertsOf(r);
    return { ok: !alerts.length, alerts, approvalRequired: !!r?.customer_approval_required, estimate: r?.estimate || r?.quote || null, raw: r };
  }

  async function place(t, { accountNumber } = {}) {
    const acct = await pickAccount(accountNumber);
    const an = acct.account_number;
    const [tool, input] = t.kind === 'stock' ? ['place_equity_order', { ...equityInput(t, an), ref_id: t.id }] : ['place_option_order', { ...optionInput(t, an), ref_id: t.id }];
    let r;
    try {
      r = await rh.call(tool, input, { write: true });
    } catch (err) {
      if (err?.code === 'tool_error') throw err; // Robinhood answered: the order was refused
      // No clear answer. A resend with the same ref_id is the same order to Robinhood, so one retry cannot double it.
      await new Promise((res) => setTimeout(res, 1500));
      r = await rh.call(tool, input, { write: true });
    }
    return { ...placedOf(r), raw: r };
  }

  async function cancel(order, { accountNumber } = {}) {
    const acct = await pickAccount(accountNumber);
    const tool = order.kind === 'option' ? 'cancel_option_order' : 'cancel_equity_order';
    await rh.call(tool, { account_number: acct.account_number, order_id: order.id }, { write: true });
    return { ok: true };
  }

  return { live: true, kind: 'robinhood', label: 'Robinhood', account, accounts, snapshot, preview, place, cancel };
}

// ------------------------------------------------------------------ Claude via `sample`
function createAI(sample) {
  if (!sample) return null;
  const opts = (o = {}) => {
    const out = { modelTier: o.tier || 'default' };
    if (o.signal) out.signal = o.signal;
    if (o.onText) out.onText = o.onText;
    if (o.tools?.length) out.tools = o.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: t.execute }));
    else out.cache = o.cache === undefined ? false : o.cache;
    if (o.effort) out.effort = o.effort;
    return out;
  };
  async function text(input, o = {}) {
    try {
      const r = await sample(input, opts(o));
      return { text: r.text, truncated: r.truncated };
    } catch (err) {
      if (err?.code === 'tools_unavailable' && o.tools) return text(input, { ...o, tools: undefined });
      throw friendly(err, AI_COPY);
    }
  }
  return {
    available: true,
    text,
    async json(prompt, o = {}) {
      try {
        return await sample.json(prompt, opts(o));
      } catch (err) {
        if (err?.code === 'invalid_json' && err.text) {
          try {
            return parseJsonLoose(err.text);
          } catch {
            /* fall through */
          }
        }
        throw friendly(err, AI_COPY);
      }
    },
  };
}

// ------------------------------------------------------------------ storage via `db`
function createStore(db) {
  if (!db) return createLocalStore();
  const toObj = (snap) => (snap.exists ? { ...snap.data() } : null);
  return {
    kind: 'db',
    async get(path) {
      return toObj(await db.doc(path).get());
    },
    async set(path, data) {
      await db.doc(path).set(JSON.parse(JSON.stringify(data)));
    },
    async update(path, data) {
      await db.doc(path).update(JSON.parse(JSON.stringify(data)));
    },
    async remove(path) {
      await db.doc(path).delete();
    },
    async list(collection, { orderBy, dir = 'asc', limit = 100 } = {}) {
      let q = db.collection(collection);
      if (orderBy) q = q.orderBy(orderBy, dir);
      q = q.limit(Math.min(1000, limit));
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    watch(path, cb) {
      return db.doc(path).onSnapshot((s) => cb(toObj(s)), () => {});
    },
    watchList(collection, { orderBy, dir = 'asc', limit = 100 } = {}, cb) {
      let q = db.collection(collection);
      if (orderBy) q = q.orderBy(orderBy, dir);
      q = q.limit(limit);
      return q.onSnapshot((s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), () => {});
    },
  };
}

/** Fallback when the page runs without its database: this browser only. */
export function createLocalStore(prefix = 'crowsnest:') {
  const mem = new Map();
  const read = (k) => {
    try {
      const v = localStorage.getItem(prefix + k);
      return v ? JSON.parse(v) : mem.get(k) ?? null;
    } catch {
      return mem.get(k) ?? null;
    }
  };
  const write = (k, v) => {
    mem.set(k, v);
    try {
      localStorage.setItem(prefix + k, JSON.stringify(v));
    } catch {
      /* storage full or blocked: memory copy stays */
    }
  };
  const keys = () => {
    const out = new Set(mem.keys());
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) out.add(k.slice(prefix.length));
      }
    } catch {
      /* ignore */
    }
    return [...out];
  };
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());
  const store = {
    kind: 'local',
    async get(path) {
      return read(path);
    },
    async set(path, data) {
      write(path, JSON.parse(JSON.stringify(data)));
      notify();
    },
    async update(path, data) {
      write(path, { ...(read(path) || {}), ...data });
      notify();
    },
    async remove(path) {
      mem.delete(path);
      try {
        localStorage.removeItem(prefix + path);
      } catch {
        /* ignore */
      }
      notify();
    },
    async list(collection, { orderBy, dir = 'asc', limit = 100 } = {}) {
      const rows = keys()
        .filter((k) => k.startsWith(collection + '/') && k.split('/').length === collection.split('/').length + 1)
        .map((k) => ({ id: k.split('/').pop(), ...read(k) }));
      if (orderBy) rows.sort((a, b) => ((a[orderBy] ?? Infinity) > (b[orderBy] ?? Infinity) ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      return rows.slice(0, limit);
    },
    watch(path, cb) {
      const fn = () => cb(read(path));
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
    watchList(collection, opts, cb) {
      const fn = async () => cb(await store.list(collection, opts));
      listeners.add(fn);
      fn();
      return () => listeners.delete(fn);
    },
  };
  return store;
}

// ------------------------------------------------------------------ assemble
export async function createHostedRuntime() {
  const [mcp, sample, db] = await Promise.all([use('mcp'), use('sample'), use('db')]);
  const store = createStore(db);
  const rh = mcp ? connector(mcp) : null;
  const market = rh ? createMarket(rh) : null;
  const live = rh ? createLiveBroker(rh, market) : null;
  const paper = market
    ? createPaperBroker({
        market,
        load: () => store.get('desk/paper'),
        save: (st) => store.set('desk/paper', st),
      })
    : null;
  return {
    kind: 'hosted',
    hasDb: !!db,
    market,
    brokers: { live, paper },
    ai: createAI(sample),
    store,
    capabilities: { mcp: !!mcp, sample: !!sample, db: !!db },
    marketError: mcp ? null : friendly({ code: 'not_granted' }, MCP_COPY),
  };
}
