import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, atr, linreg } from '../core/indicators.js';
import { analyze, levels } from '../core/patterns.js';
import { marketRegime } from '../core/regime.js';
import { blackScholes, impliedVol, expectedMove, strategyRisk, rankContracts, enrichContract } from '../core/options.js';
import { isTradingDay, marketStatus, nyTimeToDate, thirdFriday, nextTradingDay, sessionBounds } from '../core/market-clock.js';
import { slotsFor, dueSlot, weekEvents } from '../core/planner.js';
import { resolveParams, MODES } from '../core/modes.js';
import { parseJsonLoose, tickRound, saneQuote } from '../core/util.js';

// Deterministic bar generator
function bars(n, { start = 100, drift = 0.001, vol = 0.01, seed = 7 } = {}) {
  let x = seed;
  const rnd = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
  let p = start;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + (rnd() - 0.5) * vol);
    out.push({ t: 1.7e9 + i * 86400, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: 1e6 });
  }
  return out;
}

test('moving averages, RSI, MACD and ATR', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(sma(v, 3).slice(2, 5), [2, 3, 4]);
  assert.equal(ema(v, 3)[2], 2);
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(up, 14).at(-1), 100);
  const m = macd(up);
  assert.ok(m.line.at(-1) > 0);
  assert.ok(atr(bars(40), 14).at(-1) > 0);
  const lr = linreg([1, 3, 5, 7]);
  assert.ok(Math.abs(lr.slope - 2) < 1e-9 && Math.abs(lr.r2 - 1) < 1e-9);
});

test('analyze reads a strong uptrend as bullish with sane outputs', () => {
  const a = analyze(bars(300, { drift: 0.004, vol: 0.01 }), { symbol: 'UP' });
  assert.equal(a.trend.direction, 'up');
  assert.ok(a.score > 20, `score ${a.score}`);
  assert.equal(a.bias, 'bullish');
  assert.ok(a.projection.low1 < a.projection.base && a.projection.base < a.projection.high1);
  assert.match(a.summary, /uptrend/);
});

test('analyze reads a downtrend as bearish', () => {
  const a = analyze(bars(300, { drift: -0.004, vol: 0.01 }), { symbol: 'DN' });
  assert.equal(a.trend.direction, 'down');
  assert.ok(a.score < -20);
});

test('analyze handles short history', () => {
  const a = analyze(bars(10), { symbol: 'NEW' });
  assert.ok(a.insufficient);
});

test('double bottom is detected after a W shape and a neckline break', () => {
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push(100 - i * 0.5); // fall to 80
  for (let i = 0; i < 10; i++) closes.push(80 + i * 1); // bounce to 90
  for (let i = 0; i < 10; i++) closes.push(90 - i * 1); // back to 80
  for (let i = 0; i < 14; i++) closes.push(80 + i * 1.2); // rally through 90
  const b = closes.map((c, i) => ({ t: i, o: c, h: c + 0.3, l: c - 0.3, c, v: 1e6 }));
  const a = analyze(b, { symbol: 'W' });
  assert.ok(a.patterns.some((p) => p.id === 'double_bottom'), a.patterns.map((p) => p.id).join(','));
});

test('support and resistance bracket the price', () => {
  const b = bars(260, { drift: 0, vol: 0.03 });
  const lv = levels(b);
  const price = b.at(-1).c;
  assert.ok(lv.support.every((l) => l.price < price));
  assert.ok(lv.resistance.every((l) => l.price > price));
});

test('regime turns bullish when indexes trend up', () => {
  const up = analyze(bars(300, { drift: 0.004 }), { symbol: 'SPY' });
  const r = marketRegime({ SPY: up, QQQ: { ...up, symbol: 'QQQ' }, IWM: { ...up, symbol: 'IWM' } });
  assert.ok(r.score > 12, `score ${r.score}`);
  assert.equal(r.tone, 'bullish');
  assert.ok(r.posture.length > 10);
});

