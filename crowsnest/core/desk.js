// The desk: runs the four-agent trading cycle, the risk gate, execution, exits, chat and the journal.
// Everything outside this file is injected, so the same desk runs in the claude.ai page (Robinhood
// connector + Claude) and on the self-hosted server (Claude API + paper broker).
//
// deps:
//   market  quotes / bars / fundamentals / expirations / chain / optionQuotes / earnings / ratings / search
//   broker  live Robinhood or paper: account / snapshot / preview / place / cancel
//   ai      json(prompt, opts) / text(input, opts)
//   store   get / set / update / list / remove   (document store)

import { round, uuid, shortId, slim, uniq, pool, money, maskAccount, clamp, tickRound, saneQuote } from './util.js';
import { marketStatus, todayNY, addDays, daysBetween, weekDays } from './market-clock.js';
import { analyze, brief } from './patterns.js';
import { marketRegime, INDEX_ETFS, FEAR_GAUGE } from './regime.js';
import { resolveParams, modeRules, adjustableSpec, modeById, modeByLevel, DEFAULT_LIMITS } from './modes.js';
import { evaluate, normalizeTicket, exitSignals, exposure, countDayTrades, inferStrategy } from './risk.js';
import { enrichContract, rankContracts, expectedMove, contractLabel, MULTIPLIER, STRATEGIES } from './options.js';
import { AGENTS, scoutPrompt, analystPrompt, honchoPrompt, operatorPrompt, chatRules, explainPrompt, deepDivePrompt } from './agents.js';
import { weekEvents, emptyWeekPlan, emptyDayPlan } from './planner.js';

export const DEFAULT_WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'PLTR', 'COIN', 'SOFI'];

export const DEFAULT_SETTINGS = {
  mode: 'balanced',
  broker: 'paper', // 'paper' | 'live'
  execution: 'confirm', // live only: 'confirm' (you press Send) | 'auto' (gate-approved orders go out)
  accountNumber: null,
  limits: DEFAULT_LIMITS,
  watchlist: DEFAULT_WATCHLIST,
  paperStartCash: 10000,
  serverAutopilot: false,
};

const P = {
  settings: 'desk/settings',
  state: 'desk/state',
  plan: 'desk/plan',
  exits: 'desk/exits',
  equity: 'desk/equity',
  cycles: 'cycles',
  intents: 'intents',
  chat: 'chat',
};
export const PATHS = P;

const ACTIVE_INTENT = new Set(['watching', 'planned', 'proposed', 'queued', 'needs_review', 'sent', 'pending_approval', 'working']);

