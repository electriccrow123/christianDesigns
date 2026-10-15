// Pure translations between Robinhood connector payloads and the desk's own shapes.
// Shared by the claude.ai page (adapters/hosted.js) and the background autopilot (bin/autopilot.mjs).

import { num, pos, round, maskAccount } from '../core/util.js';

export const OPEN_STATES = new Set(['new', 'queued', 'confirmed', 'unconfirmed', 'partially_filled', 'pending', 'pending_cancelled']);

export function mapAccount(a, approvalSetting) {
  return {
    number: a.account_number,
    masked: maskAccount(a.account_number),
    nickname: a.nickname || (a.brokerage_account_type === 'individual' ? 'Individual' : a.brokerage_account_type),
    type: a.type,
    optionLevel: a.option_level,
    isMargin: /margin/.test(a.type || ''),
    approvalsRequired: !!approvalSetting?.setting?.human_must_approve_trades,
  };
}

/** get_equity_quotes payload → [{symbol, price, prevClose, change, changePct, bid, ask, time}] */
export function mapEquityQuotes(payload) {
  const out = [];
  for (const r of payload?.results || []) {
    const q = r.quote;
    if (!q) continue;
    const regT = Date.parse(q.venue_last_trade_time || 0);
    const extT = Date.parse(q.venue_last_non_reg_trade_time || 0);
    const price = extT > regT && pos(q.last_non_reg_trade_price) ? num(q.last_non_reg_trade_price) : num(q.last_trade_price);
    const prev = num(q.adjusted_previous_close) ?? num(q.previous_close);
    out.push({ symbol: q.symbol, price, prevClose: prev, change: prev ? price - prev : 0, changePct: prev ? round((price / prev - 1) * 100, 2) : 0, bid: pos(q.bid_price), ask: pos(q.ask_price), time: regT || extT });
  }
  return out;
}

/** get_equity_historicals payload → {SYM: [{t,o,h,l,c,v}]} */
export function mapHistoricals(payload) {
  const out = {};
  for (const r of payload?.results || [])
    out[r.symbol] = (r.bars || [])
      .filter((b) => !b.interpolated)
      .map((b) => ({ t: Date.parse(b.begins_at) / 1000, o: Number(b.open_price), h: Number(b.high_price), l: Number(b.low_price), c: Number(b.close_price), v: Number(b.volume) || 0 }));
  return out;
}

export function mapFundamentals(payload) {
  const out = {};
  for (const f of payload?.results || [])
    out[f.symbol] = {
      marketCapB: num(f.market_cap) != null ? round(num(f.market_cap) / 1e9, 2) : undefined,
      pe: num(f.pe_ratio),
      high52: num(f.high_52_weeks),
      low52: num(f.low_52_weeks),
      avgVolume: num(f.average_volume_30_days) ?? num(f.average_volume),
      dividendYield: num(f.dividend_yield),
      sector: f.sector || undefined,
      industry: f.industry || undefined,
    };
  return out;
}

/** get_option_quotes payload → {instrumentId: {bid, ask, mark, iv, delta, ...}} */
export function mapOptionQuotes(payload) {
  const out = {};
  for (const r of payload?.results || []) {
    const q = r.quote || r;
    if (!q?.instrument_id) continue;
    out[q.instrument_id] = {
      bid: num(q.bid_price) || 0,
      ask: num(q.ask_price) || 0,
      mark: num(q.mark_price) ?? num(q.adjusted_mark_price),
      last: num(q.last_trade_price),
      iv: num(q.implied_volatility),
      delta: num(q.delta),
      gamma: num(q.gamma),
      theta: num(q.theta),
      vega: num(q.vega),
      openInterest: num(q.open_interest) || 0,
      volume: num(q.volume) || 0,
      prevClose: num(r.close?.price) ?? num(q.previous_close_price),
    };
  }
  return out;
}

/** get_option_instruments payload → {id: {symbol, right, strike, expiration}} */
export function mapInstruments(payload) {
  const out = {};
  for (const i of payload?.instruments || payload?.results || []) out[i.id] = { symbol: i.chain_symbol, right: i.type, strike: Number(i.strike_price), expiration: i.expiration_date };
  return out;
}

