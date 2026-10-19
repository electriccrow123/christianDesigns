import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, normalizeTicket, exitSignals, countDayTrades, orderCost } from '../core/risk.js';
import { resolveParams } from '../core/modes.js';

const clock = { session: 'regular', minutesSinceOpen: 90, minutesToClose: 200, iso: '2026-10-15' };
function ctx(over = {}) {
  return {
    params: resolveParams(over.mode || 'balanced'),
    limits: {},
    account: { equity: 10000, buyingPower: 10000, cash: 10000, optionLevel: 'option_level_3', isMargin: false },
    positions: { stocks: [], options: [] },
    openOrders: [],
    day: { startEquity: 10000, tradesOpened: 0, dayTradesRolling: 0 },
    quotes: { AAPL: { price: 200, bid: 199.95, ask: 200.05 }, SPY: { price: 500, bid: 499.9, ask: 500.1 } },
    fundamentals: { AAPL: { marketCapB: 3000 } },
    earnings: {},
    exposure: { invested: 0, options: 0 },
    clock,
    todayIso: '2026-10-15',
    killSwitch: false,
    ...over,
  };
}
const longCall = (leg = {}) => ({ kind: 'option', symbol: 'AAPL', quantity: 1, conviction: 4, legs: [{ contractId: 'x', right: 'call', strike: 200, expiration: '2026-11-20', side: 'buy', bid: 4, ask: 4.2, mid: 4.1, delta: 0.52, openInterest: 900, dte: 36, spreadPct: 3.9, ...leg }] });

test('approves a normal stock buy and adds an exit plan', () => {
  const r = evaluate({ symbol: 'AAPL', side: 'buy', quantity: 5, conviction: 4 }, ctx());
  assert.equal(r.decision, 'approve');
  assert.ok(r.ticket.limitPrice >= 200 && r.ticket.limitPrice < 201);
  assert.ok(Math.abs(r.ticket.exit.stop - r.ticket.limitPrice * 0.92) < 0.02); // 8% Balanced stop
});

test('kill switch blocks opening trades but not exits', () => {
  assert.equal(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, ctx({ killSwitch: true })).decision, 'block');
  const sell = evaluate({ symbol: 'AAPL', side: 'sell', quantity: 1 }, ctx({ killSwitch: true, positions: { stocks: [{ symbol: 'AAPL', qty: 2, available: 2 }], options: [] } }));
  assert.notEqual(sell.decision, 'block');
});

test('oversized orders are shrunk; tiny accounts fall back to fractional dollars', () => {
  const r = evaluate({ symbol: 'AAPL', side: 'buy', quantity: 50, conviction: 4 }, ctx());
  assert.equal(r.decision, 'resize');
  assert.equal(r.ticket.quantity, 9); // 20% of $10k at a ~$200.45 marketable limit
  const small = evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1, conviction: 4 }, ctx({ account: { equity: 18, buyingPower: 3.6, cash: 3.6, optionLevel: 'option_level_3' }, day: { startEquity: 18, tradesOpened: 0 } }));
  assert.equal(small.decision, 'resize');
  assert.equal(small.ticket.dollars, 3.56);
  assert.equal(small.ticket.orderType, 'market');
});

test('daily loss circuit breaker and trade count', () => {
  const lost = ctx({ account: { equity: 9500, buyingPower: 9500, cash: 9500, optionLevel: 'option_level_3' } });
  assert.match(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, lost).summary, /Daily|today/i);
  assert.equal(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, ctx({ day: { startEquity: 10000, tradesOpened: 8 } })).decision, 'block');
});

test('opening minutes, extended hours and option session rules', () => {
  assert.equal(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, ctx({ clock: { ...clock, minutesSinceOpen: 5 } })).decision, 'block');
  assert.equal(evaluate(longCall(), ctx({ clock: { ...clock, session: 'post', minutesSinceOpen: null } })).decision, 'block');
  const ext = evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1, orderType: 'limit', limitPrice: 200 }, ctx({ mode: 'aggressive', clock: { ...clock, session: 'post', minutesSinceOpen: null } }));
  assert.equal(ext.decision, 'approve');
  assert.equal(ext.ticket.marketHours, 'extended_hours');
});

test('strategy permissions by mode and options level', () => {
  assert.equal(evaluate(longCall(), ctx({ mode: 'fortress' })).decision, 'block');
  assert.equal(evaluate(longCall(), ctx({ account: { equity: 10000, buyingPower: 10000, optionLevel: 'option_level_1' } })).decision, 'block');
  assert.equal(evaluate(longCall(), ctx()).decision, 'approve');
});

test('option quality checks: delta, DTE, spread, 0DTE, lottery tickets', () => {
  assert.equal(evaluate(longCall({ delta: 0.1 }), ctx()).decision, 'block');
  assert.equal(evaluate(longCall({ dte: 3 }), ctx()).decision, 'block');
  assert.equal(evaluate(longCall({ spreadPct: 30 }), ctx()).decision, 'block');
  assert.equal(evaluate(longCall({ dte: 0, delta: 0.4 }), ctx({ mode: 'aggressive' })).decision, 'block');
  assert.equal(evaluate(longCall({ dte: 0, delta: 0.4, spreadPct: 10 }), ctx({ mode: 'moonshot' })).decision, 'approve');
  assert.equal(evaluate(longCall({ bid: 0.02, ask: 0.04, mid: 0.03, delta: 0.42 }), ctx()).decision, 'block');
});