test('Black-Scholes satisfies put-call parity and implied vol inverts it', () => {
  const p = { spot: 100, strike: 105, t: 0.25, iv: 0.3 };
  const c = blackScholes({ ...p, right: 'call' });
  const put = blackScholes({ ...p, right: 'put' });
  const parity = c.price - put.price - (100 - 105 * Math.exp(-0.04 * 0.25));
  assert.ok(Math.abs(parity) < 1e-6);
  assert.ok(c.delta > 0 && c.delta < 1 && put.delta < 0);
  const iv = impliedVol({ price: c.price, spot: 100, strike: 105, t: 0.25, right: 'call' });
  assert.ok(Math.abs(iv - 0.3) < 1e-4);
  assert.ok(Math.abs(expectedMove(100, 0.4, 10) - 6.62) < 0.01);
});

test('strategy risk of a call debit spread', () => {
  const r = strategyRisk([{ right: 'call', strike: 100, side: 'buy', price: 3 }, { right: 'call', strike: 110, side: 'sell', price: 1 }], 100);
  assert.equal(r.netDebit, 200);
  assert.equal(r.maxLoss, -200);
  assert.equal(r.maxProfit, 800);
  assert.deepEqual(r.breakevens, [102]);
});

test('contract ranking prefers the target delta and skips unknown deltas', () => {
  const today = '2026-10-15';
  const cs = [90, 100, 110, 120].map((k) => enrichContract({ id: 'c' + k, right: 'call', strike: k, expiration: '2026-11-20', bid: 0, ask: 0, mark: Math.max(0.5, 100 - k + 4), iv: 0.00001, openInterest: 500 }, 100, today));
  const ranked = rankContracts(cs, { right: 'call', minDte: 20, maxDte: 60, targetDelta: 0.5 });
  assert.ok(ranked[0].delta > 0.35 && ranked[0].delta < 0.7, `delta ${ranked[0].delta}`);
});

test('market clock knows holidays, early closes and DST', () => {
  assert.equal(isTradingDay('2026-11-26'), false); // Thanksgiving
  assert.equal(isTradingDay('2026-10-17'), false); // Saturday
  assert.equal(isTradingDay('2026-10-15'), true);
  assert.equal(sessionBounds('2026-11-27').close, 780);
  assert.equal(nextTradingDay('2026-07-02'), '2026-07-06');
  assert.equal(thirdFriday(2026, 10), '2026-10-16');
  assert.equal(nyTimeToDate('2026-07-15', '09:30').toISOString(), '2026-07-15T13:30:00.000Z');
  assert.equal(nyTimeToDate('2026-12-15', '09:30').toISOString(), '2026-12-15T14:30:00.000Z');
  assert.equal(marketStatus(new Date('2026-10-15T15:00:00Z')).session, 'regular');
  assert.equal(marketStatus(new Date('2026-10-15T11:00:00Z')).session, 'pre');
});

test('planner slots and due check-ins', () => {
  assert.equal(slotsFor('2026-10-17').length, 0);
  assert.ok(slotsFor('2026-10-15').length >= 8);
  const due = dueSlot(new Date('2026-10-15T14:50:00Z'), 0); // 10:50 ET
  assert.equal(due.time, '10:45');
  assert.equal(dueSlot(new Date('2026-10-15T14:50:00Z'), Date.parse('2026-10-15T14:46:00Z')), null);
  const ev = weekEvents('2026-10-28', {});
  assert.ok(ev.find((d) => d.iso === '2026-10-28').events.some((e) => e.type === 'fomc'));
});

test('modes: AI tuning is clamped to bounds; user limits only tighten', () => {
  assert.equal(MODES.length, 5);
  const p = resolveParams('fortress', { stopLossPct: 50, maxOptionsAllocPct: 90 }, { dailyLossLimitPct: 1 });
  assert.equal(p.stopLossPct, 6); // clamped to the bound
  assert.equal(p.maxOptionsAllocPct, 0); // not AI-adjustable
  assert.equal(p.dailyLossLimitPct, 1);
  assert.equal(resolveParams('moonshot', {}, { dailyLossLimitPct: 50 }).dailyLossLimitPct, 10);
});

test('helpers: tolerant JSON, ticks and sane quotes', () => {
  assert.deepEqual(parseJsonLoose('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('note {"b":2} end'), { b: 2 });
  assert.equal(tickRound(1.234, { option: true }), 1.23);
  assert.equal(tickRound(4.12, { option: true }), 4.1);
  assert.equal(tickRound(10.001, { direction: 'up' }), 10.01);
  assert.deepEqual(saneQuote({ price: 100, bid: 99.9, ask: 120 }), { price: 100, bid: 99.9, ask: 100 });
});
