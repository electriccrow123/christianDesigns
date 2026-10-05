// Paper-trading engine: pure functions over a plain JSON state object.
// No DOM access here so it can be unit-tested in Node.

export const OPTION_MULTIPLIER = 100;
export const DEFAULT_SETTINGS = { optionFee: 0.65, stockFee: 0 };
const EPS = 1e-9;

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function newGame(startingBalance = 100000, settings = {}) {
  return {
    version: 1,
    startingBalance,
    cash: startingBalance,
    positions: {}, // key -> position
    orders: [], // pending (working) orders
    history: [], // filled trades + events
    realizedPL: 0,
    totalFees: 0,
    equityHistory: [{ t: Date.now(), v: startingBalance }],
    achievements: {},
    settings: { ...DEFAULT_SETTINGS, ...settings },
    createdAt: Date.now(),
    nextId: 1,
  };
}

// ---------- helpers ----------
export function stockPosition(state, symbol) {
  const p = state.positions[symbol];
  return p && p.type === 'stock' ? p : null;
}

export function optionPositions(state) {
  return Object.values(state.positions).filter((p) => p.type === 'option');
}

/** Cash held as collateral for short (cash-secured) puts. */
export function reservedCash(state) {
  return optionPositions(state)
    .filter((p) => p.qty < 0 && p.right === 'put')
    .reduce((sum, p) => sum + p.strike * OPTION_MULTIPLIER * -p.qty, 0);
}

/** Shares locked up covering short calls on this symbol. */
export function sharesCommitted(state, symbol) {
  return optionPositions(state)
    .filter((p) => p.qty < 0 && p.right === 'call' && p.symbol === symbol)
    .reduce((sum, p) => sum + -p.qty * OPTION_MULTIPLIER, 0);
}

export function buyingPower(state) {
  return round2(state.cash - reservedCash(state));
}

export function optionMark(q) {
  if (!q) return 0;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last || q.ask || q.bid || 0;
}

/** Realistic fill price: buyers pay the ask, sellers receive the bid. Falls back when the book is empty (market closed). */
export function optionFillPrice(q, side) {
  if (!q) return 0;
  if (side === 'buy') return q.ask > 0 ? q.ask : q.last || 0;
  return q.bid > 0 ? q.bid : q.last || 0;
}

export function optionFee(state, contracts) {
  return round2((state.settings?.optionFee ?? DEFAULT_SETTINGS.optionFee) * contracts);
}

function record(state, entry) {
  const e = { id: state.nextId++, t: Date.now(), ...entry };
  state.history.unshift(e);
  if (state.history.length > 1000) state.history.length = 1000;
  return e;
}

const fail = (error) => ({ ok: false, error });

