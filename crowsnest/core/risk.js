// The risk gate. Every order the agents want to send passes through here first. It is plain code,
// not AI, so the limits hold no matter what a model says. It can approve, shrink (resize) or block.

import { round, tickRound, uuid, saneQuote } from './util.js';
import { MULTIPLIER, optionLevelNumber, STRATEGIES } from './options.js';
import { daysBetween } from './market-clock.js';

const PDT_EQUITY = 25000;

/**
 * Normalize a raw ticket (from the Operator agent, the chat, or the user) into the shape the gate
 * and brokers understand. Unknown fields are dropped.
 */
export function normalizeTicket(raw = {}) {
  const t = {
    id: raw.id || uuid(),
    kind: raw.kind === 'option' || raw.legs?.length ? 'option' : 'stock',
    symbol: String(raw.symbol || '').toUpperCase().trim(),
    side: raw.side === 'sell' ? 'sell' : 'buy',
    positionEffect: raw.positionEffect === 'close' ? 'close' : 'open',
    strategy: raw.strategy || (raw.legs?.length ? null : 'stock'),
    quantity: Number(raw.quantity) > 0 ? Number(raw.quantity) : null,
    dollars: Number(raw.dollars) > 0 ? round(Number(raw.dollars), 2) : null,
    orderType: ['market', 'limit', 'stop_market', 'stop_limit'].includes(raw.orderType) ? raw.orderType : 'limit',
    limitPrice: Number(raw.limitPrice) > 0 ? Number(raw.limitPrice) : null,
    stopPrice: Number(raw.stopPrice) > 0 ? Number(raw.stopPrice) : null,
    tif: raw.tif === 'gtc' ? 'gtc' : 'gfd',
    marketHours: raw.marketHours === 'extended_hours' ? 'extended_hours' : 'regular_hours',
    exit: raw.exit ? { stop: Number(raw.exit.stop) || null, target: Number(raw.exit.target) || null, timeStop: raw.exit.timeStop || null } : null,
    conviction: Number(raw.conviction) || null,
    why: raw.why || raw.note || '',
    meta: raw.meta || {},
  };
  if (t.kind === 'stock' && t.side === 'sell') t.positionEffect = 'close'; // no short selling
  if (t.kind === 'option') {
    t.legs = (raw.legs || []).map((l) => ({
      contractId: String(l.contractId || l.optionId || l.option_id || ''),
      symbol: (l.symbol || t.symbol || '').toUpperCase(),
      right: l.right === 'put' ? 'put' : 'call',
      strike: Number(l.strike),
      expiration: l.expiration,
      side: l.side === 'sell' ? 'sell' : 'buy',
      positionEffect: (l.positionEffect || t.positionEffect) === 'close' ? 'close' : 'open',
      ratio: Number(l.ratio) > 0 ? Number(l.ratio) : 1,
      bid: Number(l.bid) || 0,
      ask: Number(l.ask) || 0,
      mid: Number(l.mid) || 0,
      delta: l.delta != null ? Number(l.delta) : undefined,
      openInterest: Number(l.openInterest) || 0,
      dte: l.dte != null ? Number(l.dte) : undefined,
      spreadPct: l.spreadPct != null ? Number(l.spreadPct) : undefined,
    }));
    t.quantity = t.quantity ? Math.floor(t.quantity) : null;
    t.dollars = null;
    t.orderType = t.legs.length > 1 ? 'limit' : t.orderType;
    t.price = Number(raw.price ?? raw.limitPrice) > 0 ? Number(raw.price ?? raw.limitPrice) : null;
    t.direction = raw.direction === 'credit' || raw.direction === 'debit' ? raw.direction : inferDirection(t.legs);
    t.strategy = raw.strategy || inferStrategy(t.legs);
    t.positionEffect = t.legs.every((l) => l.positionEffect === 'close') ? 'close' : 'open';
    t.side = t.legs[0]?.side || t.side;
  }
  return t;
}

function inferDirection(legs) {
  const net = legs.reduce((a, l) => a + (l.side === 'buy' ? 1 : -1) * (l.mid || (l.bid + l.ask) / 2 || 0) * l.ratio, 0);
  return net >= 0 ? 'debit' : 'credit';
}