export function mapEquityOrder(o) {
  return {
    id: o.id,
    refId: o.ref_id,
    kind: 'stock',
    symbol: o.symbol,
    side: o.side,
    type: o.trigger === 'stop' ? (o.type === 'limit' ? 'stop_limit' : 'stop_market') : o.type,
    state: o.state,
    qty: num(o.quantity),
    dollars: num(o.dollar_based_amount?.amount),
    filledQty: num(o.cumulative_quantity) || 0,
    price: num(o.price),
    stopPrice: num(o.stop_price),
    avgPrice: num(o.average_price),
    createdAt: o.created_at,
    updatedAt: o.last_transaction_at || o.created_at,
    agent: !!o.agent_initiated,
    positionEffect: o.side === 'buy' ? 'open' : 'close',
    tif: o.time_in_force,
  };
}

export function mapOptionOrder(o) {
  const legs = (o.legs || []).map((l) => ({ contractId: l.option_id, side: l.side, positionEffect: l.position_effect, strike: num(l.strike_price), right: l.option_type, expiration: l.expiration_date, ratio: l.ratio_quantity || 1 }));
  const q = num(o.quantity) || 0;
  const filled = num(o.processed_quantity) || 0;
  return {
    id: o.id,
    refId: o.ref_id,
    kind: 'option',
    symbol: o.chain_symbol,
    side: legs[0]?.side,
    type: o.trigger === 'stop' ? (o.type === 'limit' ? 'stop_limit' : 'stop_market') : o.type,
    state: o.state,
    qty: q,
    filledQty: filled,
    price: num(o.price),
    stopPrice: num(o.stop_price),
    avgPrice: filled ? round((num(o.processed_premium) || 0) / (filled * (num(o.trade_value_multiplier) || 100)), 4) : undefined,
    createdAt: o.created_at,
    updatedAt: o.updated_at || o.created_at,
    agent: !!o.agent_initiated,
    positionEffect: legs[0]?.positionEffect,
    strategy: o.opening_strategy || o.closing_strategy,
    direction: o.direction,
    legs,
    tif: o.time_in_force,
  };
}

export const optionIdOf = (p) => p.option_id || String(p.option || '').split('/').filter(Boolean).pop();

/**
 * Assemble the desk snapshot from raw connector payloads.
 * quotes: {SYM: mapped quote}; optionQuotes: {id: mapped option quote merged with instrument fields}
 */