export function createDesk({ market, brokers, ai, store, now = () => new Date(), log = () => {} }) {
  const cache = { analyses: new Map(), snapshot: null, snapshotAt: 0 };

  // ------------------------------------------------------------ settings & state
  async function getSettings() {
    const s = (await store.get(P.settings).catch(() => null)) || {};
    return { ...DEFAULT_SETTINGS, ...s, limits: { ...DEFAULT_LIMITS, ...(s.limits || {}) }, watchlist: s.watchlist?.length ? s.watchlist : DEFAULT_WATCHLIST };
  }
  async function saveSettings(patch) {
    const next = { ...(await getSettings()), ...patch, updatedAt: Date.now() };
    await store.set(P.settings, next);
    return next;
  }
  async function getState() {
    return { killSwitch: false, paramOverrides: {}, memory: [], directives: [], day: null, peakEquity: 0, ...((await store.get(P.state).catch(() => null)) || {}) };
  }
  async function patchState(patch) {
    const next = { ...(await getState()), ...patch, updatedAt: Date.now() };
    await store.set(P.state, next);
    return next;
  }
  async function getPlan() {
    const p = (await store.get(P.plan).catch(() => null)) || {};
    return { week: p.week || emptyWeekPlan(todayNY(now())), today: p.today || emptyDayPlan(todayNY(now())), updatedAt: p.updatedAt || null };
  }
  async function getExits() {
    return (await store.get(P.exits).catch(() => null))?.plans || {};
  }
  async function setExitPlan(key, plan) {
    const plans = await getExits();
    if (plan) plans[key] = { ...plans[key], ...plan, updatedAt: Date.now() };
    else delete plans[key];
    await store.set(P.exits, { plans });
    return plans;
  }

  async function brokerFor(settings) {
    return settings.broker === 'live' && brokers.live ? brokers.live : brokers.paper;
  }

  // ------------------------------------------------------------ account snapshot
  async function snapshot({ force = false } = {}) {
    if (!force && cache.snapshot && Date.now() - cache.snapshotAt < 8000) return cache.snapshot;
    const settings = await getSettings();
    const broker = await brokerFor(settings);
    const snap = await broker.snapshot({ accountNumber: settings.accountNumber });
    cache.snapshot = snap;
    cache.snapshotAt = Date.now();
    await trackDay(snap).catch(() => {});
    return snap;
  }

  /** Remember today's starting equity, the all-time peak, and an equity curve point. */
  async function trackDay(snap) {
    const st = await getState();
    const today = todayNY(now());
    const eq = snap.portfolio?.equity;
    if (!Number.isFinite(eq)) return;
    const patch = {};
    const mode = snap.live ? 'live' : 'paper';
    if (!st.day || st.day.date !== today || st.day.mode !== mode) patch.day = { date: today, mode, startEquity: round(eq - (snap.portfolio.dayChange || 0), 2) };
    if (eq > (st.peakEquity || 0) || st.peakMode !== mode) {
      patch.peakEquity = eq;
      patch.peakMode = mode;
    }
    if (Object.keys(patch).length) await patchState(patch);
    const curve = (await store.get(P.equity).catch(() => null)) || { live: [], paper: [] };
    const pts = curve[mode] || [];
    const lastPt = pts[pts.length - 1];
    if (!lastPt || Date.now() - lastPt[0] > 15 * 60 * 1000 || Math.abs(lastPt[1] - eq) / (eq || 1) > 0.01) {
      pts.push([Date.now(), round(eq, 2)]);
      curve[mode] = pts.slice(-1500);
      await store.set(P.equity, curve);
    }
  }

  // ------------------------------------------------------------ analysis
  async function analyzeSymbols(symbols, { intraday = [], maxAgeMs = 10 * 60 * 1000 } = {}) {
    symbols = uniq(symbols.map((s) => s.toUpperCase()).filter(Boolean));
    const out = {};
    const need = [];
    for (const s of symbols) {
      const hit = cache.analyses.get(s);
      if (hit && Date.now() - hit.at < maxAgeMs && !intraday.includes(s)) out[s] = hit.value;
      else need.push(s);
    }
    if (need.length) {
      const bars = await market.bars(need, { interval: 'day', days: 400 }).catch((e) => {
        log('bars failed', e);
        return {};
      });
      let intra = {};
      const wantIntra = need.filter((s) => intraday.includes(s));
      if (wantIntra.length) intra = await market.bars(wantIntra, { interval: '5minute', days: 1 }).catch(() => ({}));
      for (const s of need) {
        const a = analyze(bars[s] || [], { symbol: s, intraday: intra[s] });
        a.bars = bars[s] || [];
        cache.analyses.set(s, { at: Date.now(), value: a });
        out[s] = a;
      }
    }
    return out;
  }

  async function scan({ symbols } = {}) {
    const settings = await getSettings();
    const list = uniq([...INDEX_ETFS, ...(symbols || settings.watchlist)]);
    const [analyses, fear] = await Promise.all([analyzeSymbols(list), market.quotes([FEAR_GAUGE]).then((q) => q[0]).catch(() => null)]);
    return { analyses, regime: marketRegime(analyses, { fear }), fear };
  }

  // ------------------------------------------------------------ options helpers
  async function contractsFor(symbol, { minDte, maxDte, preferDte, spot }) {
    const today = todayNY(now());
    const exps = (await market.expirations(symbol).catch(() => [])).filter((e) => {
      const d = daysBetween(today, e);
      return d >= minDte && d <= maxDte;
    });
    if (!exps.length) return [];
    const pick = exps.slice().sort((a, b) => Math.abs(daysBetween(today, a) - preferDte) - Math.abs(daysBetween(today, b) - preferDte)).slice(0, 2);
    const chains = await Promise.all(pick.map((e) => market.chain(symbol, e, { spot }).catch(() => [])));
    return chains.flat().map((c) => enrichContract(c, spot, today));
  }

  function snapshotOptions(contracts, spot) {
    if (!contracts.length || !spot) return null;
    const exp = contracts[0].expiration;
    const same = contracts.filter((c) => c.expiration === exp);
    const near = (right) => same.filter((c) => c.right === right).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    const call = near('call');
    const put = near('put');
    const iv = [call?.iv, put?.iv].filter((v) => v > 0);
    const atmIv = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : undefined;
    const dte = call?.dte ?? put?.dte;
    const em = expectedMove(spot, atmIv, dte);
    const view = (c) => c && { strike: c.strike, mid: c.mid, spreadPct: c.spreadPct, oi: c.openInterest, delta: c.delta, costPerContract: round((c.ask || c.mid) * MULTIPLIER, 2) };
    return { expiration: exp, dte, atmIvPct: atmIv ? round(atmIv * 100, 1) : undefined, expectedMove: em ? round(em, 2) : undefined, expectedMovePct: em ? round((em / spot) * 100, 1) : undefined, atmCall: view(call), atmPut: view(put) };
  }

  // ------------------------------------------------------------ ticket drafting
  async function draftTicket(decision, { params, snap, quotes, analyses }) {
    const sym = decision.symbol?.toUpperCase();
    const q = saneQuote(quotes[sym] || { price: analyses[sym]?.price });
    const spot = q.price || analyses[sym]?.price;
    const equity = snap.portfolio.equity || 0;
    const budget = (equity * clamp(Number(decision.sizePct) || 0, 0, 100)) / 100;
    const base = { conviction: decision.conviction, why: decision.why, exit: decision.exit, meta: { decisionId: decision.id, agent: true } };
    let vehicle = decision.vehicle || 'stock';
    const notes = [];

    if (decision.action === 'close' || decision.action === 'trim') {
      const frac = decision.action === 'trim' ? 0.5 : 1;
      const st = snap.stocks.find((s) => s.symbol === sym);
      const opts = snap.options.filter((o) => o.symbol === sym && (!decision.contractId || o.id === decision.contractId));
      if (st && (vehicle === 'stock' || !opts.length)) {
        const avail = st.available ?? st.qty;
        let qtyOut = Number.isInteger(avail) ? Math.max(1, Math.floor(avail * frac)) : round(avail * frac, 6);
        if (frac === 1) qtyOut = avail;
        const whole = Number.isInteger(qtyOut);
        return { ticket: normalizeTicket({ ...base, kind: 'stock', symbol: sym, side: 'sell', quantity: qtyOut, orderType: whole ? 'limit' : 'market', limitPrice: whole ? tickRound((q.bid || spot) * 0.999, { direction: 'down' }) : null }), candidates: [], notes };
      }
      if (opts.length) {
        const o = opts[0];
        const long = o.qty > 0;
        const qn = Math.max(1, Math.floor(Math.abs(o.qty) * frac));
        return {
          ticket: normalizeTicket({ ...base, kind: 'option', symbol: sym, positionEffect: 'close', quantity: qn, price: tickRound(o.mark || o.bid || 0.01, { option: true }), legs: [{ contractId: o.id, right: o.right, strike: o.strike, expiration: o.expiration, side: long ? 'sell' : 'buy', positionEffect: 'close', bid: o.bid, ask: o.ask, mid: o.mark }] }),
          candidates: [],
          notes,
        };
      }
      return { ticket: null, candidates: [], notes: [`No ${sym} position to ${decision.action}.`] };
    }

    // Opening trades
    if (vehicle === 'stock' && decision.direction === 'bearish') {
      if (params.strategies.includes('long_put')) {
        vehicle = 'long_put';
        notes.push('Bearish stock idea converted to a long put (no short selling).');
      } else return { ticket: null, candidates: [], notes: ['Bearish stock ideas need puts, which this mode does not allow.'] };
    }
    if (vehicle === 'stock') {
      if (!spot) return { ticket: null, candidates: [], notes: ['No price for ' + sym] };
      const whole = Math.floor(budget / (q.ask || spot));
      if (whole >= 1) return { ticket: normalizeTicket({ ...base, kind: 'stock', symbol: sym, side: 'buy', quantity: whole, orderType: 'limit', limitPrice: tickRound((q.ask || spot) * 1.002, { direction: 'up' }) }), candidates: [], notes };
      return { ticket: normalizeTicket({ ...base, kind: 'stock', symbol: sym, side: 'buy', dollars: Math.max(1, round(budget, 2)), orderType: 'market' }), candidates: [], notes: [...notes, 'Budget is under one share: using a fractional dollar order.'] };
    }

    // Options
    if (!params.strategies.includes(vehicle)) return { ticket: null, candidates: [], notes: [`${STRATEGIES[vehicle]?.name || vehicle} is not allowed in ${params.mode.name}.`] };
    const [dMin, dMax] = Array.isArray(decision.dte) && decision.dte.length === 2 ? decision.dte.map(Number) : [params.minDte, params.maxDte];
    const minDte = Math.max(params.minDte, Math.min(dMin, params.maxDte));
    const maxDte = Math.min(params.maxDte, Math.max(dMax, params.minDte));
    const preferDte = Math.round((minDte + maxDte) / 2);
    const contracts = await contractsFor(sym, { minDte, maxDte, preferDte, spot });
    if (!contracts.length) return { ticket: null, candidates: [], notes: [`No ${sym} option contracts between ${minDte} and ${maxDte} days.`] };
    const right = /call/.test(vehicle) ? 'call' : 'put';
    const targetDelta = clamp(Math.abs(Number(decision.targetDelta) || (params.deltaMin + params.deltaMax) / 2), params.deltaMin || 0.1, params.deltaMax || 0.9);
    const want = { right, minDte, maxDte, preferDte, maxSpreadPct: params.maxSpreadPct, minOpenInterest: params.minOpenInterest };
    const view = (c) => ({ contractId: c.id, label: contractLabel(c), right: c.right, strike: c.strike, expiration: c.expiration, dte: c.dte, bid: c.bid, ask: c.ask, mid: c.mid, delta: c.delta, iv: c.iv ? round(c.iv * 100, 1) : undefined, openInterest: c.openInterest, volume: c.volume, spreadPct: c.spreadPct, costPerContract: round((c.ask || c.mid) * MULTIPLIER, 2), fit: c.fit });
    const leg = (c, side) => ({ contractId: c.id, right: c.right, strike: c.strike, expiration: c.expiration, side, positionEffect: 'open', bid: c.bid, ask: c.ask, mid: c.mid, delta: c.delta, openInterest: c.openInterest, dte: c.dte, spreadPct: c.spreadPct });

    if (vehicle === 'long_call' || vehicle === 'long_put') {
      const ranked = rankContracts(contracts, { ...want, targetDelta });
      const inBand = (c) => c.delta != null && Math.abs(c.delta) >= params.deltaMin - 0.02 && Math.abs(c.delta) <= params.deltaMax + 0.05;
      const fits = ranked.filter(inBand);
      const affordable = fits.filter((c) => c.costPerContract <= Math.max(budget, 0) * 1.05);
      if (!fits.length) return { ticket: null, candidates: ranked.slice(0, 4).map(view), notes: [`No ${sym} ${right}s with delta ${params.deltaMin}–${params.deltaMax} and ${minDte}–${maxDte} days to expiration.`] };
      if (!affordable.length) {
        const spread = right === 'call' ? 'call_debit_spread' : 'put_debit_spread';
        const cheapest = fits.slice().sort((a, b) => a.costPerContract - b.costPerContract)[0];
        const why = `The cheapest ${sym} ${right} in the mode’s delta range costs $${cheapest.costPerContract}, above this trade’s $${round(budget, 2)} budget (${decision.sizePct}% of the account).`;
        if (params.strategies.includes(spread) && !decision._fromSingle) {
          const alt = await draftTicket({ ...decision, vehicle: spread, _fromSingle: true }, { params, snap, quotes, analyses });
          return { ...alt, notes: [why, 'Switched to a debit spread, which costs less for the same direction.', ...alt.notes] };
        }
        return { ticket: null, candidates: fits.slice(0, 4).map(view), notes: [why] };
      }
      const pick = affordable[0];
      const qn = Math.max(1, Math.floor(budget / pick.costPerContract));
      return {
        ticket: normalizeTicket({ ...base, kind: 'option', symbol: sym, strategy: vehicle, quantity: qn, price: tickRound(pick.mid + ((pick.ask > 0 ? pick.ask : pick.mid) - pick.mid) * 0.25, { option: true }), legs: [leg(pick, 'buy')] }),
        candidates: ranked.slice(0, 4).map(view),
        notes,
      };
    }
    if (vehicle === 'cash_secured_put' || vehicle === 'covered_call') {
      const ranked = rankContracts(contracts, { ...want, targetDelta: 0.27 });
      const pick = ranked[0];
      if (!pick) return { ticket: null, candidates: [], notes: ['No contracts matched.'] };
      return {
        ticket: normalizeTicket({ ...base, kind: 'option', symbol: sym, strategy: vehicle, quantity: 1, price: tickRound(pick.mid - (pick.mid - (pick.bid > 0 ? pick.bid : pick.mid)) * 0.25, { option: true }), direction: 'credit', legs: [leg(pick, 'sell')] }),
        candidates: ranked.slice(0, 4).map(view),
        notes,
      };
    }
    // Vertical spreads
    const debit = vehicle.includes('debit');
    const sameExp = (exp) => contracts.filter((c) => c.expiration === exp && c.right === right);
    const anchorRank = rankContracts(contracts, { ...want, targetDelta: debit ? Math.max(targetDelta, 0.45) : 0.3 });
    const anchor = anchorRank[0];
    if (!anchor) return { ticket: null, candidates: [], notes: ['No contracts matched.'] };
    const pool_ = sameExp(anchor.expiration).sort((a, b) => a.strike - b.strike);
    const em = expectedMove(spot, anchor.iv || 0.4, anchor.dte) || spot * 0.05;
    const wantWidth = Math.max(em * 0.6, spot * 0.02);
    const further = pool_.filter((c) => (right === 'call' ? c.strike > anchor.strike : c.strike < anchor.strike));
    const other = further.sort((a, b) => Math.abs(Math.abs(a.strike - anchor.strike) - wantWidth) - Math.abs(Math.abs(b.strike - anchor.strike) - wantWidth))[0];
    if (!other) return { ticket: null, candidates: anchorRank.slice(0, 4).map(view), notes: ['No second strike for the spread.'] };
    // Debit: buy the anchor (closer to the money), sell the further strike. Credit: sell the anchor, buy the further strike.
    const legs = debit ? [leg(anchor, 'buy'), leg(other, 'sell')] : [leg(anchor, 'sell'), leg(other, 'buy')];
    const net = Math.abs((anchor.mid || 0) - (other.mid || 0));
    const width = Math.abs(anchor.strike - other.strike);
    const perUnit = debit ? net * MULTIPLIER : (width - net) * MULTIPLIER;
    const qn = Math.max(1, Math.floor(budget / Math.max(perUnit, 1)));
    return {
      ticket: normalizeTicket({ ...base, kind: 'option', symbol: sym, strategy: vehicle, quantity: qn, price: tickRound(net, { option: true }), direction: debit ? 'debit' : 'credit', legs }),
      candidates: [...anchorRank.slice(0, 3), ...further.slice(0, 3)].map(view),
      notes: [...notes, `Spread width $${round(width, 2)}; ${debit ? 'max loss = debit' : 'max loss = width − credit'}.`],
    };
  }

  /** Apply the Operator's changes to a drafted ticket. Only candidate contracts are accepted. */
  function applyOperator(draft, op) {
    if (!draft.ticket || !op) return draft.ticket;
    const t = { ...draft.ticket, meta: { ...draft.ticket.meta } };
    const cands = new Map((draft.candidates || []).map((c) => [c.contractId, c]));
    const toLeg = (c, side) => ({ contractId: c.contractId, right: c.right, strike: c.strike, expiration: c.expiration, side, positionEffect: 'open', bid: c.bid, ask: c.ask, mid: c.mid, delta: c.delta, openInterest: c.openInterest, dte: c.dte, spreadPct: c.spreadPct });
    if (t.kind === 'option' && t.positionEffect === 'open') {
      if (Array.isArray(op.legs) && op.legs.length === t.legs.length && op.legs.every((l) => cands.has(l.contractId))) {
        t.legs = op.legs.map((l, i) => toLeg(cands.get(l.contractId), l.side === 'sell' || l.side === 'buy' ? l.side : t.legs[i].side));
        t.strategy = inferStrategy(t.legs);
      } else if (op.contractId && cands.has(op.contractId) && t.legs.length === 1) {
        t.legs = [toLeg(cands.get(op.contractId), t.legs[0].side)];
      }
      if (Number(op.limitPrice) > 0) t.price = tickRound(Number(op.limitPrice), { option: true });
      if (Number(op.quantity) >= 1) t.quantity = Math.floor(Number(op.quantity));
    } else if (t.kind === 'stock') {
      if (Number(op.dollars) >= 1) {
        t.dollars = round(Number(op.dollars), 2);
        t.quantity = null;
        t.orderType = 'market';
        t.limitPrice = null;
      } else if (Number(op.quantity) > 0) {
        t.quantity = Number(op.quantity);
        t.dollars = null;
      }
      if (['limit', 'market'].includes(op.orderType)) t.orderType = op.orderType;
      if (Number(op.limitPrice) > 0 && t.orderType === 'limit') t.limitPrice = Number(op.limitPrice);
    }
    if (op.tif === 'gtc' || op.tif === 'gfd') t.tif = op.tif;
    if (op.exit && (op.exit.stop || op.exit.target)) t.exit = { stop: Number(op.exit.stop) || null, target: Number(op.exit.target) || null, timeStop: op.exit.timeStop || null };
    if (op.note) t.meta.operatorNote = String(op.note).slice(0, 400);
    return normalizeTicket(t);
  }

  // ------------------------------------------------------------ intents
  async function saveIntent(intent) {
    intent.updatedAt = Date.now();
    await store.set(`${P.intents}/${intent.id}`, slim(intent, { maxArray: 40, maxString: 1500 }));
    return intent;
  }
  async function listIntents({ limit = 120 } = {}) {
    return store.list(P.intents, { orderBy: 'createdAt', dir: 'desc', limit }).catch(() => []);
  }
  function headlineFor(t, decision) {
    if (!t) return `${(decision?.action || 'watch').toUpperCase()} ${decision?.symbol || ''}`.trim();
    if (t.kind === 'stock') return `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.symbol} ${t.dollars ? money(t.dollars) : `${t.quantity} sh`}${t.limitPrice ? ` @ ${money(t.limitPrice)}` : ' at market'}`;
    const what = STRATEGIES[t.strategy]?.name || t.strategy;
    const legs = t.legs.map((l) => contractLabel({ ...l, symbol: '' }).trim()).join(' / ');
    return `${t.positionEffect === 'close' ? 'Close' : what} ${t.symbol} ${legs} ×${t.quantity}${t.price ? ` @ ${money(t.price)}` : ''}`;
  }

  async function gateContext({ settings, state, snap, params, quotes }) {
    const allOrders = snap.orders || [];
    const dt = countDayTrades(allOrders, todayNY(now()));
    const funds = await market.fundamentals(uniq(Object.keys(quotes))).catch(() => ({}));
    const earn = await upcomingEarnings(uniq(Object.keys(quotes))).catch(() => ({}));
    const openedToday = allOrders.filter((o) => o.agent && o.state === 'filled' && (o.positionEffect === 'open' || (o.kind === 'stock' && o.side === 'buy')) && todayNY(new Date(o.createdAt)) === todayNY(now())).length;
    return {
      params,
      limits: settings.limits,
      account: { equity: snap.portfolio.equity, buyingPower: snap.portfolio.buyingPower, cash: snap.portfolio.cash, optionLevel: snap.account.optionLevel, isMargin: /margin/.test(snap.account.type || ''), approvalsRequired: snap.account.approvalsRequired },
      positions: { stocks: snap.stocks, options: snap.options },
      openOrders: snap.openOrders || [],
      day: { startEquity: state.day?.startEquity, tradesOpened: openedToday, dayTradesRolling: dt.count, openedTodaySymbols: dt.openedToday },
      quotes,
      fundamentals: funds,
      earnings: earn,
      exposure: exposure({ stocks: snap.stocks, options: snap.options }),
      clock: marketStatus(now()),
      todayIso: todayNY(now()),
      killSwitch: state.killSwitch,
    };
  }

  let earningsCache = { at: 0, list: [] };
  async function earningsList() {
    if (Date.now() - earningsCache.at < 60 * 60 * 1000) return earningsCache.list;
    const list = await market.earnings({ days: 10 }).catch(() => []);
    earningsCache = { at: Date.now(), list };
    return list;
  }
  async function upcomingEarnings(symbols) {
    const list = await earningsList();
    const set = new Set(symbols);
    const out = {};
    for (const e of list) if (set.has(e.symbol) && (!out[e.symbol] || e.date < out[e.symbol])) out[e.symbol] = e.date;
    return out;
  }

  /**
   * Gate one ticket and, if allowed by settings, send it.
   * mode: 'auto' (send if approved) | 'queue' (gate only, wait for the owner) | 'force' (owner pressed Send)
   */
  async function processTicket(ticket, { settings, state, snap, params, quotes, sendMode }) {
    const ctx = await gateContext({ settings, state, snap, params, quotes });
    const gate = evaluate(ticket, ctx);
    const result = { gate, sent: false, status: gate.decision === 'block' ? 'blocked' : 'queued', broker: null };
    if (gate.decision === 'block') return result;
    const broker = await brokerFor(settings);
    const send = sendMode === 'force' || sendMode === 'auto';
    if (!send) return result;
    try {
      const pv = await broker.preview(gate.ticket, { accountNumber: settings.accountNumber });
      if (pv.alerts?.length && sendMode !== 'force') {
        result.status = 'needs_review';
        result.broker = { alerts: pv.alerts, message: 'Robinhood flagged this order. Review the alerts, then press Send if you still want it.' };
        return result;
      }
      if (!pv.ok && pv.blocking) {
        result.status = 'failed';
        result.broker = { alerts: pv.alerts, message: pv.message || 'Preview failed.' };
        return result;
      }
      const placed = await broker.place(gate.ticket, { accountNumber: settings.accountNumber });
      result.sent = placed.ok !== false;
      result.status = placed.ok === false ? 'failed' : placed.approvalPending ? 'pending_approval' : placed.state === 'filled' ? 'filled' : 'sent';
      result.broker = { orderId: placed.orderId, state: placed.state, approvalPending: !!placed.approvalPending, message: placed.reason || placed.message, alerts: pv.alerts };
      cache.snapshotAt = 0;
    } catch (err) {
      result.status = 'failed';
      result.broker = { message: err?.message || String(err), code: err?.code };
    }
    return result;
  }

  // ------------------------------------------------------------ the cycle
  /**
   * Run one full desk cycle.
   * @param {string} kind weekly | premarket | intraday | power | close | manual
   * @param {object} opts { onStep(step, info), signal }
   */
  async function runCycle(kind = 'manual', { onStep = () => {}, signal, source = null, prune = true } = {}) {
    const clock = marketStatus(now());
    if (kind === 'manual') kind = clock.session === 'regular' ? (clock.minutesToClose <= 45 ? 'power' : 'intraday') : clock.session === 'pre' ? 'premarket' : clock.trading && clock.session === 'post' ? 'close' : clock.weekday === 0 || clock.weekday === 6 ? 'weekly' : 'premarket';
    const cycle = { id: `${clock.iso}-${String(clock.hour).padStart(2, '0')}${String(clock.minute).padStart(2, '0')}-${shortId().slice(0, 4)}`, kind, at: Date.now(), messages: [], decisions: [], tickets: [], status: 'running' };
    const say = (agent, title, text, data) => {
      const m = { agent, at: Date.now(), title, text, data: data ? slim(data, { maxArray: 12, maxString: 800 }) : undefined };
      cycle.messages.push(m);
      onStep(agent, m);
    };
    const abort = () => {
      if (signal?.aborted) throw Object.assign(new Error('Cycle stopped.'), { code: 'cancelled' });
    };
    try {
      // 1. Gather
      onStep('system', { title: 'Gathering data' });
      const settings = await getSettings();
      let state = await getState();
      const snap = await snapshot({ force: true });
      const params0 = resolveParams(settings.mode, state.paramOverrides, settings.limits);
      // Auto-downgrade on drawdown
      let modeId = settings.mode;
      const dd = settings.limits.autoDowngradeOnDrawdownPct;
      if (dd > 0 && state.peakEquity > 0 && snap.portfolio.equity < state.peakEquity * (1 - dd / 100) && params0.mode.level > 1) {
        modeId = modeByLevel(params0.mode.level - 1).id;
        await saveSettings({ mode: modeId });
        say('system', 'Mode lowered', `Account is more than ${dd}% below its peak, so the desk dropped from ${params0.mode.name} to ${modeById(modeId).name} as your settings ask.`);
      }
      const params = resolveParams(modeId, state.paramOverrides, settings.limits);
      const modeText = modeRules(params);
      const plan = await getPlan();
      const intents = (await listIntents({ limit: 80 })).filter((i) => ACTIVE_INTENT.has(i.status));
      const held = uniq([...snap.stocks.map((s) => s.symbol), ...snap.options.map((o) => o.symbol)]);
      const focus = (plan.week?.focus || []).map((f) => f.symbol).filter(Boolean);
      const universe = uniq([...INDEX_ETFS, ...held, ...focus, ...intents.map((i) => i.symbol), ...settings.watchlist]).slice(0, 30);
      const intradayWanted = clock.session === 'regular' ? uniq(['SPY', 'QQQ', ...held, ...focus]).slice(0, 8) : [];
      const [analyses, fear, quotesArr, earnings] = await Promise.all([
        analyzeSymbols(universe, { intraday: intradayWanted, maxAgeMs: kind === 'weekly' ? 60 * 60 * 1000 : 5 * 60 * 1000 }),
        market.quotes([FEAR_GAUGE]).then((q) => q[0]).catch(() => null),
        market.quotes(universe).catch(() => []),
        earningsList(),
      ]);
      abort();
      const quotes = Object.fromEntries(quotesArr.map((q) => [q.symbol, q]));
      for (const [s, a] of Object.entries(analyses)) if (!quotes[s] && a.price) quotes[s] = { symbol: s, price: a.price };
      const regime = marketRegime(analyses, { fear });
      cycle.regime = { label: regime.label, score: regime.score, tone: regime.tone, volatility: regime.volatility, breadth: regime.breadth, posture: regime.posture };
      cycle.mode = params.mode.id;
      cycle.live = !!snap.live;
      cycle.execution = settings.broker === 'live' ? settings.execution : 'paper';
      cycle.account = { equity: snap.portfolio.equity, buyingPower: snap.portfolio.buyingPower, dayChange: snap.portfolio.dayChange };
      const ranked = Object.values(analyses)
        .filter((a) => !a.insufficient)
        .sort((a, b) => Math.abs(b.score) + (held.includes(b.symbol) ? 40 : 0) + (focus.includes(b.symbol) ? 25 : 0) - (Math.abs(a.score) + (held.includes(a.symbol) ? 40 : 0) + (focus.includes(a.symbol) ? 25 : 0)));
      say('system', 'Data gathered', `${universe.length} symbols analyzed. Market regime: ${regime.label} (${regime.score > 0 ? '+' : ''}${regime.score}), volatility ${regime.volatility}. Account ${money(snap.portfolio.equity)} with ${money(snap.portfolio.buyingPower)} buying power. Mode: ${params.mode.name}.`);

      // Deterministic exits first (they run whatever the agents say)
      const exitPlans = await getExits();
      const sameExit = (i, e) => i.source === 'exit' && i.symbol === e.ticket.symbol && (i.ticket?.legs?.[0]?.contractId || null) === (e.ticket.legs?.[0]?.contractId || null);
      const exits = exitSignals({ positions: snap, plans: exitPlans, quotes, params, todayIso: clock.iso, clock }).filter((e) => !intents.some((i) => sameExit(i, e)));
      if (exits.length) say('system', 'Exit rules triggered', exits.map((e) => `${e.ticket.symbol}: ${e.reason}`).join('\n'));

      // 2. Researchers in parallel
      const universeBrief = ranked.slice(0, 18).map(brief);
      const intradayBrief = Object.fromEntries(intradayWanted.map((s) => [s, analyses[s]?.intraday]).filter(([, v]) => v));
      const optionsAllowed = params.strategies.some((s) => s !== 'stock');
      const candSyms = uniq([...held, ...focus, ...ranked.filter((a) => !['DIA', 'IWM'].includes(a.symbol)).slice(0, 7).map((a) => a.symbol)]).slice(0, 8);
      onStep('scout', { title: 'Reading the charts' });
      onStep('analyst', { title: 'Pricing options & catalysts' });
      const [funds, ratings] = await Promise.all([market.fundamentals(candSyms).catch(() => ({})), market.ratings(candSyms).catch(() => ({}))]);
      const optSnaps = {};
      if (optionsAllowed) {
        await pool(candSyms, 3, async (s) => {
          const spot = quotes[s]?.price || analyses[s]?.price;
          const cs = await contractsFor(s, { minDte: Math.max(params.minDte, 1), maxDte: Math.max(params.maxDte, 14), preferDte: Math.round((params.minDte + params.maxDte) / 2) || 30, spot }).catch(() => []);
          optSnaps[s] = snapshotOptions(cs, spot);
        });
      }
      abort();
      const earnSoon = earnings.filter((e) => daysBetween(clock.iso, e.date) >= 0 && daysBetween(clock.iso, e.date) <= 7);
      const candidates = candSyms.map((s) => ({
        ...brief(analyses[s]),
        realizedVolPct: analyses[s]?.indicators?.realizedVol,
        options: optSnaps[s] || (optionsAllowed ? 'unavailable' : 'not allowed in this mode'),
        fundamentals: funds[s] ? { marketCapB: funds[s].marketCapB, pe: funds[s].pe, sector: funds[s].sector, high52: funds[s].high52, low52: funds[s].low52 } : undefined,
        analysts: ratings[s] || undefined,
        earnings: earnSoon.find((e) => e.symbol === s)?.date,
        held: held.includes(s) || undefined,
      }));
      const account = { equity: snap.portfolio.equity, buyingPower: snap.portfolio.buyingPower, cash: snap.portfolio.cash, live: !!snap.live, optionLevel: snap.account.optionLevel, approvalsRequired: !!snap.account.approvalsRequired };
      const [scoutRes, analystRes] = await Promise.allSettled([
        ai.json(scoutPrompt({ kind, clock, regime, universe: universeBrief, intraday: Object.keys(intradayBrief).length ? intradayBrief : null, plan: { today: plan.today?.briefing ? plan.today : undefined, focus: plan.week?.focus }, mode: params.mode }), { tier: AGENTS.scout.tier, effort: AGENTS.scout.effort, signal, agent: 'scout' }),
        ai.json(analystPrompt({ kind, clock, candidates, earnings: earnSoon.filter((e) => universe.includes(e.symbol) || e.big).slice(0, 25), mode: params.mode, modeText, account }), { tier: AGENTS.analyst.tier, effort: AGENTS.analyst.effort, signal, agent: 'analyst' }),
      ]);
      abort();
      // The background autopilot answers agent prompts out of process and resumes the cycle.
      const paused = [scoutRes, analystRes].find((r) => r.status === 'rejected' && r.reason?.code === 'need_agent');
      if (paused) throw paused.reason;
      const scout = scoutRes.status === 'fulfilled' ? scoutRes.value : null;
      const analyst = analystRes.status === 'fulfilled' ? analystRes.value : null;
      if (scout) say('scout', 'Chart read', [scout.marketRead, ...(scout.setups || []).slice(0, 6).map((s) => `• ${s.symbol} ${s.bias} — ${s.setup} (${s.confidence}%): entry ${s.entry ?? '—'}, stop ${s.stop ?? '—'}, target ${s.target ?? '—'}. ${s.why || ''}`)].filter(Boolean).join('\n'), scout);
      else say('scout', 'Unavailable', `Scout could not report this cycle (${scoutRes.reason?.message || scoutRes.reason?.code || 'error'}).`);
      if (analyst) say('analyst', 'Options & catalysts', [analyst.summary, ...(analyst.ideas || []).slice(0, 6).map((i) => `• ${i.symbol} ${i.direction} via ${STRATEGIES[i.vehicle]?.name || i.vehicle} (${i.confidence}%) — IV ${i.ivView || '?'}; ${i.catalyst || 'no catalyst'}. ${i.why || ''}`)].filter(Boolean).join('\n'), analyst);
      else say('analyst', 'Unavailable', `Analyst could not report this cycle (${analystRes.reason?.message || analystRes.reason?.code || 'error'}).`);
      cycle.scout = slim(scout, { maxArray: 8, maxString: 600 });
      cycle.analyst = slim(analyst, { maxArray: 8, maxString: 600 });

      // 3. Head Honcho decides
      onStep('honcho', { title: 'Deciding' });
      const exitPlansNow = await getExits();
      const posView = [
        ...snap.stocks.map((s) => ({ symbol: s.symbol, kind: 'stock', qty: s.qty, avgCost: s.avgCost, price: s.price, pl: s.pl, plPct: s.plPct, exit: exitPlansNow[s.symbol] })),
        ...snap.options.map((o) => ({ contractId: o.id, symbol: o.symbol, kind: 'option', label: contractLabel(o), qty: o.qty, avgPrice: o.avgPrice, mark: o.mark, pl: o.pl, plPct: o.plPct, dte: o.expiration ? daysBetween(clock.iso, o.expiration) : undefined, exit: exitPlansNow[o.id] })),
      ];
      const recentCycles = (await store.list(P.cycles, { orderBy: 'at', dir: 'desc', limit: 6 }).catch(() => [])).map((c) => ({ at: new Date(c.at).toISOString().slice(0, 16), kind: c.kind, headline: c.headline }));
      const wk = weekEvents(clock.iso, { earnings: earnings.map((e) => ({ ...e, big: e.big })), focusSymbols: [...held, ...focus, ...settings.watchlist] }).map((d) => ({ day: d.day, date: d.iso, events: d.events.map((e) => e.text) }));
      let honcho;
      try {
        honcho = await ai.json(
          honchoPrompt({
            kind,
            clock,
            mode: params.mode,
            modeText,
            adjustable: adjustableSpec(params.mode.id),
            account: { ...account, dayChange: snap.portfolio.dayChange, startOfDay: state.day?.startEquity, peak: state.peakEquity },
            positions: posView,
            openOrders: (snap.openOrders || []).map((o) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, qty: o.qty, price: o.price, state: o.state })),
            approvals: snap.approvals || [],
            regime: { label: regime.label, score: regime.score, volatility: regime.volatility, breadth: regime.breadth, notes: regime.notes, posture: regime.posture },
            scout: cycle.scout,
            analyst: cycle.analyst,
            plan: { week: plan.week?.thesis ? { thesis: plan.week.thesis, focus: plan.week.focus, scenarios: plan.week.scenarios } : null, today: plan.today?.briefing ? plan.today : null },
            intents: intents.map((i) => ({ id: i.id, status: i.status, symbol: i.symbol, action: i.action, vehicle: i.vehicle, trigger: i.trigger, headline: i.headline })),
            memory: (state.memory || []).slice(-12),
            directives: (state.directives || []).slice(-12).map((d) => d.text),
            recentCycles,
            weekEvents: wk,
            exitSignals: exits.map((e) => ({ symbol: e.ticket.symbol, reason: e.reason })),
          }),
          { tier: AGENTS.honcho.tier, effort: AGENTS.honcho.effort, signal, agent: 'honcho' },
        );
      } catch (err) {
        if (err?.code === 'cancelled' || err?.code === 'need_agent') throw err;
        throw Object.assign(new Error(`Head Honcho could not decide: ${err?.message || err?.code || 'error'}`), { code: err?.code });
      }
      abort();
      cycle.headline = String(honcho.headline || '').slice(0, 140);
      cycle.summary = String(honcho.summary || '');
      cycle.marketView = honcho.marketView;
      cycle.messageToOwner = honcho.messageToOwner || '';
      const decisions = (Array.isArray(honcho.decisions) ? honcho.decisions : []).slice(0, 12).map((d, i) => ({ ...d, id: d.id || `d${i + 1}`, symbol: String(d.symbol || '').toUpperCase() }));
      cycle.decisions = decisions;
      say('honcho', cycle.headline || 'Decisions', [cycle.summary, ...decisions.map((d) => `• ${d.action.toUpperCase()} ${d.symbol}${d.vehicle && d.action === 'open' ? ` (${STRATEGIES[d.vehicle]?.name || d.vehicle})` : ''}${d.conviction ? ` — conviction ${d.conviction}/5` : ''}${d.sizePct ? `, ${d.sizePct}% size` : ''}${d.when === 'on_trigger' ? `, when: ${d.trigger}` : ''}. ${d.why || ''}`)].join('\n'));

      // Plans, memory, parameter tuning
      const planPatch = {};
      if (honcho.today && typeof honcho.today === 'object') planPatch.today = { ...emptyDayPlan(clock.trading && clock.session !== 'post' ? clock.iso : addDays(clock.iso, 1)), ...slim(honcho.today, { maxArray: 20, maxString: 800 }), createdAt: Date.now(), cycleId: cycle.id };
      if (honcho.week && typeof honcho.week === 'object') {
        const days = weekDays(clock.iso);
        planPatch.week = { ...emptyWeekPlan(clock.iso), ...slim(honcho.week, { maxArray: 15, maxString: 900 }), weekOf: days[0], createdAt: Date.now(), cycleId: cycle.id };
      }
      if (Object.keys(planPatch).length) {
        await store.set(P.plan, { ...plan, ...planPatch, updatedAt: Date.now() });
        say('honcho', 'Plan updated', [planPatch.week ? `Week: ${planPatch.week.thesis}` : '', planPatch.today ? `Today: ${planPatch.today.briefing}` : ''].filter(Boolean).join('\n'));
      }
      const statePatch = {};
      if (honcho.paramAdjustments && typeof honcho.paramAdjustments === 'object') {
        const merged = { ...(state.paramOverrides || {}), ...honcho.paramAdjustments };
        const check = resolveParams(params.mode.id, merged, settings.limits);
        statePatch.paramOverrides = Object.fromEntries(Object.entries(check.adjusted).map(([k, v]) => [k, v.to]));
        const changes = Object.entries(check.adjusted).map(([k, v]) => `${k}: ${v.from} → ${v.to}`);
        if (changes.length) say('honcho', 'Tuned mode settings', changes.join(', '));
      }
      if (Array.isArray(honcho.memory) && honcho.memory.length) statePatch.memory = [...(state.memory || []), ...honcho.memory.slice(0, 5).map((m) => ({ at: Date.now(), text: String(m).slice(0, 300) }))].slice(-30).map((m) => (typeof m === 'string' ? { at: Date.now(), text: m } : m));
      statePatch.lastCycle = { id: cycle.id, kind, at: cycle.at, headline: cycle.headline };
      state = await patchState(statePatch);
      const live = settings.broker === 'live';
      const finalParams = resolveParams(params.mode.id, state.paramOverrides, settings.limits);

      // 4. Draft tickets in code, then 5. the Operator reviews them
      const drafts = [];
      const nonTrade = [];
      for (const d of decisions) {
        if (['open', 'close', 'trim'].includes(d.action) && d.when !== 'on_trigger') {
          const dr = await draftTicket(d, { params: finalParams, snap, quotes, analyses }).catch((e) => ({ ticket: null, candidates: [], notes: [e.message] }));
          drafts.push({ decision: d, ...dr });
        } else nonTrade.push(d);
      }
      let operator = null;
      if (drafts.length || posView.length) {
        onStep('operator', { title: 'Building orders' });
        try {
          operator = await ai.json(
            operatorPrompt({
              clock,
              mode: finalParams.mode,
              modeText: modeRules(finalParams),
              account,
              drafts: drafts.map((d) => ({ decisionId: d.decision.id, decision: { action: d.decision.action, symbol: d.decision.symbol, vehicle: d.decision.vehicle, direction: d.decision.direction, sizePct: d.decision.sizePct, conviction: d.decision.conviction, exit: d.decision.exit, why: d.decision.why }, draft: d.ticket ? slim(d.ticket, { maxArray: 4 }) : null, candidates: d.candidates, notes: d.notes })),
              positions: posView,
              plans: exitPlansNow,
              quotes: Object.fromEntries(uniq(drafts.map((d) => d.decision.symbol)).map((s) => [s, quotes[s] && { price: quotes[s].price, bid: quotes[s].bid, ask: quotes[s].ask }])),
              execution: live ? (settings.execution === 'auto' ? 'LIVE, orders that pass the risk gate are sent automatically' : 'LIVE, the owner presses Send on each order') : 'PAPER (simulated)',
            }),
            { tier: AGENTS.operator.tier, effort: AGENTS.operator.effort, signal, agent: 'operator' },
          );
        } catch (err) {
          if (err?.code === 'cancelled' || err?.code === 'need_agent') throw err;
          say('operator', 'Unavailable', `Operator could not review this cycle (${err?.message || err?.code}); using the code-drafted tickets as-is.`);
        }
      }
      abort();
      if (operator) {
        cycle.operator = slim(operator, { maxArray: 12, maxString: 500 });
        say('operator', 'Orders built', [operator.log, ...(operator.tickets || []).map((t) => `• ${t.decisionId}: ${t.verdict}${t.vetoReason ? ` — ${t.vetoReason}` : ''}${t.note ? ` — ${t.note}` : ''}`)].filter(Boolean).join('\n'));
        // Position reviews can move stops/targets
        for (const r of operator.positionReview || []) {
          if (!r.key || (!r.newStop && !r.newTarget)) continue;
          const patch = {};
          if (Number(r.newStop) > 0) patch.stop = Number(r.newStop);
          if (Number(r.newTarget) > 0) patch.target = Number(r.newTarget);
          await setExitPlan(r.key, { ...exitPlansNow[r.key], ...patch, note: r.note });
        }
      }

      // 6. Gate + 7. execute
      const sendMode = live ? (settings.execution === 'auto' ? 'auto' : 'queue') : 'auto';
      const results = [];
      const allTickets = [
        ...exits.map((e) => ({ kind: 'exit', reason: e.reason, ticket: e.ticket, decision: { id: `exit-${e.ticket.symbol}`, action: 'close', symbol: e.ticket.symbol, why: `Exit rule: ${e.reason}`, conviction: 5 } })),
        ...drafts.map((d) => {
          const op = (operator?.tickets || []).find((t) => t.decisionId === d.decision.id);
          if (op?.verdict === 'veto') return { kind: 'veto', decision: d.decision, reason: op.vetoReason || 'Operator vetoed', draft: d };
          const ticket = d.ticket ? applyOperator(d, op) : null;
          return { kind: 'trade', decision: d.decision, ticket, draft: d, op };
        }),
      ];
      for (const item of allTickets) {
        const d = item.decision;
        const intent = {
          id: uuid(),
          createdAt: Date.now(),
          cycleId: cycle.id,
          decisionId: d.id,
          source: item.kind === 'exit' ? 'exit' : 'cycle',
          action: d.action,
          symbol: d.symbol,
          vehicle: d.vehicle || (item.ticket?.kind === 'option' ? item.ticket.strategy : 'stock'),
          direction: d.direction,
          conviction: d.conviction,
          sizePct: d.sizePct,
          why: d.why,
          teach: d.teach,
          research: {
            scout: (scout?.setups || []).find((s) => s.symbol === d.symbol) || null,
            analyst: (analyst?.ideas || []).find((s) => s.symbol === d.symbol) || null,
            technical: analyses[d.symbol] ? analyses[d.symbol].summary : null,
          },
          operatorNote: item.op?.note || item.ticket?.meta?.operatorNote || null,
          draftNotes: item.draft?.notes || [],
          candidates: (item.draft?.candidates || []).slice(0, 4),
          live,
          mode: finalParams.mode.id,
        };
        if (item.kind === 'veto') {
          Object.assign(intent, { status: 'vetoed', headline: headlineFor(item.draft?.ticket, d), vetoReason: item.reason });
          await saveIntent(intent);
          say('operator', `Vetoed ${d.symbol}`, item.reason);
          continue;
        }
        if (!item.ticket) {
          Object.assign(intent, { status: 'skipped', headline: headlineFor(null, d), vetoReason: (item.draft?.notes || []).join(' ') || 'No ticket could be built.' });
          await saveIntent(intent);
          say('system', `Skipped ${d.symbol}`, intent.vetoReason);
          continue;
        }
        item.ticket.meta = { ...item.ticket.meta, intentId: intent.id, cycleId: cycle.id, agent: true };
        item.ticket.id = intent.id; // doubles as the broker's idempotency key (ref_id)
        const r = await processTicket(item.ticket, { settings, state, snap, params: finalParams, quotes, sendMode: item.kind === 'exit' && live && settings.execution !== 'auto' ? 'queue' : sendMode });
        Object.assign(intent, { ticket: r.gate.ticket, gate: { decision: r.gate.decision, summary: r.gate.summary, checks: r.gate.checks, cost: r.gate.cost }, status: r.status, broker: r.broker, headline: headlineFor(r.gate.ticket, d), exit: r.gate.ticket.exit || d.exit || null });
        await saveIntent(intent);
        if (r.status === 'filled' || r.status === 'sent' || r.status === 'pending_approval') await rememberExit(intent);
        results.push({ intentId: intent.id, symbol: d.symbol, status: r.status, gate: r.gate.decision, summary: r.gate.summary, broker: r.broker });
        say('gate', `${r.gate.decision === 'block' ? 'Blocked' : r.gate.decision === 'resize' ? 'Resized' : 'Approved'}: ${intent.headline}`, `${r.gate.summary}${r.status !== 'blocked' ? `\nStatus: ${statusText(r.status)}${r.broker?.message ? ` — ${r.broker.message}` : ''}` : ''}`);
      }
      // Watches and triggers become intents too
      for (const d of nonTrade) {
        if (d.action === 'cancel_order' && d.orderId) {
          const broker = await brokerFor(settings);
          const ord = (snap.openOrders || []).find((o) => o.id === d.orderId);
          if (ord && (sendMode === 'auto')) {
            const r = await broker.cancel(ord, { accountNumber: settings.accountNumber }).catch((e) => ({ ok: false, reason: e.message }));
            say('operator', `Cancel ${d.symbol}`, r.ok ? 'Order cancelled.' : `Could not cancel: ${r.reason || 'unknown'}`);
          } else if (ord) say('operator', `Cancel ${d.symbol}`, 'Waiting for you: press Cancel on the order in the Desk tab.');
          continue;
        }
        if (d.action === 'adjust_exit') {
          const key = d.contractId || d.symbol;
          await setExitPlan(key, { ...exitPlansNow[key], ...(d.exit || {}) });
          say('operator', `New exit plan for ${d.symbol}`, `Stop ${d.exit?.stop ?? '—'}, target ${d.exit?.target ?? '—'}${d.exit?.timeStop ? `, time stop ${d.exit.timeStop}` : ''}.`);
          continue;
        }
        if (d.action === 'hold') continue;
        await saveIntent({
          id: uuid(),
          createdAt: Date.now(),
          cycleId: cycle.id,
          decisionId: d.id,
          source: 'cycle',
          action: d.action === 'open' ? 'open' : d.action,
          symbol: d.symbol,
          vehicle: d.vehicle,
          direction: d.direction,
          conviction: d.conviction,
          sizePct: d.sizePct,
          trigger: d.trigger,
          why: d.why,
          teach: d.teach,
          exit: d.exit,
          research: { scout: (scout?.setups || []).find((s) => s.symbol === d.symbol) || null, analyst: (analyst?.ideas || []).find((s) => s.symbol === d.symbol) || null, technical: analyses[d.symbol]?.summary || null },
          status: d.when === 'on_trigger' ? 'planned' : 'watching',
          headline: `${d.when === 'on_trigger' ? 'Planned' : 'Watching'}: ${d.direction || ''} ${d.symbol}${d.vehicle ? ` via ${STRATEGIES[d.vehicle]?.name || d.vehicle}` : ''}`.replace(/\s+/g, ' '),
          live,
          mode: finalParams.mode.id,
        });
      }
      // Older planned/watching intents that this cycle did not renew go stale after a day
      for (const i of intents) if (['planned', 'watching'].includes(i.status) && Date.now() - i.createdAt > 26 * 3600 * 1000) await saveIntent({ ...i, status: 'expired' });
      cycle.results = results;
      cycle.status = 'done';
      cycle.finishedAt = Date.now();
      say('system', 'Cycle complete', results.length ? results.map((r) => `${r.symbol}: ${statusText(r.status)}`).join(' · ') : 'No orders this cycle.');
      return cycle;
    } catch (err) {
      if (err?.code === 'need_agent') {
        cycle.status = 'paused';
        cycle.needAgent = err.agent;
        return cycle;
      }
      cycle.status = err?.code === 'cancelled' ? 'cancelled' : 'error';
      cycle.error = err?.message || String(err);
      cycle.finishedAt = Date.now();
      say('system', cycle.status === 'cancelled' ? 'Stopped' : 'Cycle failed', cycle.error);
      return cycle;
    } finally {
      if (cycle.status !== 'paused') {
        if (source) cycle.source = source;
        await store.set(`${P.cycles}/${cycle.id}`, slim(cycle, { maxArray: 40, maxString: 2000 })).catch((e) => log('save cycle failed', e));
        if (prune) pruneCycles().catch(() => {});
      }
    }
  }

  async function pruneCycles() {
    const all = await store.list(P.cycles, { orderBy: 'at', dir: 'desc', limit: 1000 });
    for (const c of all.slice(400)) await store.remove(`${P.cycles}/${c.id}`);
    const intents = await store.list(P.intents, { orderBy: 'createdAt', dir: 'desc', limit: 1000 });
    for (const i of intents.slice(600)) await store.remove(`${P.intents}/${i.id}`);
  }

  async function rememberExit(intent) {
    const t = intent.ticket;
    if (!t || t.positionEffect !== 'open' || !t.exit) return;
    const key = t.kind === 'stock' ? t.symbol : t.legs?.[0]?.contractId;
    if (key) await setExitPlan(key, { stop: t.exit.stop, target: t.exit.target, timeStop: t.exit.timeStop, basis: t.exit.basis || (t.kind === 'stock' ? 'stock_price' : 'option_premium'), intentId: intent.id });
  }

  // ------------------------------------------------------------ owner actions on intents
  async function sendIntent(intentId, { force = true } = {}) {
    const intent = await store.get(`${P.intents}/${intentId}`);
    if (!intent?.ticket) throw new Error('This intention has no order ticket.');
    const settings = await getSettings();
    const state = await getState();
    const snap = await snapshot({ force: true });
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    const symbols = [intent.ticket.symbol];
    const quotes = Object.fromEntries((await market.quotes(symbols).catch(() => [])).map((q) => [q.symbol, q]));
    const ticket = await refreshTicketQuotes(intent.ticket, quotes);
    const r = await processTicket(ticket, { settings, state, snap, params, quotes, sendMode: force ? 'force' : 'auto' });
    Object.assign(intent, { ticket: r.gate.ticket, gate: { decision: r.gate.decision, summary: r.gate.summary, checks: r.gate.checks, cost: r.gate.cost }, status: r.status, broker: r.broker, sentBy: 'owner' });
    await saveIntent(intent);
    if (['filled', 'sent', 'pending_approval'].includes(r.status)) await rememberExit(intent);
    return intent;
  }

  /** Re-price option legs with fresh quotes before the owner sends an older ticket. */
  async function refreshTicketQuotes(ticket, quotes) {
    if (ticket.kind !== 'option') return ticket;
    const fresh = await market.optionQuotes(ticket.legs.map((l) => ({ id: l.contractId, symbol: ticket.symbol, ...l }))).catch(() => ({}));
    const legs = ticket.legs.map((l) => ({ ...l, ...(fresh[l.contractId] ? { bid: fresh[l.contractId].bid, ask: fresh[l.contractId].ask, mid: fresh[l.contractId].mark } : {}) }));
    return normalizeTicket({ ...ticket, legs });
  }

  async function dismissIntent(intentId, status = 'cancelled') {
    const intent = await store.get(`${P.intents}/${intentId}`);
    if (!intent) return null;
    if (intent.broker?.orderId && ['sent', 'working'].includes(intent.status)) {
      const settings = await getSettings();
      const broker = await brokerFor(settings);
      await broker.cancel({ id: intent.broker.orderId, kind: intent.ticket?.kind }, { accountNumber: settings.accountNumber }).catch(() => {});
    }
    return saveIntent({ ...intent, status });
  }

  async function cancelOrder(order) {
    const settings = await getSettings();
    const broker = await brokerFor(settings);
    const r = await broker.cancel(order, { accountNumber: settings.accountNumber });
    cache.snapshotAt = 0;
    return r;
  }

  /** Close (or trim) one position now, at the owner's request. Still passes the risk gate. */
  async function closePosition({ symbol, contractId, fraction = 1 }) {
    const settings = await getSettings();
    const state = await getState();
    const snap = await snapshot({ force: true });
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    const quotes = Object.fromEntries((await market.quotes([symbol]).catch(() => [])).map((q) => [q.symbol, q]));
    const decision = { id: 'owner', action: fraction < 1 ? 'trim' : 'close', symbol, contractId, vehicle: contractId ? 'option' : 'stock', why: 'Closed by the owner from the Desk tab.', conviction: 5 };
    const dr = await draftTicket(decision, { params, snap, quotes, analyses: {} });
    if (!dr.ticket) throw new Error(dr.notes.join(' ') || 'Nothing to close.');
    const intent = { id: uuid(), createdAt: Date.now(), source: 'owner', action: decision.action, symbol, why: decision.why, live: settings.broker === 'live', mode: params.mode.id };
    dr.ticket.id = intent.id;
    dr.ticket.meta = { ...dr.ticket.meta, intentId: intent.id, agent: false };
    const r = await processTicket(dr.ticket, { settings, state, snap, params, quotes, sendMode: 'force' });
    Object.assign(intent, { ticket: r.gate.ticket, gate: { decision: r.gate.decision, summary: r.gate.summary, checks: r.gate.checks, cost: r.gate.cost }, status: r.status, broker: r.broker, headline: headlineFor(r.gate.ticket, decision) });
    await saveIntent(intent);
    if (['filled', 'sent'].includes(r.status)) await setExitPlan(contractId || symbol, null);
    return intent;
  }

  /** Match sent intents to broker orders and update their status. */
  async function reconcile(snap) {
    const intents = (await listIntents({ limit: 80 })).filter((i) => ['sent', 'pending_approval', 'working', 'sending'].includes(i.status));
    if (!intents.length) return [];
    const changed = [];
    for (const i of intents) {
      const ord = (snap.orders || []).find((o) => (i.broker?.orderId && o.id === i.broker.orderId) || (o.refId && o.refId === i.id));
      let status = i.status;
      if (ord) {
        if (ord.state === 'filled') status = 'filled';
        else if (['cancelled', 'canceled'].includes(ord.state)) status = 'cancelled';
        else if (['rejected', 'failed', 'voided'].includes(ord.state)) status = 'rejected';
        else if (ord.state === 'partially_filled') status = 'working';
      } else if (i.status === 'pending_approval' && Date.now() - i.updatedAt > 24 * 3600 * 1000) status = 'expired';
      else if (i.status === 'sending' && Date.now() - i.updatedAt > 30 * 60 * 1000) status = 'failed'; // the autopilot never confirmed it
      if (status !== i.status) {
        const next = await saveIntent({ ...i, status, fill: ord ? { avgPrice: ord.avgPrice, qty: ord.filledQty, at: ord.updatedAt } : i.fill });
        changed.push(next);
      }
    }
    return changed;
  }

  /** Deterministic exit monitor (no AI). Returns the exits found and what happened to them. */
  async function checkExits({ execute = false, snap: given } = {}) {
    const settings = await getSettings();
    const state = await getState();
    const snap = given || (await snapshot({ force: true }));
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    const plans = await getExits();
    const syms = snap.stocks.map((s) => s.symbol);
    const quotes = Object.fromEntries((await market.quotes(syms).catch(() => [])).map((q) => [q.symbol, q]));
    const exits = exitSignals({ positions: snap, plans, quotes, params, todayIso: todayNY(now()), clock: marketStatus(now()) });
    const existing = (await listIntents({ limit: 60 })).filter((i) => i.source === 'exit' && ACTIVE_INTENT.has(i.status));
    const out = [];
    for (const e of exits) {
      if (existing.some((i) => i.symbol === e.ticket.symbol && i.ticket?.legs?.[0]?.contractId === e.ticket.legs?.[0]?.contractId)) continue;
      const intent = { id: uuid(), createdAt: Date.now(), source: 'exit', action: 'close', symbol: e.ticket.symbol, why: `Exit rule: ${e.reason}`, live: settings.broker === 'live', mode: params.mode.id };
      e.ticket.id = intent.id;
      e.ticket.meta = { ...e.ticket.meta, intentId: intent.id, agent: true };
      const live = settings.broker === 'live';
      const sendMode = !live ? 'auto' : execute && settings.execution === 'auto' ? 'auto' : 'queue';
      const r = await processTicket(e.ticket, { settings, state, snap, params, quotes, sendMode });
      Object.assign(intent, { ticket: r.gate.ticket, gate: { decision: r.gate.decision, summary: r.gate.summary, checks: r.gate.checks, cost: r.gate.cost }, status: r.status, broker: r.broker, headline: headlineFor(r.gate.ticket, intent) });
      await saveIntent(intent);
      out.push(intent);
    }
    return out;
  }

  // ------------------------------------------------------------ chat with the Head Honcho
  async function chatContext() {
    const settings = await getSettings();
    const state = await getState();
    const snap = await snapshot().catch(() => null);
    const plan = await getPlan();
    const last = (await store.list(P.cycles, { orderBy: 'at', dir: 'desc', limit: 2 }).catch(() => []))[0];
    const intents = (await listIntents({ limit: 30 })).filter((i) => ACTIVE_INTENT.has(i.status)).slice(0, 10);
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    return {
      settings,
      params,
      context: {
        time: `${marketStatus(now()).iso} ${marketStatus(now()).hour}:${String(marketStatus(now()).minute).padStart(2, '0')} NY (${marketStatus(now()).label})`,
        account: snap ? { value: snap.portfolio.equity, buyingPower: snap.portfolio.buyingPower, dayChange: snap.portfolio.dayChange, live: !!snap.live, account: snap.account?.masked } : 'unavailable',
        positions: snap ? [...snap.stocks.map((s) => `${s.symbol} ${s.qty} sh @ ${s.avgCost} → ${s.price} (${s.plPct}%)`), ...snap.options.map((o) => `${contractLabel(o)} ×${o.qty} @ ${o.avgPrice} → ${o.mark} (${o.plPct}%)`)] : [],
        lastCycle: last ? { at: new Date(last.at).toISOString().slice(0, 16), headline: last.headline, summary: last.summary, regime: last.regime?.label } : null,
        plan: { week: plan.week?.thesis, today: plan.today?.briefing, focus: (plan.week?.focus || []).map((f) => `${f.symbol} ${f.bias}`) },
        intentions: intents.map((i) => `${i.status}: ${i.headline}`),
        killSwitch: state.killSwitch,
        standingInstructions: (state.directives || []).slice(-8).map((d) => d.text),
      },
    };
  }

  function chatTools(params) {
    return [
      {
        name: 'get_quotes',
        description: 'Live quotes for up to 10 stock symbols. Returns price, change %, bid and ask.',
        inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } }, required: ['symbols'] },
        execute: async ({ symbols }) => (await market.quotes((symbols || []).slice(0, 10).map((s) => String(s).toUpperCase()))).map((q) => ({ symbol: q.symbol, price: q.price, changePct: q.changePct, bid: q.bid, ask: q.ask })),
      },
      {
        name: 'analyze_symbol',
        description: 'Technical analysis of one stock from a year of daily bars: trend, RSI, support/resistance, detected chart and candlestick patterns, a technical score and a 1-week projected range.',
        inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
        execute: async ({ symbol }) => {
          const s = String(symbol).toUpperCase();
          const a = (await analyzeSymbols([s]))[s];
          return { ...brief(a), summary: a.summary };
        },
      },
      {
        name: 'find_option_contracts',
        description: 'Ranked option contracts for a symbol that fit the active risk mode. Returns contract ids, strikes, expirations, bid/ask, delta and cost per contract.',
        inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, right: { type: 'string', enum: ['call', 'put'] }, min_dte: { type: 'number' }, max_dte: { type: 'number' }, target_delta: { type: 'number' } }, required: ['symbol', 'right'] },
        execute: async ({ symbol, right, min_dte, max_dte, target_delta }) => {
          const s = String(symbol).toUpperCase();
          const q = (await market.quotes([s]))[0];
          const minD = Number(min_dte ?? params.minDte);
          const maxD = Number(max_dte ?? params.maxDte) || 45;
          const cs = await contractsFor(s, { minDte: minD, maxDte: maxD, preferDte: Math.round((minD + maxD) / 2), spot: q?.price });
          return rankContracts(cs, { right: right === 'put' ? 'put' : 'call', minDte: minD, maxDte: maxD, targetDelta: Number(target_delta) || 0.5, maxSpreadPct: params.maxSpreadPct, minOpenInterest: params.minOpenInterest })
            .slice(0, 6)
            .map((c) => ({ contractId: c.id, label: contractLabel(c), dte: c.dte, bid: c.bid, ask: c.ask, mid: c.mid, delta: c.delta, ivPct: c.iv ? round(c.iv * 100, 1) : undefined, openInterest: c.openInterest, costPerContract: c.costPerContract }));
        },
      },
      {
        name: 'propose_trade',
        description: "Put a trade ticket in the owner's queue. It runs through the risk gate; the owner must press Send. For options pass the contract_id from find_option_contracts. Returns the gate's verdict.",
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string' },
            vehicle: { type: 'string', enum: ['stock', 'long_call', 'long_put'] },
            side: { type: 'string', enum: ['buy', 'sell'] },
            quantity: { type: 'number', description: 'shares or contracts' },
            dollars: { type: 'number', description: 'dollar amount for fractional stock buys' },
            contract_id: { type: 'string' },
            limit_price: { type: 'number' },
            stop: { type: 'number' },
            target: { type: 'number' },
            why: { type: 'string' },
          },
          required: ['symbol', 'vehicle', 'side', 'why'],
        },
        execute: async (inp) => {
          const intent = await proposeFromChat(inp);
          return { status: intent.status, headline: intent.headline, gate: intent.gate?.summary, checks: (intent.gate?.checks || []).filter((c) => c.level !== 'info').map((c) => `${c.label}: ${c.detail}`) };
        },
      },
      {
        name: 'remember_instruction',
        description: 'Save a standing instruction from the owner that every future cycle must follow (e.g. "no TSLA", "keep 50% cash this week").',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute: async ({ text }) => {
          const st = await getState();
          await patchState({ directives: [...(st.directives || []), { at: Date.now(), text: String(text).slice(0, 300) }].slice(-20) });
          return 'Saved. Every future cycle will see it.';
        },
      },
    ];
  }

  async function proposeFromChat(inp) {
    const settings = await getSettings();
    const state = await getState();
    const snap = await snapshot();
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    const sym = String(inp.symbol || '').toUpperCase();
    const quotes = Object.fromEntries((await market.quotes([sym]).catch(() => [])).map((q) => [q.symbol, q]));
    let ticket;
    if (inp.vehicle === 'stock' || !inp.vehicle) {
      ticket = normalizeTicket({ kind: 'stock', symbol: sym, side: inp.side, quantity: inp.quantity, dollars: inp.dollars, orderType: inp.dollars ? 'market' : 'limit', limitPrice: inp.limit_price, exit: { stop: inp.stop, target: inp.target }, why: inp.why, meta: { agent: true, source: 'chat' } });
    } else {
      const fresh = inp.contract_id ? await market.optionQuotes([{ id: inp.contract_id, symbol: sym }]).catch(() => ({})) : {};
      const c = fresh[inp.contract_id] || {};
      ticket = normalizeTicket({ kind: 'option', symbol: sym, strategy: inp.vehicle, quantity: inp.quantity || 1, price: inp.limit_price, exit: { stop: inp.stop, target: inp.target }, why: inp.why, meta: { agent: true, source: 'chat' }, legs: [{ contractId: inp.contract_id, right: c.right || (inp.vehicle === 'long_put' ? 'put' : 'call'), strike: c.strike, expiration: c.expiration, side: inp.side === 'sell' ? 'sell' : 'buy', positionEffect: inp.side === 'sell' ? 'close' : 'open', bid: c.bid, ask: c.ask, mid: c.mark, delta: c.delta, openInterest: c.openInterest, dte: c.expiration ? daysBetween(todayNY(now()), c.expiration) : undefined }] });
    }
    const intent = { id: uuid(), createdAt: Date.now(), source: 'chat', action: inp.side === 'sell' ? 'close' : 'open', symbol: sym, vehicle: inp.vehicle, why: inp.why, live: settings.broker === 'live', mode: params.mode.id };
    ticket.id = intent.id;
    const r = await processTicket(ticket, { settings, state, snap, params, quotes, sendMode: 'queue' });
    Object.assign(intent, { ticket: r.gate.ticket, gate: { decision: r.gate.decision, summary: r.gate.summary, checks: r.gate.checks, cost: r.gate.cost }, status: r.gate.decision === 'block' ? 'blocked' : 'proposed', headline: headlineFor(r.gate.ticket, intent), exit: r.gate.ticket.exit });
    await saveIntent(intent);
    return intent;
  }

  async function chatHistory(days = 3) {
    const out = [];
    const today = todayNY(now());
    for (let i = days - 1; i >= 0; i--) {
      const d = addDays(today, -i);
      const doc = await store.get(`${P.chat}/${d}`).catch(() => null);
      if (doc?.messages) out.push(...doc.messages);
    }
    return out;
  }

  async function appendChat(msgs) {
    const d = todayNY(now());
    const doc = (await store.get(`${P.chat}/${d}`).catch(() => null)) || { messages: [] };
    doc.messages = [...doc.messages, ...msgs].slice(-200);
    await store.set(`${P.chat}/${d}`, doc);
  }

  /**
   * Send the owner's message to the Head Honcho.
   * @returns {Promise<{text: string}>}
   */
  async function chat(text, { onText, signal, tutor = false } = {}) {
    const { settings, params, context } = await chatContext();
    const history = (await chatHistory()).filter((m) => (m.channel || 'desk') === (tutor ? 'tutor' : 'desk')).slice(-24);
    const rules = chatRules({ context, modeText: modeRules(params), live: settings.broker === 'live', tutor });
    const turns = [{ role: 'user', content: rules }, { role: 'assistant', content: tutor ? 'Ready to teach. What would you like to learn?' : 'Understood. I have the desk state and my tools.' }];
    for (const m of history) turns.push({ role: m.role === 'owner' ? 'user' : 'assistant', content: m.text });
    turns.push({ role: 'user', content: text });
    // Merge consecutive same-role turns
    const merged = [];
    for (const t of turns) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === t.role) prev.content += '\n\n' + t.content;
      else merged.push({ ...t });
    }
    const userMsg = { role: 'owner', text, at: Date.now(), channel: tutor ? 'tutor' : 'desk' };
    await appendChat([userMsg]);
    const res = await ai.text(merged, { tier: 'default', onText, signal, tools: tutor ? undefined : chatTools(params), agent: 'honcho', cache: false });
    await appendChat([{ role: 'honcho', text: res.text, at: Date.now(), channel: tutor ? 'tutor' : 'desk' }]);
    return res;
  }

  async function explain(item, { onText, signal } = {}) {
    const settings = await getSettings();
    const mode = modeById(settings.mode);
    const compactItem = slim({ headline: item.headline, status: item.status, why: item.why, teach: item.teach, ticket: item.ticket, gate: item.gate?.summary, checks: (item.gate?.checks || []).filter((c) => c.level !== 'info').map((c) => c.detail), research: item.research, exit: item.exit }, { maxArray: 8, maxString: 500 });
    return ai.text(explainPrompt({ item: compactItem, mode }), { tier: 'quick', onText, signal, agent: 'honcho' });
  }

  async function deepDive(symbol, { onText, signal } = {}) {
    const s = symbol.toUpperCase();
    const settings = await getSettings();
    const state = await getState();
    const params = resolveParams(settings.mode, state.paramOverrides, settings.limits);
    const { analyses, regime } = await scan({ symbols: [s] });
    const a = analyses[s];
    const spot = a?.price;
    const [funds, ratings, earnings, cs] = await Promise.all([
      market.fundamentals([s]).catch(() => ({})),
      market.ratings([s]).catch(() => ({})),
      upcomingEarnings([s]).catch(() => ({})),
      contractsFor(s, { minDte: 7, maxDte: 60, preferDte: 30, spot }).catch(() => []),
    ]);
    return ai.text(deepDivePrompt({ symbol: s, analysis: { ...brief(a), summary: a?.summary }, options: snapshotOptions(cs, spot), fundamentals: funds[s], ratings: ratings[s], earnings: earnings[s] || 'none in the next 10 days', regime: { label: regime.label, posture: regime.posture }, modeText: modeRules(params) }), { tier: 'default', onText, signal, agent: 'scout' });
  }

  return {
    getSettings,
    saveSettings,
    getState,
    patchState,
    getPlan,
    getExits,
    setExitPlan,
    snapshot,
    reconcile,
    analyzeSymbols,
    scan,
    runCycle,
    sendIntent,
    dismissIntent,
    cancelOrder,
    closePosition,
    checkExits,
    listIntents,
    listCycles: (limit = 40) => store.list(P.cycles, { orderBy: 'at', dir: 'desc', limit }),
    chat,
    chatHistory,
    explain,
    deepDive,
    contractsFor,
    earningsList,
    brokerFor,
    paths: P,
  };
}

export function statusText(s) {
  return {
    watching: 'Watching',
    planned: 'Planned (waiting for trigger)',
    proposed: 'Proposed — press Send',
    queued: 'Ready — press Send',
    sending: 'Sending to Robinhood',
    needs_review: 'Needs your review',
    sent: 'Sent to broker',
    working: 'Working (partly filled)',
    pending_approval: 'Waiting for your approval in Robinhood',
    filled: 'Filled',
    rejected: 'Rejected by broker',
    blocked: 'Blocked by risk gate',
    cancelled: 'Cancelled',
    expired: 'Expired',
    failed: 'Failed to send',
    vetoed: 'Vetoed by Operator',
    skipped: 'Skipped',
    closed: 'Closed',
  }[s] || s;
}

export { maskAccount };