export function inferStrategy(legs) {
  if (!legs?.length) return 'stock';
  if (legs.length === 1) {
    const l = legs[0];
    if (l.side === 'buy') return l.right === 'call' ? 'long_call' : 'long_put';
    return l.right === 'call' ? 'covered_call' : 'cash_secured_put';
  }
  if (legs.length === 2 && legs[0].right === legs[1].right) {
    const buy = legs.find((l) => l.side === 'buy');
    const sell = legs.find((l) => l.side === 'sell');
    if (!buy || !sell) return 'unknown';
    if (legs[0].right === 'call') return buy.strike < sell.strike ? 'call_debit_spread' : 'call_credit_spread';
    return buy.strike > sell.strike ? 'put_debit_spread' : 'put_credit_spread';
  }
  return 'multi_leg';
}

/** Dollars an order ties up (cost for buys, collateral for short premium). */
export function orderCost(t, quote) {
  if (t.kind === 'stock') {
    if (t.side === 'sell') return 0;
    if (t.dollars) return t.dollars;
    const px = t.limitPrice || t.stopPrice || quote?.ask || quote?.price || 0;
    return round((t.quantity || 0) * px, 2);
  }
  const q = t.quantity || 0;
  if (t.positionEffect === 'close') return 0;
  const legs = t.legs || [];
  const price = t.price || 0;
  switch (t.strategy) {
    case 'long_call':
    case 'long_put':
    case 'call_debit_spread':
    case 'put_debit_spread':
      return round(price * MULTIPLIER * q, 2);
    case 'cash_secured_put': {
      const k = legs[0]?.strike || 0;
      return round((k - price) * MULTIPLIER * q, 2);
    }
    case 'put_credit_spread':
    case 'call_credit_spread': {
      const width = Math.abs((legs[0]?.strike || 0) - (legs[1]?.strike || 0));
      return round((width - price) * MULTIPLIER * q, 2);
    }
    case 'covered_call':
      return 0; // shares are the collateral
    default:
      return round(price * MULTIPLIER * q, 2);
  }
}

/** Worst-case loss for the order as written (used for option sizing). */
export function maxLossOf(t, quote) {
  if (t.kind === 'stock') return orderCost(t, quote);
  if (['long_call', 'long_put', 'call_debit_spread', 'put_debit_spread', 'put_credit_spread', 'call_credit_spread', 'cash_secured_put'].includes(t.strategy)) return orderCost(t, quote);
  return orderCost(t, quote);
}

const OPEN_STATES = new Set(['new', 'queued', 'confirmed', 'unconfirmed', 'partially_filled', 'pending', 'pending_approval']);

/**
 * Evaluate one ticket.
 * @returns {{decision:'approve'|'resize'|'block', ticket:object, checks:Array, summary:string, cost:number}}
 */
