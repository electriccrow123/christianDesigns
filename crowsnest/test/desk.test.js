import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesk } from '../core/desk.js';
import { createPaperBroker } from '../core/paper.js';
import { blackScholes } from '../core/options.js';

const NOW = new Date('2026-10-15T15:30:00Z'); // Thursday 11:30 am New York

function memStore() {
  const docs = new Map();
  return {
    docs,
    get: async (p) => (docs.has(p) ? structuredClone(docs.get(p)) : null),
    set: async (p, d) => void docs.set(p, structuredClone(d)),
    update: async (p, d) => void docs.set(p, { ...(docs.get(p) || {}), ...structuredClone(d) }),
    remove: async (p) => void docs.delete(p),
    list: async (c, { orderBy, dir = 'asc', limit = 100 } = {}) => {
      const rows = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1).map((k) => ({ id: k.split('/').pop(), ...structuredClone(docs.get(k)) }));
      if (orderBy) rows.sort((a, b) => (a[orderBy] > b[orderBy] ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      return rows.slice(0, limit);
    },
  };
}

function fakeMarket() {
  const price = (s) => 50 + (s.charCodeAt(0) % 13) * 20 + s.length;
  const series = (s) => {
    let p = price(s) * 0.7;
    const out = [];
    for (let i = 0; i < 300; i++) {
      const o = p;
      p = p * (1 + 0.0012 + Math.sin(i / 6 + s.length) * 0.008);
      out.push({ t: 1.76e9 + i * 86400, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p, v: 1e6 });
    }
    return out;
  };
  const last = (s) => series(s).at(-1).c;
  const contract = (id) => {
    const [sym, exp, k, right] = id.split('|');
    const spot = last(sym);
    const t = Math.max(1, (Date.parse(exp) - NOW.getTime()) / 86400000) / 365;
    const g = blackScholes({ spot, strike: Number(k), t, iv: 0.35, right });
    return { id, symbol: sym, right, strike: Number(k), expiration: exp, bid: g.price * 0.98, ask: g.price * 1.02, mark: g.price, iv: 0.35, delta: g.delta, openInterest: 800, volume: 100 };
  };
  return {
    quotes: async (syms) => syms.map((s) => ({ symbol: s, price: last(s), prevClose: last(s) * 0.99, changePct: 1, bid: last(s) * 0.9995, ask: last(s) * 1.0005 })),
    bars: async (syms) => Object.fromEntries(syms.map((s) => [s, series(s)])),
    fundamentals: async (syms) => Object.fromEntries(syms.map((s) => [s, { marketCapB: 500 }])),
    expirations: async () => ['2026-11-20', '2026-12-18'],
    chain: async (sym, exp) => {
      const spot = last(sym);
      const out = [];
      for (let k = Math.round(spot * 0.8); k <= spot * 1.2; k += Math.max(1, Math.round(spot / 40))) for (const r of ['call', 'put']) out.push(contract(`${sym}|${exp}|${k}|${r}`));
      return out;
    },
    optionQuotes: async (cs) => Object.fromEntries(cs.map((c) => [c.id || c.contractId, contract(c.id || c.contractId)])),
    earnings: async () => [],
    ratings: async () => ({}),
    search: async (q) => [{ symbol: q.toUpperCase(), name: q }],
  };
}

function scriptedAI(decisions) {
  const seen = [];
  return {
    seen,
    async json(prompt, { agent }) {
      seen.push(agent);
      if (agent === 'scout') return { marketRead: 'ok', setups: [], avoid: [], keyLevels: [] };
      if (agent === 'analyst') return { summary: 'ok', ideas: [], eventRisks: [], avoid: [] };
      if (agent === 'honcho') return { headline: 'Test cycle', summary: 'Testing.', marketView: { label: 'Neutral', confidence: 50, why: '' }, decisions, today: { briefing: 'Plan.', keyLevels: [], schedule: [{ time: '13:00', task: 'check' }], watch: [] }, week: null, paramAdjustments: { stopLossPct: 99 }, memory: ['note'], messageToOwner: '' };
      if (agent === 'operator') return { tickets: decisions.map((d) => ({ decisionId: d.id, verdict: 'send' })), positionReview: [], log: 'ok' };
      throw new Error('unexpected agent');
    },
    async text() {
      return { text: 'ok' };
    },
  };
}

function setup(decisions, cash = 50000) {
  const store = memStore();
  const market = fakeMarket();
  const paper = createPaperBroker({ market, load: () => store.get('desk/paper'), save: (s) => store.set('desk/paper', s), startCash: cash });
  const ai = scriptedAI(decisions);
  const desk = createDesk({ market, brokers: { paper, live: null }, ai, store, now: () => NOW });
  return { store, desk, ai, paper };
}

test('a full cycle: researchers, decision, operator, gate, paper fills, plan and journal', async () => {
  const { desk, ai, store } = setup([
    { id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'test buy' },
    { id: 'd2', action: 'open', symbol: 'MSFT', vehicle: 'long_call', direction: 'bullish', conviction: 4, sizePct: 4, when: 'now', why: 'test call' },
    { id: 'd3', action: 'open', symbol: 'NVDA', vehicle: 'stock', direction: 'bullish', conviction: 3, sizePct: 90, when: 'now', why: 'too big' },
    { id: 'd4', action: 'watch', symbol: 'TSLA', direction: 'bullish', conviction: 2, why: 'not ready' },
  ]);
  const cycle = await desk.runCycle('intraday');
  assert.equal(cycle.status, 'done', cycle.error);
  assert.deepEqual([...new Set(ai.seen)].sort(), ['analyst', 'honcho', 'operator', 'scout']);
  const intents = await desk.listIntents();
  const by = Object.fromEntries(intents.map((i) => [i.symbol, i]));
  assert.equal(by.AAPL.status, 'filled');
  assert.equal(by.MSFT.status, 'filled');
  assert.equal(by.MSFT.ticket.strategy, 'long_call');
  assert.ok(Math.abs(by.MSFT.ticket.legs[0].delta) >= 0.38);
  assert.equal(by.NVDA.gate.decision, 'resize'); // 90% asked, Balanced caps at 20%
  assert.ok(by.NVDA.gate.cost <= 50000 * 0.2 + 1);
  assert.equal(by.TSLA.status, 'watching');
  const snap = await desk.snapshot({ force: true });
  assert.equal(snap.stocks.length, 2);
  assert.equal(snap.options.length, 1);
  const plan = await desk.getPlan();
  assert.equal(plan.today.briefing, 'Plan.');
  const state = await desk.getState();
  assert.equal(state.paramOverrides.stopLossPct, 12); // clamped to Balanced's 5–12 bound
  assert.ok(store.docs.has(`cycles/${cycle.id}`));
  const exits = await desk.getExits();
  assert.ok(exits.AAPL?.stop && exits.AAPL?.target);
});

test('kill switch stops new positions in a cycle', async () => {
  const { desk } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 5, sizePct: 5, when: 'now', why: 'x' }]);
  await desk.patchState({ killSwitch: true });
  await desk.runCycle('intraday');
  const [i] = await desk.listIntents();
  assert.equal(i.status, 'blocked');
  assert.match(i.gate.summary, /kill switch/i);
});

