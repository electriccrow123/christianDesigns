import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../public/js/engine.js';

const call = { contract: 'AAPL261016C00250000', symbol: 'AAPL', right: 'call', strike: 250, expiration: 1791158400 };
const put = { contract: 'AAPL261016P00200000', symbol: 'AAPL', right: 'put', strike: 200, expiration: 1791158400 };

test('buy and sell stock updates cash, avg cost and realized P/L', () => {
  const s = E.newGame(10000);
  assert.ok(E.tradeStock(s, { symbol: 'AAPL', side: 'buy', qty: 10, price: 100 }).ok);
  assert.ok(E.tradeStock(s, { symbol: 'AAPL', side: 'buy', qty: 10, price: 200 }).ok);
  assert.equal(s.cash, 7000);
  assert.equal(s.positions.AAPL.avgCost, 150);
  assert.ok(E.tradeStock(s, { symbol: 'AAPL', side: 'sell', qty: 20, price: 160 }).ok);
  assert.equal(s.cash, 10200);
  assert.equal(s.realizedPL, 200);
  assert.equal(s.positions.AAPL, undefined);
});

test('cannot overspend or sell what you do not own', () => {
  const s = E.newGame(1000);
  assert.equal(E.tradeStock(s, { symbol: 'X', side: 'buy', qty: 11, price: 100 }).ok, false);
  assert.equal(E.tradeStock(s, { symbol: 'X', side: 'sell', qty: 1, price: 100 }).ok, false);
});

test('long call round trip with fees', () => {
  const s = E.newGame(10000);
  assert.ok(E.tradeOption(s, { contract: call, side: 'buy', qty: 2, price: 3 }).ok);
  assert.equal(s.cash, 10000 - 600 - 1.3);
  assert.ok(E.tradeOption(s, { contract: call, side: 'sell', qty: 2, price: 5 }).ok);
  assert.equal(s.realizedPL, E.round2(400 - 2.6));
  assert.equal(s.cash, E.round2(10000 + 400 - 2.6));
});

test('covered call needs 100 shares and locks them', () => {
  const s = E.newGame(100000);
  assert.equal(E.tradeOption(s, { contract: call, side: 'sell', qty: 1, price: 2 }).ok, false);
  E.tradeStock(s, { symbol: 'AAPL', side: 'buy', qty: 100, price: 240 });
  assert.ok(E.tradeOption(s, { contract: call, side: 'sell', qty: 1, price: 2 }).ok);
  assert.equal(E.tradeStock(s, { symbol: 'AAPL', side: 'sell', qty: 1, price: 240 }).ok, false);
  assert.equal(s.positions[call.contract].qty, -1);
});

test('cash-secured put reserves collateral and expires worthless', () => {
  const s = E.newGame(25000);
  assert.ok(E.tradeOption(s, { contract: put, side: 'sell', qty: 1, price: 1.5 }).ok);
  assert.equal(E.reservedCash(s), 20000);
  assert.equal(E.buyingPower(s), E.round2(25000 + 150 - 0.65 - 20000));
  const ev = E.settleExpired(s, { AAPL: 230 }, E.expiryCutoff(put.expiration) + 1);
  assert.equal(ev.length, 1);
  assert.equal(E.reservedCash(s), 0);
  assert.equal(s.realizedPL, E.round2(150 - 0.65));
});

test('ITM long call settles at intrinsic', () => {
  const s = E.newGame(10000);
  E.tradeOption(s, { contract: call, side: 'buy', qty: 1, price: 4 });
  E.settleExpired(s, { AAPL: 260 }, E.expiryCutoff(call.expiration) + 1);
  assert.equal(s.realizedPL, E.round2(600 - 0.65));
});

test('limit and stop orders fill when triggered', () => {
  const s = E.newGame(10000);
  E.placeOrder(s, { asset: 'stock', symbol: 'MSFT', side: 'buy', orderType: 'limit', qty: 5, price: 100 });
  assert.equal(E.processOrders(s, { MSFT: { price: 101 } }).fills.length, 0);
  assert.equal(E.processOrders(s, { MSFT: { price: 99 } }).fills.length, 1);
  assert.ok(E.placeOrder(s, { asset: 'stock', symbol: 'MSFT', side: 'sell', orderType: 'stop', qty: 5, price: 90 }).ok);
  assert.equal(E.processOrders(s, { MSFT: { price: 89 } }).fills.length, 1);
  assert.equal(s.positions.MSFT, undefined);
});

test('portfolio valuation and greeks sanity', () => {
  const s = E.newGame(10000);
  E.tradeStock(s, { symbol: 'A', side: 'buy', qty: 10, price: 100 });
  const v = E.valuePortfolio(s, { A: { price: 110, previousClose: 105 } });
  assert.equal(v.equity, 10100);
  assert.equal(v.dayChange, 50);
  const g = E.greeks({ S: 100, K: 100, T: 0.25, iv: 0.3, right: 'call' });
  assert.ok(g.delta > 0.5 && g.delta < 0.6);
  assert.ok(g.theta < 0);
});