export function evaluate(ticketIn, ctx) {
  const t = normalizeTicket(ticketIn);
  const p = ctx.params;
  const checks = [];
  const block = (id, label, detail) => checks.push({ id, label, ok: false, level: 'block', detail });
  const warn = (id, label, detail) => checks.push({ id, label, ok: false, level: 'warn', detail });
  const pass = (id, label, detail) => checks.push({ id, label, ok: true, level: 'info', detail });
  const equity = Math.max(0, ctx.account?.equity || 0);
  const bp = Math.max(0, ctx.account?.buyingPower ?? ctx.account?.cash ?? 0);
  const clock = ctx.clock || {};
  const quote = saneQuote(ctx.quotes?.[t.symbol] || {});
  const opening = t.positionEffect === 'open' && !(t.kind === 'stock' && t.side === 'sell');
  const today = ctx.todayIso || clock.iso;

  // 0. Basic shape
  if (!t.symbol) block('shape', 'Order is complete', 'No symbol on the order.');
  if (t.kind === 'stock' && !t.quantity && !t.dollars) block('shape', 'Order is complete', 'No share quantity or dollar amount.');
  if (t.kind === 'option' && (!t.legs?.length || t.legs.some((l) => !l.contractId))) block('shape', 'Order is complete', 'Option legs are missing contract ids.');
  if (t.kind === 'option' && !t.quantity) block('shape', 'Order is complete', 'No contract quantity.');

  // 1. Kill switch & circuit breaker
  if (ctx.killSwitch && opening) block('kill', 'Trading halted', 'The kill switch is on: only closing orders may go out.');
  const dayPL = ctx.day?.startEquity ? (equity - ctx.day.startEquity) / ctx.day.startEquity : 0;
  if (opening && dayPL <= -p.dailyLossLimitPct / 100) block('daily_loss', 'Daily loss limit', `Down ${round(-dayPL * 100, 2)}% today; the ${p.mode.name} limit is −${p.dailyLossLimitPct}%. No new trades until tomorrow.`);
  else pass('daily_loss', 'Daily loss limit', `Today ${round(dayPL * 100, 2)}% vs limit −${p.dailyLossLimitPct}%.`);
  if (opening && (ctx.day?.tradesOpened || 0) >= p.maxTradesPerDay) block('trade_count', 'Trades per day', `Already opened ${ctx.day.tradesOpened} trades today (limit ${p.maxTradesPerDay}).`);

  // 2. Session rules
  const session = clock.session || 'regular';
  if (session !== 'regular') {
    if (t.kind === 'option') block('session', 'Market hours', 'Options trade only during regular hours (9:30–4:00 ET).');
    else if (!p.extendedHours) block('session', 'Market hours', `Market is ${session}; ${p.mode.name} mode trades regular hours only.`);
    else if (t.orderType !== 'limit') block('session', 'Market hours', 'Outside regular hours only limit orders execute.');
    else if (t.dollars || (t.quantity && !Number.isInteger(t.quantity))) block('session', 'Market hours', 'Fractional and dollar-based orders only run during regular hours.');
    else t.marketHours = 'extended_hours';
  } else if (opening && clock.minutesSinceOpen != null && clock.minutesSinceOpen < p.avoidOpenMinutes) {
    block('open_window', 'Opening minutes', `New entries wait until ${p.avoidOpenMinutes} minutes after the open (now ${clock.minutesSinceOpen}).`);
  } else if (opening && clock.minutesToClose != null && clock.minutesToClose < 5 && t.kind === 'option') {
    block('close_window', 'Closing minutes', 'No new option positions in the last 5 minutes of the session.');
  }

  // 3. Instrument rules
  if ((ctx.limits?.blocklist || []).map((s) => s.toUpperCase()).includes(t.symbol)) block('blocklist', 'Blocked symbol', `${t.symbol} is on your do-not-trade list.`);
  const px = quote.price || quote.last || 0;
  if (opening && t.kind === 'stock' && px && px < p.minPrice) block('min_price', 'Stock price floor', `${t.symbol} at $${round(px, 2)} is under the $${p.minPrice} minimum for ${p.mode.name}.`);
  const capB = ctx.fundamentals?.[t.symbol]?.marketCapB;
  if (opening && capB != null && capB < p.minMarketCapB) block('market_cap', 'Company size', `${t.symbol} market cap $${round(capB, 2)}B is under the $${p.minMarketCapB}B minimum.`);
  if (opening && capB == null && p.minMarketCapB >= 10 && !/^(SPY|QQQ|DIA|IWM|VOO|VTI|IVV|SCHD|VYM|XL[A-Z])$/.test(t.symbol)) warn('market_cap', 'Company size', 'Market cap unknown; confirm this is a large company or ETF.');

  // 4. Strategy permission
  const strat = t.strategy || 'stock';
  if (!p.strategies.includes(strat) && !(t.positionEffect === 'close')) block('strategy', 'Strategy allowed', `${STRATEGIES[strat]?.name || strat} is not allowed in ${p.mode.name} mode.`);
  if (t.kind === 'option') {
    const need = STRATEGIES[strat]?.level ?? 3;
    const have = optionLevelNumber(ctx.account?.optionLevel);
    if (opening && have < need) block('option_level', 'Options approval level', `${STRATEGIES[strat]?.name || strat} needs options level ${need}; the account has level ${have}.`);
    if (strat === 'unknown' || strat === 'multi_leg') block('strategy', 'Strategy allowed', 'Only single-leg and two-leg vertical spreads are supported.');
    if (t.legs.some((l) => l.side === 'sell' && l.positionEffect === 'open') && strat === 'covered_call') {
      const shares = ctx.positions?.stocks?.find((s) => s.symbol === t.symbol)?.qty || 0;
      const shortCalls = (ctx.positions?.options || []).filter((o) => o.symbol === t.symbol && o.right === 'call' && o.qty < 0).reduce((a, o) => a + Math.abs(o.qty), 0);
      const free = Math.floor(shares / 100) - shortCalls;
      if (free < t.quantity) block('covered', 'Calls are covered', `Covered calls need 100 shares per contract; ${t.symbol} has ${shares} shares (${Math.max(0, free)} contracts free).`);
    }
  }

  // 5. Option contract quality
  if (t.kind === 'option' && opening) {
    for (const l of t.legs) {
      const d = l.dte ?? (l.expiration && today ? daysBetween(today, l.expiration) : undefined);
      if (d != null) {
        if (d === 0 && !p.allowZeroDte) block('dte', 'Days to expiration', `Same-day (0DTE) contracts are only allowed in Moonshot mode.`);
        else if (l.side === 'buy' && (d < p.minDte || d > p.maxDte)) block('dte', 'Days to expiration', `${d} days to expiration is outside ${p.minDte}–${p.maxDte} for ${p.mode.name}.`);
      }
      if (l.side === 'buy' && t.legs.length === 1 && l.delta != null) {
        const ad = Math.abs(l.delta);
        if (ad < p.deltaMin - 0.02 || ad > p.deltaMax + 0.05) block('delta', 'Contract delta', `|Δ| ${round(ad, 3)} is outside ${p.deltaMin}–${p.deltaMax}.`);
      }
      if (l.spreadPct != null && p.maxSpreadPct > 0 && l.spreadPct > p.maxSpreadPct) block('liquidity', 'Bid-ask spread', `Spread is ${l.spreadPct}% of the mid price (max ${p.maxSpreadPct}%).`);
      if (p.minOpenInterest > 0 && l.openInterest < p.minOpenInterest) warn('liquidity', 'Open interest', `Open interest ${l.openInterest} is below ${p.minOpenInterest}; exits may be slow.`);
      const lp = l.mid || (l.bid + l.ask) / 2;
      if (l.side === 'buy' && lp > 0 && lp < 0.05 && p.mode.level < 5) block('lottery', 'Lottery ticket', `A $${round(lp, 2)} contract is a long shot; only Moonshot mode buys sub-$0.05 options.`);
    }
    const earn = ctx.earnings?.[t.symbol];
    if (earn && today) {
      const until = daysBetween(today, earn);
      const lastExp = t.legs.map((l) => l.expiration).sort().pop();
      if (until >= 0 && until <= 3 && (!lastExp || lastExp >= earn) && !p.earningsPlays) block('earnings', 'Earnings risk', `${t.symbol} reports in ${until} day(s) and the contract spans it; ${p.mode.name} mode avoids earnings bets.`);
      else if (until >= 0 && until <= 7) warn('earnings', 'Earnings risk', `${t.symbol} reports ${earn}. Implied volatility usually drops after the report.`);
    }
  }

  // 6. Order-type and price sanity
  if (t.kind === 'option') {
    if (t.orderType === 'market' && opening) {
      block('order_type', 'Order type', 'Options open with limit orders only.');
    }
    if (!t.price && t.orderType !== 'market') {
      // Default to mid, nudged toward the side we need to fill on.
      const net = t.legs.reduce((a, l) => a + (l.side === 'buy' ? 1 : -1) * (l.mid || (l.bid + l.ask) / 2) * l.ratio, 0);
      t.price = tickRound(Math.abs(net), { option: true });
    }
    if (t.price && t.legs.length === 1) {
      const l = t.legs[0];
      if (l.side === 'buy' && l.ask > 0 && t.price > l.ask * 1.1) block('price', 'Limit price', `Limit $${t.price} is far above the $${l.ask} ask.`);
      if (l.side === 'sell' && l.bid > 0 && t.price < l.bid * 0.9) block('price', 'Limit price', `Limit $${t.price} is far below the $${l.bid} bid.`);
    }
    if (t.price) t.price = tickRound(t.price, { option: true });
  } else {
    const fractional = t.quantity && !Number.isInteger(t.quantity);
    if (t.dollars) {
      t.orderType = 'market';
      t.limitPrice = null;
      if (t.dollars < 1) block('min_dollars', 'Order size', 'Dollar-based orders must be at least $1.');
    } else if (fractional && t.orderType !== 'market') {
      t.orderType = 'market';
      t.limitPrice = null;
      pass('fractional', 'Fractional shares', 'Fractional share orders go out as market orders during regular hours.');
    }
    if (t.orderType === 'limit' && !t.limitPrice) {
      const ref = t.side === 'buy' ? quote.ask || quote.price : quote.bid || quote.price;
      if (ref) t.limitPrice = tickRound(ref * (t.side === 'buy' ? 1.002 : 0.998), { direction: t.side === 'buy' ? 'up' : 'down' });
      else block('price', 'Limit price', 'No limit price and no live quote to set one.');
    }
    if (t.limitPrice) {
      t.limitPrice = tickRound(t.limitPrice);
      if (px && t.side === 'buy' && t.limitPrice > px * 1.03 && t.orderType === 'limit') block('price', 'Limit price', `Buy limit $${t.limitPrice} is more than 3% above the $${round(px, 2)} price.`);
      if (px && t.side === 'sell' && t.limitPrice < px * 0.97 && t.orderType === 'limit') block('price', 'Limit price', `Sell limit $${t.limitPrice} is more than 3% below the $${round(px, 2)} price.`);
      if (px && t.side === 'sell' && t.limitPrice > px * 1.03 && t.orderType === 'limit') warn('price', 'Limit price', `Sell limit $${t.limitPrice} is well above the $${round(px, 2)} price, so it may not fill.`);
      if (px && t.side === 'buy' && t.limitPrice < px * 0.97 && t.orderType === 'limit') warn('price', 'Limit price', `Buy limit $${t.limitPrice} is well below the $${round(px, 2)} price, so it may not fill.`);
    }
    if ((t.orderType === 'stop_market' || t.orderType === 'stop_limit') && !t.stopPrice) block('price', 'Stop price', 'Stop orders need a stop price.');
    if (t.side === 'sell') {
      const held = ctx.positions?.stocks?.find((s) => s.symbol === t.symbol);
      const avail = held?.available ?? held?.qty ?? 0;
      if (!held) block('position', 'Shares to sell', `No ${t.symbol} shares are held; short selling is off.`);
      else if (t.quantity && t.quantity > avail + 1e-9) {
        t.quantity = round(avail, 6);
        warn('position', 'Shares to sell', `Reduced to the ${avail} shares available to sell.`);
      }
      if (t.quantity && !Number.isInteger(t.quantity) && t.orderType !== 'market') {
        t.orderType = 'market'; // fractional shares only trade as market orders
        t.limitPrice = null;
      }
    }
  }

  // 7. Sizing
  let cost = orderCost(t, quote);
  if (opening && cost > 0) {
    const isOpt = t.kind === 'option';
    const capPct = isOpt ? p.maxOptionPositionPct : p.maxPositionPct;
    let cap = (equity * capPct) / 100;
    const reasons = [`${capPct}% of account = $${round(cap, 2)}`];
    // Adding to a holding counts what is already held toward the same per-position cap.
    const heldValue =
      (isOpt
        ? (ctx.positions?.options || []).filter((o) => o.symbol === t.symbol && o.qty > 0).reduce((a, o) => a + Math.abs(o.value || 0), 0)
        : Math.abs(ctx.positions?.stocks?.find((s) => s.symbol === t.symbol)?.value || 0)) + (ctx.pending?.[t.symbol] || 0); // plus orders approved earlier this cycle
    if (heldValue > 0) {
      cap = Math.max(0, cap - heldValue);
      reasons.push(`$${round(heldValue, 2)} of ${t.symbol} already held leaves $${round(cap, 2)}`);
    }
    const investedNow = ctx.exposure?.invested ?? 0;
    const roomInvested = (equity * p.maxInvestedPct) / 100 - investedNow;
    if (roomInvested < cap) {
      cap = Math.max(0, roomInvested);
      reasons.push(`room under the ${p.maxInvestedPct}% invested cap = $${round(cap, 2)}`);
    }
    if (isOpt) {
      const optRoom = (equity * p.maxOptionsAllocPct) / 100 - (ctx.exposure?.options ?? 0);
      if (optRoom < cap) {
        cap = Math.max(0, optRoom);
        reasons.push(`room under the ${p.maxOptionsAllocPct}% options cap = $${round(cap, 2)}`);
      }
    }
    if (bp * 0.99 < cap) {
      cap = Math.max(0, bp * 0.99);
      reasons.push(`buying power $${round(bp, 2)}`);
    }
    const userCap = ctx.limits?.maxOrderDollars;
    if (userCap > 0 && userCap < cap) {
      cap = userCap;
      reasons.push(`your $${userCap} per-order cap`);
    }
    if (cost > cap + 0.005) {
      const resized = resize(t, cap, quote);
      if (resized) {
        checks.push({ id: 'size', label: 'Position size', ok: true, level: 'warn', detail: `Shrunk from $${round(cost, 2)} to $${round(orderCost(resized, quote), 2)} (limit: ${reasons.join('; ')}).` });
        Object.assign(t, resized);
        cost = orderCost(t, quote);
      } else block('size', 'Position size', `Needs $${round(cost, 2)} but the limit is $${round(cap, 2)} (${reasons.join('; ')}). Too small to buy even one ${isOpt ? 'contract' : 'share'}.`);
    } else pass('size', 'Position size', `$${round(cost, 2)} within $${round(cap, 2)}.`);
    const heldSyms = new Set([...(ctx.positions?.stocks || []).map((s) => s.symbol), ...(ctx.positions?.options || []).map((o) => o.symbol)]);
    const openCount = (ctx.positions?.stocks?.length || 0) + new Set((ctx.positions?.options || []).map((o) => o.symbol)).size + Object.keys(ctx.pending || {}).filter((s) => !heldSyms.has(s)).length;
    const already = heldSyms.has(t.symbol) || !!ctx.pending?.[t.symbol];
    if (!already && openCount >= p.maxPositions) block('positions', 'Open positions', `Already holding ${openCount} positions (limit ${p.maxPositions}).`);
  }

  // 8. Duplicates
  const side = t.kind === 'option' ? t.legs?.[0]?.side : t.side;
  const cid = t.kind === 'option' ? t.legs?.[0]?.contractId : null;
  const dup = (ctx.openOrders || []).find((o) => o.symbol === t.symbol && (o.side === t.side || o.side === side) && OPEN_STATES.has(o.state) && (o.kind || 'stock') === t.kind && (!cid || !o.contractId || o.contractId === cid));
  if (dup) block('duplicate', 'Duplicate order', `An open ${t.side} order for ${t.symbol} is already working.`);

  // 9. Pattern day trading guard
  if (ctx.limits?.pdtGuard !== false && ctx.account?.isMargin && equity < PDT_EQUITY) {
    const used = ctx.day?.dayTradesRolling || 0;
    const closesSameDay = t.positionEffect === 'close' || (t.kind === 'stock' && t.side === 'sell');
    const openedToday = ctx.day?.openedTodaySymbols?.includes(t.symbol);
    if (closesSameDay && openedToday && used >= 3) warn('pdt', 'Pattern day trading', `This would be day trade #${used + 1} in 5 business days on an account under $25k. Robinhood may restrict the account. Consider holding overnight unless this is a stop-loss exit.`);
    if (opening && t.kind === 'option' && t.legs.some((l) => l.dte === 0) && used >= 3) block('pdt', 'Pattern day trading', 'No day-trade allowance left this week, and a 0DTE trade would force one.');
    else if (used >= 2) pass('pdt', 'Pattern day trading', `${used} of 3 day trades used in the last 5 business days.`);
  }

  // 10. Exit plan
  if (opening && ctx.limits?.requireExitPlan !== false) {
    if (!t.exit || (!t.exit.stop && !t.exit.target)) {
      t.exit = defaultExit(t, quote, p);
      pass('exit', 'Exit plan', `Added default exit: stop ${t.exit.stop ?? '—'}, target ${t.exit.target ?? '—'}.`);
    } else pass('exit', 'Exit plan', `Stop ${t.exit.stop ?? '—'}, target ${t.exit.target ?? '—'}.`);
  }

  // 11. Conviction
  if (opening && t.conviction != null && t.conviction < p.minConviction) block('conviction', 'Conviction', `Conviction ${t.conviction}/5 is below the ${p.minConviction}/5 minimum for ${p.mode.name}.`);

  const blocked = checks.some((c) => c.level === 'block' && !c.ok);
  const resized = checks.some((c) => c.id === 'size' && c.level === 'warn');
  const decision = blocked ? 'block' : resized ? 'resize' : 'approve';
  const firstBlock = checks.find((c) => c.level === 'block' && !c.ok);
  return {
    decision,
    ticket: t,
    checks,
    cost: round(cost, 2),
    summary: blocked ? `Blocked: ${firstBlock.detail}` : resized ? 'Approved after resizing to fit the limits.' : 'Approved: all checks passed.',
  };
}