test('earnings rule: Balanced avoids buying options across a report', () => {
  const r = evaluate(longCall(), ctx({ earnings: { AAPL: '2026-10-16' } }));
  assert.equal(r.decision, 'block');
  assert.match(r.summary, /reports/);
  assert.notEqual(evaluate(longCall({ delta: 0.5, dte: 36 }), ctx({ mode: 'aggressive', earnings: { AAPL: '2026-10-16' } })).decision, 'block');
});

test('covered calls need the shares; naked short calls are impossible', () => {
  const cc = { kind: 'option', symbol: 'AAPL', quantity: 1, strategy: 'covered_call', legs: [{ contractId: 'y', right: 'call', strike: 220, expiration: '2026-11-20', side: 'sell', bid: 2, ask: 2.1, mid: 2.05, delta: 0.25, openInterest: 900, dte: 36, spreadPct: 4 }] };
  assert.equal(evaluate(cc, ctx({ mode: 'steady' })).decision, 'block');
  assert.equal(evaluate(cc, ctx({ mode: 'steady', positions: { stocks: [{ symbol: 'AAPL', qty: 100, available: 100 }], options: [] } })).decision, 'approve');
});

test('duplicates, blocklist, short selling', () => {
  assert.equal(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, ctx({ openOrders: [{ symbol: 'AAPL', side: 'buy', state: 'queued', kind: 'stock' }] })).decision, 'block');
  assert.equal(evaluate({ symbol: 'AAPL', side: 'buy', quantity: 1 }, ctx({ limits: { blocklist: ['aapl'] } })).decision, 'block');
  assert.equal(evaluate({ symbol: 'AAPL', side: 'sell', quantity: 1 }, ctx()).decision, 'block');
});

test('user hard limit caps order size', () => {
  const r = evaluate({ symbol: 'AAPL', side: 'buy', quantity: 5, conviction: 4 }, ctx({ limits: { maxOrderDollars: 450 } }));
  assert.equal(r.ticket.quantity, 2);
});

test('spread collateral and costs', () => {
  const t = normalizeTicket({ kind: 'option', symbol: 'AAPL', quantity: 2, price: 1.5, legs: [{ contractId: 'a', right: 'put', strike: 190, side: 'sell' }, { contractId: 'b', right: 'put', strike: 185, side: 'buy' }] });
  assert.equal(t.strategy, 'put_credit_spread');
  assert.equal(orderCost(t), 700); // (5 - 1.5) × 100 × 2
});

test('exit signals fire on stops, targets and expiry day', () => {
  const params = resolveParams('balanced');
  const exits = exitSignals({
    positions: {
      stocks: [{ symbol: 'AAPL', qty: 10, available: 10, avgCost: 210, price: 180 }],
      options: [{ id: 'o1', symbol: 'SPY', right: 'call', strike: 500, expiration: '2026-10-15', qty: 1, avgPrice: 2, mark: 2.1, bid: 2, ask: 2.2 }],
    },
    plans: { AAPL: { stop: 190, target: 250 } },
    quotes: {},
    params,
    todayIso: '2026-10-15',
  });
  assert.equal(exits.length, 2);
  assert.equal(exits[0].ticket.side, 'sell');
  assert.equal(exits[1].ticket.legs[0].side, 'sell');
  assert.equal(exits[1].ticket.positionEffect, 'close');
});

test('day trades are counted from same-day round trips', () => {
  const at = '2026-10-15T15:00:00Z';
  const r = countDayTrades([
    { state: 'filled', createdAt: at, symbol: 'AAPL', kind: 'stock', side: 'buy' },
    { state: 'filled', createdAt: at, symbol: 'AAPL', kind: 'stock', side: 'sell' },
    { state: 'filled', createdAt: at, symbol: 'MSFT', kind: 'stock', side: 'buy' },
  ], '2026-10-15');
  assert.equal(r.count, 1);
  assert.deepEqual(r.openedToday.sort(), ['AAPL', 'MSFT']);
});

test('positions without a plan are adopted from today’s price, not sold', async () => {
  const { adoptionPlans } = await import('../core/risk.js');
  const params = resolveParams('balanced');
  const positions = { stocks: [{ symbol: 'COIN', qty: 0.025, available: 0.025, avgCost: 198, price: 166 }], options: [{ id: 'o9', symbol: 'SPY', right: 'call', strike: 600, expiration: '2026-12-18', qty: 1, avgPrice: 4, mark: 2 }] };
  assert.equal(exitSignals({ positions, plans: {}, quotes: {}, params, todayIso: '2026-10-19' }).length, 0);
  const plans = adoptionPlans({ positions, plans: {}, quotes: {}, params });
  assert.ok(Math.abs(plans.COIN.stop - 166 * 0.92) < 0.02 && plans.COIN.adopted);
  assert.equal(plans.o9.stop, 1.2);
  assert.equal(adoptionPlans({ positions, plans, quotes: {}, params }).COIN, undefined);
});