export function buildSnapshot({ account, portfolio, stockPositions = [], optionPositions = [], quotes = {}, optionQuotes = {}, equityOrders = [], optionOrders = [], approvals = [], pnlTrades = [] }) {
  const held = stockPositions.filter((p) => num(p.quantity) > 0);
  const stocks = held.map((p) => {
    const qn = num(p.quantity);
    const q = quotes[p.symbol] || {};
    const avg = num(p.average_buy_price) ?? 0;
    const price = q.price ?? avg;
    const value = price * qn;
    const cost = avg * qn;
    return { symbol: p.symbol, qty: qn, available: num(p.shares_available_for_sells) ?? qn, avgCost: round(avg, 4), price, prevClose: q.prevClose, value: round(value, 2), cost: round(cost, 2), pl: round(value - cost, 2), plPct: cost ? round(((value - cost) / cost) * 100, 2) : 0, dayPl: q.prevClose ? round((price - q.prevClose) * qn, 2) : 0 };
  });
  const options = optionPositions
    .map((p) => {
      const id = optionIdOf(p);
      const m = optionQuotes[id] || {};
      const mult = num(p.trade_value_multiplier) || 100;
      const qty = (num(p.quantity) || 0) * (p.type === 'short' ? -1 : 1);
      if (!qty) return null;
      const avg = Math.abs(num(p.average_price) || 0) / mult; // Robinhood reports the average price per contract
      const mark = m.mark ?? avg;
      const value = mark * 100 * qty;
      const cost = avg * 100 * qty;
      return { id, symbol: p.chain_symbol || m.symbol, right: m.right, strike: m.strike, expiration: p.expiration_date || m.expiration, qty, avgPrice: round(avg, 4), mark, bid: m.bid, ask: m.ask, delta: m.delta, iv: m.iv, value: round(value, 2), cost: round(cost, 2), pl: round(value - cost, 2), plPct: cost ? round(((value - cost) / Math.abs(cost)) * 100, 2) : 0, dayPl: m.prevClose != null ? round((mark - m.prevClose) * 100 * qty, 2) : 0, pending: ['pending_buy_quantity', 'pending_sell_quantity', 'pending_expired_quantity', 'pending_assignment_quantity', 'pending_exercise_quantity'].some((k) => num(p[k]) > 0) };
    })
    .filter(Boolean);
  const orders = [...equityOrders.map(mapEquityOrder), ...optionOrders.map(mapOptionOrder)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const equity = num(portfolio?.total_value) ?? 0;
  const dayChange = stocks.reduce((a, s) => a + s.dayPl, 0) + options.reduce((a, o) => a + o.dayPl, 0);
  return {
    asOf: Date.now(),
    live: true,
    account,
    portfolio: {
      equity: round(equity, 2),
      cash: num(portfolio?.cash) ?? 0,
      buyingPower: num(portfolio?.buying_power?.buying_power) ?? num(portfolio?.cash) ?? 0,
      stocksValue: num(portfolio?.equity_value) ?? stocks.reduce((a, s) => a + s.value, 0),
      optionsValue: num(portfolio?.options_value) ?? options.reduce((a, o) => a + o.value, 0),
      cryptoValue: num(portfolio?.crypto_value) || 0,
      dayChange: round(dayChange, 2),
      dayChangePct: equity - dayChange ? round((dayChange / (equity - dayChange)) * 100, 2) : 0,
      unrealized: round(stocks.reduce((a, s) => a + s.pl, 0) + options.reduce((a, o) => a + o.pl, 0), 2),
    },
    stocks,
    options,
    openOrders: orders.filter((o) => OPEN_STATES.has(o.state)),
    orders,
    realized: pnlTrades.map((t) => ({ time: Date.parse(t.timestamp), symbol: t.symbol, side: t.side, qty: num(t.quantity), price: num(t.price), gain: num(t.realized_gain) })),
    approvals: approvals.map((a) => ({ id: a.approval_id || a.id, symbol: a.symbol || a.chain_symbol || a.order?.symbol, summary: a.summary || a.description || a.order_summary || '', state: a.state, createdAt: a.created_at, expiresAt: a.expires_at })),
  };
}

const str = (v) => (v == null ? undefined : String(v));

/** Desk ticket → review_equity_order / place_equity_order input. */
export function equityInput(t, accountNumber) {
  const input = { account_number: accountNumber, symbol: t.symbol, side: t.side, type: t.orderType, time_in_force: t.orderType === 'market' ? 'gfd' : t.tif, market_hours: t.marketHours || 'regular_hours' };
  if (t.dollars) input.dollar_amount = t.dollars.toFixed(2);
  else input.quantity = str(t.quantity);
  if (t.limitPrice && (t.orderType === 'limit' || t.orderType === 'stop_limit')) input.limit_price = t.limitPrice.toFixed(t.limitPrice < 1 ? 4 : 2);
  if (t.stopPrice && t.orderType.startsWith('stop')) input.stop_price = t.stopPrice.toFixed(2);
  return input;
}

/** Desk ticket → review_option_order / place_option_order input. */
export function optionInput(t, accountNumber) {
  const input = {
    account_number: accountNumber,
    quantity: str(t.quantity),
    type: t.orderType === 'market' ? 'market' : 'limit',
    time_in_force: t.orderType === 'market' ? 'gfd' : t.tif,
    legs: t.legs.map((l) => ({ option_id: l.contractId, side: l.side, position_effect: l.positionEffect, ...(t.legs.length > 1 ? { ratio_quantity: l.ratio || 1 } : {}) })),
  };
  if (input.type === 'limit') input.price = t.price.toFixed(2);
  if (t.legs.length > 1) input.direction = t.direction;
  return input;
}

/** Pre-trade alerts from a review_* response, as plain strings. */
export function alertsOf(r) {
  const checks = r?.order_checks || r?.alerts || r?.checks || [];
  const list = Array.isArray(checks) ? checks : Object.values(checks);
  return list.map((c) => (typeof c === 'string' ? c : c.detail || c.message || c.title || JSON.stringify(c))).filter(Boolean);
}

/** Read the outcome of a place_* response. */
export function placedOf(r) {
  const order = r?.order || r?.orders?.[0] || r;
  const approvalPending = !!(r?.customer_approval_required || r?.approval_id || r?.approval || /approval/i.test(order?.state || ''));
  return { ok: true, orderId: order?.id || r?.order_id, state: order?.state || (approvalPending ? 'pending_approval' : 'sent'), approvalPending, approvalId: r?.approval_id || r?.approval?.approval_id };
}