/** Shrink an order to fit a dollar cap. Returns null when not even one unit fits. */
function resize(t, cap, quote) {
  if (t.kind === 'stock') {
    if (t.dollars) return cap >= 1 ? { dollars: round(Math.floor(cap * 100) / 100, 2) } : null;
    const px = t.limitPrice || quote?.ask || quote?.price;
    if (!px) return null;
    const whole = Math.floor(cap / px);
    if (whole >= 1) return { quantity: whole };
    // Fall back to a fractional dollar order when the account is small.
    if (cap >= 1) return { quantity: null, dollars: round(Math.floor(cap * 100) / 100, 2), orderType: 'market', limitPrice: null };
    return null;
  }
  const per = orderCost({ ...t, quantity: 1 }, quote);
  if (!(per > 0)) return null;
  const n = Math.floor(cap / per);
  return n >= 1 ? { quantity: n } : null;
}

/** Default stop/target from the mode when the agents did not supply one. */
export function defaultExit(t, quote, p) {
  if (t.kind === 'stock') {
    const px = t.limitPrice || quote?.price || 0;
    if (!px) return { stop: null, target: null };
    const long = t.side === 'buy';
    return {
      stop: tickRound(px * (1 + ((long ? -1 : 1) * p.stopLossPct) / 100)),
      target: tickRound(px * (1 + ((long ? 1 : -1) * p.takeProfitPct) / 100)),
      basis: 'stock_price',
    };
  }
  const prem = t.price || 0;
  if (!prem) return { stop: null, target: null };
  const debit = t.direction !== 'credit';
  return debit
    ? { stop: tickRound(prem * (1 - p.optionStopPct / 100), { option: true }), target: tickRound(prem * (1 + p.optionTakeProfitPct / 100), { option: true }), basis: 'option_premium' }
    : { stop: tickRound(prem * (1 + p.optionStopPct / 100), { option: true }), target: tickRound(prem * (1 - Math.min(90, p.optionTakeProfitPct) / 100), { option: true }), basis: 'option_premium' };
}