// ---------- stocks ----------
export function tradeStock(state, { symbol, side, qty, price, note }) {
  qty = Math.floor(Number(qty));
  price = Number(price);
  if (!symbol) return fail('Pick a stock first.');
  if (!(qty > 0)) return fail('Quantity must be at least 1 share.');
  if (!(price > 0)) return fail('No valid price available for this stock right now.');
  const fee = state.settings?.stockFee ?? 0;
  const pos = stockPosition(state, symbol);

  if (side === 'buy') {
    const cost = round2(qty * price + fee);
    if (cost > buyingPower(state) + EPS) {
      return fail(`Not enough buying power. Cost $${cost.toFixed(2)} vs buying power $${buyingPower(state).toFixed(2)}.`);
    }
    state.cash = round2(state.cash - cost);
    if (pos) {
      pos.avgCost = (pos.avgCost * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      state.positions[symbol] = { key: symbol, type: 'stock', symbol, qty, avgCost: price, openedAt: Date.now() };
    }
    state.totalFees = round2(state.totalFees + fee);
    state.realizedPL = round2(state.realizedPL - fee);
    const trade = record(state, { kind: 'trade', asset: 'stock', symbol, side, qty, price, amount: -cost, fee, realized: -fee, note });
    return { ok: true, trade };
  }

  if (side === 'sell') {
    const owned = pos ? pos.qty : 0;
    const free = owned - sharesCommitted(state, symbol);
    if (owned <= 0) return fail(`You don't own any ${symbol}. (Short selling isn't enabled in this game.)`);
    if (qty > free) {
      return fail(
        free < owned
          ? `Only ${free} shares are free to sell — ${owned - free} are covering short calls. Buy those calls back first.`
          : `You only own ${owned} shares of ${symbol}.`,
      );
    }
    const proceeds = round2(qty * price - fee);
    const realized = round2((price - pos.avgCost) * qty - fee);
    state.cash = round2(state.cash + proceeds);
    pos.qty -= qty;
    if (pos.qty === 0) delete state.positions[symbol];
    state.totalFees = round2(state.totalFees + fee);
    state.realizedPL = round2(state.realizedPL + realized);
    const trade = record(state, { kind: 'trade', asset: 'stock', symbol, side, qty, price, amount: proceeds, fee, realized, note });
    return { ok: true, trade };
  }
  return fail('Unknown side.');
}

// ---------- options ----------
/**
 * contract: { contract, symbol, right: 'call'|'put', strike, expiration }
 * side: 'buy' | 'sell'. Opens or closes depending on the current position.
 */
export function tradeOption(state, { contract: c, side, qty, price, note }) {
  qty = Math.floor(Number(qty));
  price = Number(price);
  if (!c || !c.contract) return fail('Pick an option contract first.');
  if (!(qty > 0)) return fail('Quantity must be at least 1 contract.');
  if (!(price > 0)) return fail('This contract has no valid price right now (no bid/ask or last trade).');

  const pos = state.positions[c.contract];
  const held = pos ? pos.qty : 0;
  const fee = optionFee(state, qty);
  const notional = round2(price * OPTION_MULTIPLIER * qty);
  let action;

  if (side === 'buy') {
    action = held < 0 ? 'buy_to_close' : 'buy_to_open';
    if (held < 0 && qty > -held) return fail(`You are short ${-held} contracts. Buy at most ${-held} to close (then open a new long separately).`);
    const cost = round2(notional + fee);
    // Closing a short put releases its collateral, which can pay for the buy-back.
    const released = action === 'buy_to_close' && c.right === 'put' ? c.strike * OPTION_MULTIPLIER * qty : 0;
    if (cost > buyingPower(state) + released + EPS) {
      return fail(`Not enough buying power. Cost $${cost.toFixed(2)} vs buying power $${buyingPower(state).toFixed(2)}.`);
    }
  } else if (side === 'sell') {
    action = held > 0 ? 'sell_to_close' : 'sell_to_open';
    if (held > 0 && qty > held) return fail(`You hold ${held} contracts. Sell at most ${held} to close.`);
    if (action === 'sell_to_open') {
      if (c.right === 'call') {
        const shares = stockPosition(state, c.symbol)?.qty || 0;
        const free = shares - sharesCommitted(state, c.symbol);
        if (free < qty * OPTION_MULTIPLIER) {
          return fail(
            `Selling calls requires 100 shares per contract (a covered call). You have ${Math.max(0, free)} free shares of ${c.symbol}; need ${qty * OPTION_MULTIPLIER}.`,
          );
        }
      } else {
        const collateral = c.strike * OPTION_MULTIPLIER * qty;
        if (collateral > buyingPower(state) + notional - fee + EPS) {
          return fail(
            `A cash-secured put needs $${collateral.toLocaleString()} set aside (strike × 100 × contracts). Buying power: $${buyingPower(state).toFixed(2)}.`,
          );
        }
      }
    }
  } else {
    return fail('Unknown side.');
  }

  let realized = -fee;
  const cashDelta = side === 'buy' ? -(notional + fee) : notional - fee;

  if (action === 'buy_to_open' || action === 'sell_to_open') {
    const sign = action === 'buy_to_open' ? 1 : -1;
    if (pos) {
      const absOld = Math.abs(pos.qty);
      pos.avgPrice = (pos.avgPrice * absOld + price * qty) / (absOld + qty);
      pos.qty += sign * qty;
    } else {
      state.positions[c.contract] = {
        key: c.contract,
        type: 'option',
        contract: c.contract,
        symbol: c.symbol,
        right: c.right,
        strike: c.strike,
        expiration: c.expiration,
        qty: sign * qty,
        avgPrice: price,
        openedAt: Date.now(),
      };
    }
  } else {
    // closing
    const perContract = action === 'sell_to_close' ? price - pos.avgPrice : pos.avgPrice - price;
    realized = round2(perContract * OPTION_MULTIPLIER * qty - fee);
    pos.qty += action === 'sell_to_close' ? -qty : qty;
    if (pos.qty === 0) delete state.positions[c.contract];
  }

  state.cash = round2(state.cash + cashDelta);
  state.totalFees = round2(state.totalFees + fee);
  state.realizedPL = round2(state.realizedPL + realized);
  const trade = record(state, {
    kind: 'trade',
    asset: 'option',
    symbol: c.symbol,
    contract: c.contract,
    right: c.right,
    strike: c.strike,
    expiration: c.expiration,
    side,
    action,
    qty,
    price,
    amount: round2(cashDelta),
    fee,
    realized,
    note,
  });
  return { ok: true, trade };
}

// ---------- expiration ----------
/** Yahoo expirations are 00:00 UTC on expiry day; options stop trading at 4pm ET (~20:00-21:00 UTC). */
export function expiryCutoff(expiration) {
  return (expiration + 21 * 3600) * 1000;
}

export function daysToExpiry(expiration, now = Date.now()) {
  return Math.max(0, (expiryCutoff(expiration) - now) / 86400000);
}

/**
 * Settle options past expiration at intrinsic value (cash-settled for simplicity).
 * underlyingPrices: { SYMBOL: price }. Positions with no known price are left for later.
 */
export function settleExpired(state, underlyingPrices, now = Date.now()) {
  const events = [];
  for (const p of optionPositions(state)) {
    if (now < expiryCutoff(p.expiration)) continue;
    const S = underlyingPrices[p.symbol];
    if (!(S > 0)) continue;
    const intrinsic = p.right === 'call' ? Math.max(0, S - p.strike) : Math.max(0, p.strike - S);
    const value = round2(intrinsic * OPTION_MULTIPLIER * p.qty); // + for long, - for short
    const realized = round2((intrinsic - p.avgPrice) * OPTION_MULTIPLIER * p.qty);
    state.cash = round2(state.cash + value);
    state.realizedPL = round2(state.realizedPL + realized);
    delete state.positions[p.key];
    events.push(
      record(state, {
        kind: 'expiration',
        asset: 'option',
        symbol: p.symbol,
        contract: p.contract,
        right: p.right,
        strike: p.strike,
        expiration: p.expiration,
        qty: Math.abs(p.qty),
        side: p.qty > 0 ? 'long' : 'short',
        price: round2(intrinsic),
        underlyingPrice: S,
        amount: value,
        realized,
        note: intrinsic > 0 ? `Expired in the money — settled at $${intrinsic.toFixed(2)} intrinsic value.` : 'Expired worthless.',
      }),
    );
  }
  return events;
}

// ---------- working orders (limit / stop) ----------
/**
 * order: { asset:'stock'|'option', symbol, side, qty, orderType:'limit'|'stop', price (limit or stop price), contract? }
 */
export function placeOrder(state, order) {
  const qty = Math.floor(Number(order.qty));
  const price = Number(order.price);
  if (!(qty > 0)) return fail('Quantity must be at least 1.');
  if (!(price > 0)) return fail(`Enter a ${order.orderType} price above $0.`);
  if (order.orderType === 'stop' && order.side !== 'sell') return fail('Stop orders here are sell stops (stop-loss).');
  if (order.orderType === 'stop' && order.asset === 'stock' && !stockPosition(state, order.symbol)) {
    return fail(`You need to own ${order.symbol} to set a stop-loss.`);
  }
  const o = { id: state.nextId++, createdAt: Date.now(), status: 'working', ...order, qty, price };
  state.orders.push(o);
  return { ok: true, order: o };
}

export function cancelOrder(state, id) {
  const i = state.orders.findIndex((o) => o.id === id);
  if (i < 0) return fail('Order not found.');
  const [o] = state.orders.splice(i, 1);
  record(state, { kind: 'cancel', asset: o.asset, symbol: o.symbol, contract: o.contract, side: o.side, qty: o.qty, price: o.price, note: `Canceled ${o.orderType} order.` });
  return { ok: true };
}

/**
 * Check working orders against fresh prices.
 * stockQuotes: { SYMBOL: { price } }, optionQuotes: { CONTRACT: { bid, ask, last } }
 */
export function processOrders(state, stockQuotes, optionQuotes = {}) {
  const fills = [];
  const rejects = [];
  for (const o of [...state.orders]) {
    let marketPx = 0;
    let fillPx = 0;
    let trigger = false;
    if (o.asset === 'stock') {
      marketPx = stockQuotes[o.symbol]?.price;
      if (!(marketPx > 0)) continue;
      if (o.orderType === 'limit') trigger = o.side === 'buy' ? marketPx <= o.price : marketPx >= o.price;
      else trigger = marketPx <= o.price; // sell stop
      fillPx = marketPx;
    } else {
      const q = optionQuotes[o.contract.contract];
      if (!q) continue;
      marketPx = optionFillPrice(q, o.side);
      if (!(marketPx > 0)) continue;
      if (o.orderType === 'limit') {
        trigger = o.side === 'buy' ? marketPx <= o.price : marketPx >= o.price;
        fillPx = marketPx;
      } else {
        trigger = optionMark(q) <= o.price;
        fillPx = marketPx;
      }
    }
    if (!trigger) continue;
    const res =
      o.asset === 'stock'
        ? tradeStock(state, { symbol: o.symbol, side: o.side, qty: o.qty, price: fillPx, note: `${o.orderType} order filled` })
        : tradeOption(state, { contract: o.contract, side: o.side, qty: o.qty, price: fillPx, note: `${o.orderType} order filled` });
    state.orders = state.orders.filter((x) => x.id !== o.id);
    if (res.ok) fills.push({ order: o, trade: res.trade });
    else {
      rejects.push({ order: o, error: res.error });
      record(state, { kind: 'reject', asset: o.asset, symbol: o.symbol, contract: o.contract?.contract, side: o.side, qty: o.qty, price: o.price, note: `Order canceled at trigger: ${res.error}` });
    }
  }
  return { fills, rejects };
}

// ---------- valuation ----------
/**
 * stockQuotes: { SYMBOL: { price, previousClose } }, optionQuotes: { CONTRACT: { bid, ask, last } }
 */
export function valuePortfolio(state, stockQuotes = {}, optionQuotes = {}) {
  let stocksValue = 0;
  let optionsValue = 0;
  let unrealized = 0;
  let dayChange = 0;
  const rows = [];
  for (const p of Object.values(state.positions)) {
    if (p.type === 'stock') {
      const q = stockQuotes[p.symbol];
      const price = q?.price ?? p.avgCost;
      const value = price * p.qty;
      const pl = (price - p.avgCost) * p.qty;
      const day = q?.previousClose ? (price - q.previousClose) * p.qty : 0;
      stocksValue += value;
      unrealized += pl;
      dayChange += day;
      rows.push({ ...p, price, value, pl, plPct: p.avgCost ? (price / p.avgCost - 1) * 100 : 0, stale: !q });
    } else {
      const q = optionQuotes[p.contract];
      const mark = q ? optionMark(q) : p.avgPrice;
      const value = mark * OPTION_MULTIPLIER * p.qty;
      const pl = (mark - p.avgPrice) * OPTION_MULTIPLIER * p.qty;
      optionsValue += value;
      unrealized += pl;
      rows.push({
        ...p,
        price: mark,
        value,
        pl,
        plPct: p.avgPrice ? ((mark - p.avgPrice) / p.avgPrice) * 100 * Math.sign(p.qty) : 0,
        stale: !q,
      });
    }
  }
  const equity = state.cash + stocksValue + optionsValue;
  return {
    cash: state.cash,
    reserved: reservedCash(state),
    buyingPower: buyingPower(state),
    stocksValue,
    optionsValue,
    equity,
    unrealized,
    realized: state.realizedPL,
    totalPL: equity - state.startingBalance,
    totalPLPct: ((equity - state.startingBalance) / state.startingBalance) * 100,
    dayChange,
    rows,
  };
}

export function recordEquity(state, equity, now = Date.now(), minGapMs = 60_000) {
  const h = state.equityHistory;
  const last = h[h.length - 1];
  if (h.length > 1 && now - last.t < minGapMs) {
    last.v = round2(equity); // keep the latest value in the current bucket (never overwrite the starting point)
    return;
  }
  h.push({ t: now, v: round2(equity) });
  if (h.length > 3000) h.splice(0, h.length - 3000);
}

// ---------- option math (Black-Scholes) for education: greeks, breakevens, payoff ----------
function normCdf(x) {
  // Abramowitz & Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp((-x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
function normPdf(x) {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export function greeks({ S, K, T, iv, right, r = 0.04 }) {
  if (!(S > 0 && K > 0 && T > 0 && iv > 0)) {
    const itm = right === 'call' ? S > K : S < K;
    return { delta: itm ? (right === 'call' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, probITM: itm ? 1 : 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const pdf = normPdf(d1);
  const gamma = pdf / (S * iv * sqrtT);
  const vega = (S * pdf * sqrtT) / 100;
  if (right === 'call') {
    const theta = (-(S * pdf * iv) / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365;
    return { delta: normCdf(d1), gamma, theta, vega, probITM: normCdf(d2) };
  }
  const theta = (-(S * pdf * iv) / (2 * sqrtT) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
  return { delta: normCdf(d1) - 1, gamma, theta, vega, probITM: normCdf(-d2) };
}

/** Profit/loss at expiration for one option leg (per position, in dollars). qty signed. */
export function optionPayoff(S, { right, strike, premium, qty }) {
  const intrinsic = right === 'call' ? Math.max(0, S - strike) : Math.max(0, strike - S);
  return (intrinsic - premium) * OPTION_MULTIPLIER * qty;
}

export function optionRiskProfile({ right, strike, premium, qty, side }) {
  const n = qty * OPTION_MULTIPLIER;
  const cost = premium * n;
  if (side === 'buy') {
    return {
      breakeven: right === 'call' ? strike + premium : strike - premium,
      maxLoss: cost,
      maxProfit: right === 'call' ? Infinity : (strike - premium) * n,
    };
  }
  return {
    breakeven: right === 'call' ? strike + premium : strike - premium,
    maxLoss: right === 'call' ? Infinity : (strike - premium) * n, // covered by shares/cash in this game
    maxProfit: cost,
  };
}

// ---------- achievements ----------
export const ACHIEVEMENTS = [
  { id: 'first_trade', icon: '🎯', name: 'First Fill', desc: 'Place your first trade.' },
  { id: 'first_profit', icon: '💵', name: 'In the Green', desc: 'Close a trade for a profit.' },
  { id: 'first_option', icon: '🧩', name: 'Options Rookie', desc: 'Trade your first option contract.' },
  { id: 'stop_loss', icon: '🛡️', name: 'Risk Manager', desc: 'Set a stop-loss order.' },
  { id: 'limit_order', icon: '🎚️', name: 'Patient Trader', desc: 'Place a limit order.' },
  { id: 'covered_call', icon: '🏠', name: 'Landlord', desc: 'Sell a covered call.' },
  { id: 'csp', icon: '🪙', name: 'Paid to Wait', desc: 'Sell a cash-secured put.' },
  { id: 'diversified', icon: '🌐', name: 'Diversified', desc: 'Hold 5 different stocks at once.' },
  { id: 'cut_loss', icon: '✂️', name: 'Cut Your Losses', desc: 'Close a losing trade (it takes discipline!).' },
  { id: 'up5', icon: '🚀', name: 'Up 5%', desc: 'Grow account equity 5% above the starting balance.' },
  { id: 'up20', icon: '🏆', name: 'Up 20%', desc: 'Grow account equity 20% above the starting balance.' },
  { id: 'ten_trades', icon: '📒', name: 'Logged 10', desc: 'Complete 10 trades.' },
];

export function checkAchievements(state, summary) {
  const unlocked = [];
  const has = (id) => state.achievements[id];
  const give = (id) => {
    if (!has(id)) {
      state.achievements[id] = Date.now();
      unlocked.push(ACHIEVEMENTS.find((a) => a.id === id));
    }
  };
  const trades = state.history.filter((h) => h.kind === 'trade');
  if (trades.length >= 1) give('first_trade');
  if (trades.length >= 10) give('ten_trades');
  const closes = state.history.filter((h) => (h.kind === 'trade' && (h.side === 'sell' && h.asset === 'stock' || /close/.test(h.action || ''))) || h.kind === 'expiration');
  if (closes.some((h) => h.realized > 0)) give('first_profit');
  if (closes.some((h) => h.realized < 0 && h.kind === 'trade' && Math.abs(h.realized) > (h.fee || 0) + 0.01)) give('cut_loss');
  if (trades.some((h) => h.asset === 'option')) give('first_option');
  if (trades.some((h) => h.action === 'sell_to_open' && h.right === 'call')) give('covered_call');
  if (trades.some((h) => h.action === 'sell_to_open' && h.right === 'put')) give('csp');
  if (state.orders.some((o) => o.orderType === 'stop') || state.history.some((h) => /stop/.test(h.note || ''))) give('stop_loss');
  if (state.orders.some((o) => o.orderType === 'limit') || state.history.some((h) => /limit/.test(h.note || ''))) give('limit_order');
  if (Object.values(state.positions).filter((p) => p.type === 'stock').length >= 5) give('diversified');
  if (summary && summary.totalPLPct >= 5) give('up5');
  if (summary && summary.totalPLPct >= 20) give('up20');
  return unlocked.filter(Boolean);
}
