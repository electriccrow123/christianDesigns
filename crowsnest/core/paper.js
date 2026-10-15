// Paper broker: the same interface as the live Robinhood broker, with simulated fills at real
// market prices. Used for practice, training and for testing a mode before going live.

import { round, uuid } from './util.js';
import { MULTIPLIER } from './options.js';
import { todayNY, daysBetween } from './market-clock.js';
import { orderCost } from './risk.js';

const MAX_HISTORY = 400;

const inferStrategyLabel = (o) => (o.qty > 0 ? `Long ${o.right}` : o.right === 'put' ? 'Short put' : 'Short call');

export function freshPaperState(startCash = 10000) {
  return { version: 1, cash: startCash, startCash, createdAt: Date.now(), stocks: {}, options: {}, orders: [], realized: [] };
}

/**
 * @param {object} deps
 * @param {object} deps.market  market-data provider (quotes, optionQuotes)
 * @param {() => Promise<object|null>} deps.load
 * @param {(state: object) => Promise<void>} deps.save
 */
export function createPaperBroker({ market, load, save, startCash = 10000 }) {
  let state = null;
  async function S() {
    if (!state) state = (await load().catch(() => null)) || freshPaperState(startCash);
    return state;
  }
  async function persist() {
    state.orders = state.orders.slice(-MAX_HISTORY);
    state.realized = state.realized.slice(-MAX_HISTORY);
    await save(state).catch(() => {});
  }

  function reservedCash(st) {
    // Cash set aside for short puts and credit spreads.
    let r = 0;
    for (const o of Object.values(st.options)) if (o.qty < 0 && o.collateral) r += o.collateral;
    for (const ord of st.orders) if (ord.state === 'queued' && ord.ticket.positionEffect === 'open') r += ord.hold || 0;
    return r;
  }

  async function quoteMap(symbols) {
    if (!symbols.length) return {};
    const qs = await market.quotes(symbols);
    return Object.fromEntries(qs.map((q) => [q.symbol, q]));
  }

  async function optionMarks(st) {
    const list = Object.entries(st.options).map(([id, o]) => ({ id, ...o }));
    if (!list.length) return {};
    return market.optionQuotes(list).catch(() => ({}));
  }

  /** Try to fill one order against current prices. Returns true when it filled. */
  function tryFill(st, ord, q, oq) {
    const t = ord.ticket;
    const now = Date.now();
    if (t.kind === 'stock') {
      const bid = q?.bid || q?.price;
      const ask = q?.ask || q?.price;
      const last = q?.price;
      if (!last) return false;
      let fillPx = null;
      if (t.orderType === 'market') fillPx = t.side === 'buy' ? ask : bid;
      else if (t.orderType === 'limit') {
        if (t.side === 'buy' && t.limitPrice >= ask) fillPx = ask;
        if (t.side === 'sell' && t.limitPrice <= bid) fillPx = bid;
      } else if (t.orderType === 'stop_market' || t.orderType === 'stop_limit') {
        const hit = t.side === 'sell' ? last <= t.stopPrice : last >= t.stopPrice;
        if (hit) {
          if (t.orderType === 'stop_market') fillPx = t.side === 'buy' ? ask : bid;
          else if (t.side === 'buy' ? t.limitPrice >= ask : t.limitPrice <= bid) fillPx = t.side === 'buy' ? ask : bid;
        }
      }
      if (!fillPx) return false;
      let qty = t.quantity || round(t.dollars / fillPx, 6);
      const pos = st.stocks[t.symbol] || { qty: 0, avgCost: 0 };
      if (t.side === 'buy') {
        const cost = qty * fillPx;
        if (cost > st.cash - reservedCash(st) + (ord.hold || 0) + 1e-6) {
          ord.state = 'rejected';
          ord.reason = 'Not enough cash.';
          return false;
        }
        st.cash -= cost;
        pos.avgCost = (pos.avgCost * pos.qty + cost) / (pos.qty + qty);
        pos.qty = round(pos.qty + qty, 6);
        st.stocks[t.symbol] = pos;
      } else {
        qty = Math.min(qty, pos.qty);
        if (!(qty > 0)) {
          ord.state = 'rejected';
          ord.reason = 'No shares to sell.';
          return false;
        }
        st.cash += qty * fillPx;
        const gain = (fillPx - pos.avgCost) * qty;
        st.realized.push({ time: now, symbol: t.symbol, side: 'sell', qty, price: fillPx, gain: round(gain, 2) });
        pos.qty = round(pos.qty - qty, 6);
        if (pos.qty <= 1e-6) delete st.stocks[t.symbol];
        else st.stocks[t.symbol] = pos;
      }
      Object.assign(ord, { state: 'filled', filledQty: qty, avgPrice: round(fillPx, 4), updatedAt: now });
      return true;
    }
    // Options: price the whole order at its natural (cross the spread) and mid.
    let natural = 0;
    let mid = 0;
    for (const l of t.legs) {
      const m = oq[l.contractId] || {};
      const b = m.bid || 0;
      const a = m.ask || m.mark || 0;
      const md = m.mark || (b + a) / 2;
      if (!a && !md) return false;
      natural += (l.side === 'buy' ? a : -b) * l.ratio;
      mid += (l.side === 'buy' ? md : -md) * l.ratio;
    }
    const debit = natural >= 0;
    let net = null;
    if (t.orderType === 'market') net = natural;
    else if (debit && t.price >= mid - 1e-9) net = Math.min(t.price, natural);
    else if (!debit && -t.price <= mid + 1e-9) net = Math.max(-t.price, natural);
    if (net == null) return false;
    const n = t.quantity;
    const cash = -net * MULTIPLIER * n;
    if (cash < 0 && -cash > st.cash - reservedCash(st) + (ord.hold || 0) + 1e-6) {
      ord.state = 'rejected';
      ord.reason = 'Not enough cash.';
      return false;
    }
    st.cash += cash;
    for (const l of t.legs) {
      const m = oq[l.contractId] || {};
      const legPx = l.side === 'buy' ? m.ask || m.mark || 0 : m.bid || m.mark || 0;
      const signed = (l.side === 'buy' ? 1 : -1) * l.ratio * n;
      const cur = st.options[l.contractId] || { symbol: t.symbol, right: l.right, strike: l.strike, expiration: l.expiration, qty: 0, avgPrice: 0 };
      if (Math.sign(cur.qty) === Math.sign(signed) || cur.qty === 0) {
        cur.avgPrice = (cur.avgPrice * Math.abs(cur.qty) + legPx * Math.abs(signed)) / (Math.abs(cur.qty) + Math.abs(signed));
        cur.qty += signed;
      } else {
        const closing = Math.min(Math.abs(cur.qty), Math.abs(signed));
        const gain = (cur.qty > 0 ? legPx - cur.avgPrice : cur.avgPrice - legPx) * closing * MULTIPLIER;
        st.realized.push({ time: now, symbol: `${t.symbol} ${l.strike}${l.right === 'call' ? 'C' : 'P'} ${l.expiration}`, side: l.side, qty: closing, price: legPx, gain: round(gain, 2) });
        cur.qty += signed;
      }
      if (cur.qty === 0) delete st.options[l.contractId];
      else st.options[l.contractId] = cur;
    }
    // Collateral for short premium positions
    if (t.positionEffect === 'open' && ['cash_secured_put', 'put_credit_spread', 'call_credit_spread'].includes(t.strategy)) {
      const short = t.legs.find((l) => l.side === 'sell');
      if (short && st.options[short.contractId]) st.options[short.contractId].collateral = (st.options[short.contractId].collateral || 0) + orderCost({ ...t, price: Math.abs(net) }, null);
    }
    Object.assign(ord, { state: 'filled', filledQty: n, avgPrice: round(Math.abs(net), 4), updatedAt: now });
    return true;
  }

  async function settleExpired(st) {
    const today = todayNY();
    const expired = Object.entries(st.options).filter(([, o]) => o.expiration < today);
    if (!expired.length) return;
    const qs = await quoteMap([...new Set(expired.map(([, o]) => o.symbol))]).catch(() => ({}));
    for (const [id, o] of expired) {
      const spot = qs[o.symbol]?.prevClose || qs[o.symbol]?.price;
      if (!spot) continue;
      const intrinsic = o.right === 'call' ? Math.max(0, spot - o.strike) : Math.max(0, o.strike - spot);
      const value = intrinsic * MULTIPLIER * o.qty;
      st.cash += value;
      const gain = (o.qty > 0 ? intrinsic - o.avgPrice : o.avgPrice - intrinsic) * Math.abs(o.qty) * MULTIPLIER;
      st.realized.push({ time: Date.now(), symbol: `${o.symbol} ${o.strike}${o.right === 'call' ? 'C' : 'P'} ${o.expiration}`, side: 'expire', qty: Math.abs(o.qty), price: round(intrinsic, 2), gain: round(gain, 2) });
      delete st.options[id];
    }
  }

  async function tick() {
    const st = await S();
    await settleExpired(st);
    const working = st.orders.filter((o) => o.state === 'queued');
    if (working.length) {
      const qs = await quoteMap([...new Set(working.map((o) => o.ticket.symbol))]);
      const legs = working.flatMap((o) => o.ticket.legs || []).map((l) => ({ id: l.contractId, ...l }));
      const oq = legs.length ? await market.optionQuotes(legs).catch(() => ({})) : {};
      for (const o of working) {
        if (o.ticket.tif === 'gfd' && todayNY(new Date(o.createdAt)) !== todayNY()) {
          o.state = 'cancelled';
          o.reason = 'Day order expired.';
          continue;
        }
        tryFill(st, o, qs[o.ticket.symbol], oq);
      }
    }
    await persist();
  }

  const account = async () => ({ number: 'PAPER', masked: 'Paper', nickname: 'Paper trading', type: 'cash', optionLevel: 'option_level_3', approvalsRequired: false, isMargin: false });

  return {
    live: false,
    kind: 'paper',
    label: 'Paper account',
    account,
    async snapshot() {
      const st = await S();
      await tick();
      const syms = Object.keys(st.stocks);
      const qs = await quoteMap(syms).catch(() => ({}));
      const om = await optionMarks(st);
      const stocks = syms.map((s) => {
        const p = st.stocks[s];
        const q = qs[s] || {};
        const price = q.price ?? p.avgCost;
        const value = price * p.qty;
        const cost = p.avgCost * p.qty;
        return { symbol: s, qty: p.qty, available: p.qty, avgCost: round(p.avgCost, 4), price, prevClose: q.prevClose, value: round(value, 2), cost: round(cost, 2), pl: round(value - cost, 2), plPct: cost ? round(((value - cost) / cost) * 100, 2) : 0, dayPl: q.prevClose ? round((price - q.prevClose) * p.qty, 2) : 0 };
      });
      const options = Object.entries(st.options).map(([id, o]) => {
        const m = om[id] || {};
        const mark = m.mark ?? o.avgPrice;
        const value = mark * MULTIPLIER * o.qty;
        const cost = o.avgPrice * MULTIPLIER * o.qty;
        return { id, symbol: o.symbol, right: o.right, strike: o.strike, expiration: o.expiration, qty: o.qty, avgPrice: round(o.avgPrice, 4), mark, bid: m.bid, ask: m.ask, delta: m.delta, iv: m.iv, value: round(value, 2), cost: round(cost, 2), pl: round(value - cost, 2), plPct: cost ? round(((value - cost) / Math.abs(cost)) * 100, 2) : 0, dayPl: m.prevClose != null ? round((mark - m.prevClose) * MULTIPLIER * o.qty, 2) : 0, strategyLabel: inferStrategyLabel(o) };
      });
      const stocksValue = stocks.reduce((a, s) => a + s.value, 0);
      const optionsValue = options.reduce((a, o) => a + o.value, 0);
      const equity = st.cash + stocksValue + optionsValue;
      const dayChange = stocks.reduce((a, s) => a + s.dayPl, 0) + options.reduce((a, o) => a + o.dayPl, 0);
      const orders = st.orders.slice().reverse().map(orderView);
      return {
        asOf: Date.now(),
        live: false,
        account: await account(),
        portfolio: {
          equity: round(equity, 2),
          cash: round(st.cash, 2),
          buyingPower: round(Math.max(0, st.cash - reservedCash(st)), 2),
          stocksValue: round(stocksValue, 2),
          optionsValue: round(optionsValue, 2),
          dayChange: round(dayChange, 2),
          dayChangePct: equity - dayChange ? round((dayChange / (equity - dayChange)) * 100, 2) : 0,
          unrealized: round(stocks.reduce((a, s) => a + s.pl, 0) + options.reduce((a, o) => a + o.pl, 0), 2),
          startCash: st.startCash,
        },
        stocks,
        options,
        openOrders: orders.filter((o) => o.state === 'queued'),
        orders,
        realized: st.realized.slice().reverse(),
        approvals: [],
      };
    },
    async preview(ticket) {
      const st = await S();
      const q = (await quoteMap([ticket.symbol]))[ticket.symbol];
      const cost = orderCost(ticket, q);
      const alerts = [];
      if (cost > st.cash - reservedCash(st)) alerts.push(`Not enough paper cash: needs $${round(cost, 2)}, available $${round(st.cash - reservedCash(st), 2)}.`);
      return { ok: !alerts.length, alerts, approvalRequired: false, estimate: { cost } };
    },
    async place(ticket) {
      const st = await S();
      const ord = { id: uuid(), ticket, state: 'queued', createdAt: Date.now(), updatedAt: Date.now(), agent: !!ticket.meta?.agent };
      if (ticket.positionEffect === 'open') ord.hold = orderCost(ticket, null);
      st.orders.push(ord);
      const qs = await quoteMap([ticket.symbol]);
      const oq = ticket.legs?.length ? await market.optionQuotes(ticket.legs.map((l) => ({ id: l.contractId, ...l }))).catch(() => ({})) : {};
      tryFill(st, ord, qs[ticket.symbol], oq);
      if (ord.state === 'filled' || ord.state === 'rejected') delete ord.hold;
      await persist();
      return { ok: ord.state !== 'rejected', orderId: ord.id, state: ord.state, reason: ord.reason, approvalPending: false };
    },
    async cancel(order) {
      const st = await S();
      const o = st.orders.find((x) => x.id === order.id);
      if (o && o.state === 'queued') {
        o.state = 'cancelled';
        delete o.hold;
        await persist();
        return { ok: true };
      }
      return { ok: false, reason: 'Order is not working.' };
    },
    async reset(cash = startCash) {
      state = freshPaperState(cash);
      await persist();
    },
    tick,
  };
}

function orderView(o) {
  const t = o.ticket;
  return {
    id: o.id,
    kind: t.kind,
    symbol: t.symbol,
    side: t.kind === 'option' ? t.legs[0]?.side : t.side,
    type: t.orderType,
    state: o.state,
    qty: t.quantity,
    dollars: t.dollars,
    filledQty: o.filledQty || 0,
    price: t.kind === 'option' ? t.price : t.limitPrice,
    stopPrice: t.stopPrice,
    avgPrice: o.avgPrice,
    createdAt: new Date(o.createdAt).toISOString(),
    updatedAt: new Date(o.updatedAt || o.createdAt).toISOString(),
    agent: !!o.agent,
    positionEffect: t.positionEffect,
    strategy: t.strategy,
    legs: t.legs,
    refId: t.id,
    reason: o.reason,
    daysOld: daysBetween(todayNY(new Date(o.createdAt)), todayNY()),
  };
}