/**
 * Check open positions against their exit plans and the mode's rules; returns closing tickets.
 * plans: { [positionKey]: { stop, target, timeStop, basis } } where positionKey is the symbol for
 * stocks and the contract id for options.
 */
export function exitSignals({ positions, plans = {}, quotes = {}, params, todayIso, clock }) {
  const out = [];
  for (const s of positions?.stocks || []) {
    const plan = plans[s.symbol];
    const px = quotes[s.symbol]?.price ?? s.price;
    if (!px || !(s.available ?? s.qty)) continue;
    const qtyAvail = s.available ?? s.qty;
    const changePct = s.avgCost ? ((px - s.avgCost) / s.avgCost) * 100 : 0;
    let reason = null;
    if (plan?.stop && px <= plan.stop) reason = `price $${round(px, 2)} hit the $${plan.stop} stop`;
    else if (plan?.target && px >= plan.target) reason = `price $${round(px, 2)} reached the $${plan.target} target`;
    else if (plan?.timeStop && todayIso >= plan.timeStop) reason = `time stop ${plan.timeStop} reached`;
    if (reason) {
      const whole = Number.isInteger(qtyAvail);
      out.push({
        reason,
        ticket: normalizeTicket({
          kind: 'stock',
          symbol: s.symbol,
          side: 'sell',
          positionEffect: 'close',
          quantity: qtyAvail,
          orderType: whole ? 'limit' : 'market', // fractional shares can only sell at market
          limitPrice: whole ? tickRound(px * 0.997, { direction: 'down' }) : null,
          why: `Exit: ${reason}.`,
        }),
      });
    }
  }
  for (const o of positions?.options || []) {
    const plan = plans[o.id];
    const mark = o.mark;
    if (mark == null || !o.qty) continue;
    const long = o.qty > 0;
    const entry = o.avgPrice || 0;
    const pnlPct = entry ? ((long ? mark - entry : entry - mark) / entry) * 100 : 0;
    let reason = null;
    if (plan?.stop != null && (long ? mark <= plan.stop : mark >= plan.stop)) reason = `option at $${round(mark, 2)} hit its $${plan.stop} stop`;
    else if (plan?.target != null && (long ? mark >= plan.target : mark <= plan.target)) reason = `option at $${round(mark, 2)} reached its $${plan.target} target`;
    const days = o.expiration && todayIso ? daysBetween(todayIso, o.expiration) : null;
    if (!reason && days === 0 && !params.allowZeroDte) reason = 'expires today; closing to avoid assignment or a worthless expiry';
    if (!reason && days === 0 && clock?.minutesToClose != null && clock.minutesToClose <= 20) reason = 'expires in the last 20 minutes of the session';
    if (!reason && plan?.timeStop && todayIso >= plan.timeStop) reason = `time stop ${plan.timeStop} reached`;
    if (reason) {
      const price = long ? Math.max(0.01, o.bid || mark * 0.97) : (o.ask || mark * 1.03);
      out.push({
        reason,
        ticket: normalizeTicket({
          kind: 'option',
          symbol: o.symbol,
          positionEffect: 'close',
          quantity: Math.abs(o.qty),
          price: tickRound(price, { option: true }),
          strategy: long ? (o.right === 'call' ? 'long_call' : 'long_put') : o.right === 'call' ? 'covered_call' : 'cash_secured_put',
          legs: [{ contractId: o.id, right: o.right, strike: o.strike, expiration: o.expiration, side: long ? 'sell' : 'buy', positionEffect: 'close', bid: o.bid, ask: o.ask, mid: mark }],
          why: `Exit: ${reason}.`,
        }),
      });
    }
  }
  return out;
}