test('options that do not fit the budget fall back to a debit spread or are skipped', async () => {
  const { desk } = setup([{ id: 'd1', action: 'open', symbol: 'MSFT', vehicle: 'long_call', direction: 'bullish', conviction: 4, sizePct: 0.5, when: 'now', why: 'x' }], 20000);
  await desk.runCycle('intraday');
  const [i] = await desk.listIntents();
  assert.ok(i.vehicle === 'long_call');
  assert.ok(i.ticket?.strategy === 'call_debit_spread' || i.status === 'skipped' || i.status === 'blocked', `${i.status} ${i.ticket?.strategy}`);
});

test('owner can close a position and the exit plan is cleared', async () => {
  const { desk } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'x' }]);
  await desk.runCycle('intraday');
  const closed = await desk.closePosition({ symbol: 'AAPL' });
  assert.equal(closed.status, 'filled');
  const snap = await desk.snapshot({ force: true });
  assert.equal(snap.stocks.length, 0);
  assert.equal((await desk.getExits()).AAPL, undefined);
});

test('the Head Honcho’s exit changes apply before the Operator, who may only tighten stops', async () => {
  const { desk, store, paper } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'x' }]);
  await desk.runCycle('intraday');
  const px = (await fakeMarket().quotes(['AAPL']))[0].price;
  let operatorPrompt = '';
  const ai2 = {
    async json(prompt, { agent }) {
      if (agent === 'scout') return { marketRead: 'ok', setups: [], avoid: [], keyLevels: [] };
      if (agent === 'analyst') return { summary: 'ok', ideas: [], eventRisks: [], avoid: [] };
      if (agent === 'honcho') return { headline: 'Raise the stop', summary: 'x', marketView: { label: 'Neutral', confidence: 50, why: '' }, decisions: [{ id: 'd1', action: 'adjust_exit', symbol: 'AAPL', vehicle: 'stock', exit: { stop: round2(px * 0.97), target: round2(px * 1.1), timeStop: null }, why: 'Raise the stop under support. More text.' }], today: null, week: null, paramAdjustments: {}, memory: [], messageToOwner: '' };
      if (agent === 'operator') {
        operatorPrompt = prompt;
        return { tickets: [], positionReview: [{ key: 'AAPL', status: 'ok', newStop: round2(px * 0.9), newTarget: round2(px * 1.2), note: 'looser stop' }], log: 'ok' };
      }
      throw new Error('unexpected agent');
    },
    async text() {
      return { text: 'ok' };
    },
  };
  const desk2 = createDesk({ market: fakeMarket(), brokers: { paper, live: null }, ai: ai2, store, now: () => NOW });
  const cycle = await desk2.runCycle('intraday');
  assert.equal(cycle.status, 'done', cycle.error);
  assert.ok(operatorPrompt.includes(String(round2(px * 0.97))), 'operator saw the new stop');
  const exit = (await desk2.getExits()).AAPL;
  assert.equal(exit.stop, round2(px * 0.97)); // the looser 10% stop was ignored
  assert.equal(exit.target, round2(px * 1.2)); // targets may move
  assert.equal(exit.adopted, false);
});