/**
 * Exit plans for positions that have none (bought by hand, before the desk started, or a plan was
 * lost). The desk adopts them from the current price instead of judging them against an old cost
 * basis, so it never dumps a position the moment it first sees it.
 * @returns {{[key: string]: object}} new plans keyed like exitSignals' plans
 */
export function adoptionPlans({ positions, plans = {}, quotes = {}, params }) {
  const out = {};
  for (const s of positions?.stocks || []) {
    if (plans[s.symbol]) continue;
    const px = quotes[s.symbol]?.price ?? s.price;
    if (!(px > 0)) continue;
    out[s.symbol] = { stop: tickRound(px * (1 - params.stopLossPct / 100), { direction: 'down' }), target: tickRound(px * (1 + params.takeProfitPct / 100), { direction: 'up' }), timeStop: null, basis: 'stock_price', adopted: true, note: `Adopted at $${round(px, 2)}: ${params.stopLossPct}% stop, ${params.takeProfitPct}% target from the ${params.mode.name} mode.` };
  }
  for (const o of positions?.options || []) {
    if (plans[o.id] || !(o.mark > 0) || !o.qty) continue;
    const long = o.qty > 0;
    const stopPct = params.optionStopPct || 50;
    const tgtPct = params.optionTakeProfitPct || 100;
    out[o.id] = {
      stop: tickRound(long ? o.mark * (1 - stopPct / 100) : o.mark * (1 + stopPct / 100), { option: true }),
      target: tickRound(long ? o.mark * (1 + tgtPct / 100) : o.mark * (1 - Math.min(90, tgtPct) / 100), { option: true }),
      timeStop: null,
      basis: 'option_premium',
      adopted: true,
      note: `Adopted at $${round(o.mark, 2)} premium from the ${params.mode.name} mode.`,
    };
  }
  return out;
}

/** Sum invested dollars and option exposure from positions. */
export function exposure(positions) {
  const stocks = (positions?.stocks || []).reduce((a, s) => a + (s.value || 0), 0);
  const options = (positions?.options || []).reduce((a, o) => a + Math.abs(o.value || 0), 0);
  return { stocks: round(stocks, 2), options: round(options, 2), invested: round(stocks + options, 2) };
}

/** Count day trades (same-day open + close) in the last five business days from order history. */
export function countDayTrades(orders, todayIso) {
  const days = new Set();
  const byDay = {};
  for (const o of orders || []) {
    if (o.state !== 'filled' || !o.createdAt) continue;
    const d = new Date(o.createdAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (daysBetween(d, todayIso) > 7) continue;
    const key = `${d}|${o.symbol}|${o.kind}`;
    (byDay[key] ||= { buy: 0, sell: 0 });
    const opening = o.kind === 'option' ? o.positionEffect === 'open' : o.side === 'buy';
    byDay[key][opening ? 'buy' : 'sell']++;
    days.add(d);
  }
  let count = 0;
  const openedToday = [];
  for (const [key, v] of Object.entries(byDay)) {
    if (v.buy && v.sell) count += Math.min(v.buy, v.sell);
    const [d, sym] = key.split('|');
    if (d === todayIso && v.buy) openedToday.push(sym);
  }
  return { count, openedToday };
}