function round2(x) {
  return Math.round(x * 100) / 100;
}

function failingHonchoAI() {
  return {
    async json(prompt, { agent }) {
      if (agent === 'scout') return { marketRead: 'ok', setups: 'not an array', avoid: [], keyLevels: [] };
      if (agent === 'analyst') return { summary: 'ok', ideas: {}, eventRisks: [], avoid: [] };
      if (agent === 'honcho') throw new Error('upstream_error');
      return { tickets: [], positionReview: [], log: '' };
    },
    async text() {
      return { text: 'ok' };
    },
  };
}

test('a triggered stop goes out before the agents, even when the Head Honcho fails', async () => {
  const { desk, store, paper } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'x' }]);
  await desk.runCycle('intraday');
  const px = (await fakeMarket().quotes(['AAPL']))[0].price;
  await desk.setExitPlan('AAPL', { stop: round2(px * 1.01), target: round2(px * 1.2) }); // stop is above the price: triggered
  const desk2 = createDesk({ market: fakeMarket(), brokers: { paper, live: null }, ai: failingHonchoAI(), store, now: () => NOW });
  const cycle = await desk2.runCycle('intraday');
  assert.equal(cycle.status, 'error');
  const exit = (await desk2.listIntents()).find((i) => i.source === 'exit');
  assert.equal(exit?.status, 'filled');
  assert.equal((await desk2.snapshot({ force: true })).stocks.length, 0);
});

test('stale plans for positions no longer held are dropped instead of selling the new position', async () => {
  const { desk } = setup([]);
  await desk.setExitPlan('MSFT', { stop: 99999, target: 100000 }); // left over from an old round trip
  await desk.runCycle('intraday');
  assert.equal((await desk.getExits()).MSFT, undefined);
  assert.equal((await desk.listIntents()).filter((i) => i.source === 'exit').length, 0);
});

test('an old exit intent that matches no order expires and stops blocking new exits', async () => {
  const { desk, store, paper } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'x' }]);
  await desk.runCycle('intraday');
  const old = NOW.getTime() - 2 * 86400000;
  await store.set('intents/old-exit', { id: 'old-exit', source: 'exit', symbol: 'AAPL', status: 'sent', createdAt: old, updatedAt: old, ticket: { kind: 'stock', symbol: 'AAPL' }, broker: { orderId: 'gone' } });
  const px = (await fakeMarket().quotes(['AAPL']))[0].price;
  await desk.setExitPlan('AAPL', { stop: round2(px * 1.01), target: round2(px * 1.2) });
  const desk2 = createDesk({ market: fakeMarket(), brokers: { paper, live: null }, ai: scriptedAI([]), store, now: () => NOW });
  await desk2.runCycle('intraday');
  assert.equal((await store.get('intents/old-exit')).status, 'expired');
  assert.ok((await desk2.listIntents()).some((i) => i.source === 'exit' && i.status === 'filled'));
});

test('orders in one cycle share the buying power instead of each spending all of it', async () => {
  const syms = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META'];
  const { desk } = setup([...syms.map((s, i) => ({ id: `d${i + 1}`, action: 'open', symbol: s, vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 20, when: 'now', why: s })), { id: 'd9', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 5, when: 'now', why: 'again' }], 1000);
  await desk.runCycle('intraday');
  const intents = await desk.listIntents();
  const spent = intents.filter((i) => i.status === 'filled').reduce((a, i) => a + (i.gate?.cost || 0), 0);
  assert.ok(spent > 600 && spent <= 1000 * 0.85 + 1, `spent ${spent}`); // 85% invested cap across all five
  assert.equal(intents.filter((i) => i.symbol === 'AAPL' && i.status === 'filled').length, 1); // the second AAPL buy is a duplicate
});

test('an owner trim keeps the exit plan for the shares that remain', async () => {
  const { desk } = setup([{ id: 'd1', action: 'open', symbol: 'AAPL', vehicle: 'stock', direction: 'bullish', conviction: 4, sizePct: 10, when: 'now', why: 'x' }]);
  await desk.runCycle('intraday');
  const before = (await desk.getExits()).AAPL;
  const r = await desk.closePosition({ symbol: 'AAPL', fraction: 0.5 });
  assert.equal(r.status, 'filled');
  assert.equal((await desk.getExits()).AAPL?.stop, before.stop);
});
