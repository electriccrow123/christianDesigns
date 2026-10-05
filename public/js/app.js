import * as E from './engine.js';
import { STRATEGIES, GLOSSARY, randomTip, reviewOrder, afterTrade } from './coach.js';
import { lineChart, payoffChart } from './charts.js';

// ---------------------------------------------------------------- state
const SAVE_KEY = 'tradetrainer.game.v1';
const WATCH_KEY = 'tradetrainer.watchlist.v1';
const DEFAULT_WATCH = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL'];
const REFRESH_MS = 15000;
const OPTION_STRATEGIES = new Set(['long-call', 'long-put', 'protective-put', 'covered-call', 'csp']);

let game = load(SAVE_KEY) || E.newGame(100000);
let watchlist = load(WATCH_KEY) || DEFAULT_WATCH.slice();
const quotes = {}; // SYMBOL -> quote
const optionQuotes = {}; // CONTRACT -> contract quote (+ symbol, right)
let summary = E.valuePortfolio(game);
const current = { symbol: watchlist[0] || 'SPY', range: '1d', sub: 'overview', chain: null, chainDate: null, strikeRange: '10', view: 'trade' };
let ticket = freshTicket('stock');
let pendingConfirm = null;
let tip = randomTip();

function freshTicket(asset, extra = {}) {
  return { asset, side: 'buy', orderType: 'market', qty: asset === 'stock' ? 10 : 1, price: '', contract: null, ...extra };
}

function load(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(game));
    localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist));
  } catch {
    /* storage full or blocked — game still works for this session */
  }
}

// ---------------------------------------------------------------- utils
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n, d = 2) =>
  n == null || Number.isNaN(n) ? '—' : (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const signedUsd = (n) => (n > 0 ? '+' : '') + usd(n);
const pct = (n) => (n == null || Number.isNaN(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(2) + '%');
const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const big = (n) => {
  if (!n) return '—';
  for (const [v, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (Math.abs(n) >= v) return (n / v).toFixed(2) + s;
  return String(n);
};
const fmtExp = (exp) => new Date(exp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const contractLabel = (p) => `${p.symbol} ${fmtExp(p.expiration)} $${p.strike} ${p.right === 'call' ? 'Call' : 'Put'}`;

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = msg;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), kind === 'achv' ? 6000 : 4500);
}

function marketState() {
  return quotes[current.symbol]?.marketState || quotes.SPY?.marketState || Object.values(quotes)[0]?.marketState;
}
const marketOpen = () => marketState() === 'REGULAR';

// ---------------------------------------------------------------- data refresh
function trackedSymbols() {
  const set = new Set([...watchlist, current.symbol]);
  for (const p of Object.values(game.positions)) set.add(p.symbol);
  for (const o of game.orders) set.add(o.symbol);
  return [...set].filter(Boolean);
}

async function refreshQuotes() {
  try {
    const { quotes: list } = await api(`/api/quote?symbols=${encodeURIComponent(trackedSymbols().join(','))}`);
    for (const q of list) quotes[q.symbol] = q;
    $('#chart-msg').dataset.err = '';
  } catch (e) {
    toast(`⚠️ Live prices unavailable: ${esc(e.message)}`, 'bad');
  }
  await refreshOptionQuotes();
  tick();
}

async function refreshOptionQuotes() {
  const groups = new Map();
  const add = (symbol, expiration) => groups.set(`${symbol}|${expiration}`, { symbol, expiration });
  for (const p of E.optionPositions(game)) add(p.symbol, p.expiration);
  for (const o of game.orders) if (o.asset === 'option') add(o.symbol, o.contract.expiration);
  if (ticket.contract) add(ticket.contract.symbol, ticket.contract.expiration);
  await Promise.all(
    [...groups.values()].map(async ({ symbol, expiration }) => {
      if (E.daysToExpiry(expiration) <= 0) return;
      try {
        const chain = await api(`/api/options?symbol=${symbol}&date=${expiration}`);
        ingestChain(symbol, chain);
        if (current.chain && current.symbol === symbol && current.chain.expiration === chain.expiration) current.chain = chain;
      } catch {
        /* keep last known marks */
      }
    }),
  );
}

function ingestChain(symbol, chain) {
  for (const c of chain.calls) optionQuotes[c.contract] = { ...c, symbol, right: 'call' };
  for (const c of chain.puts) optionQuotes[c.contract] = { ...c, symbol, right: 'put' };
  if (chain.underlying?.price) quotes[symbol] = { ...(quotes[symbol] || {}), ...chain.underlying };
}

/** Run the game loop: expirations, working orders, valuation, achievements, render. */
function tick() {
  const prices = Object.fromEntries(Object.values(quotes).map((q) => [q.symbol, q.price]));
  for (const ev of E.settleExpired(game, prices)) toast(`⏰ ${esc(contractLabel(ev))}: ${esc(ev.note)} P/L ${signedUsd(ev.realized)}`, ev.realized >= 0 ? 'good' : 'bad');
  const { fills, rejects } = E.processOrders(game, quotes, optionQuotes);
  for (const f of fills) toast(`✅ ${f.order.orderType.toUpperCase()} filled: ${describeTrade(f.trade)}<br><small>${esc(afterTrade(f.trade))}</small>`, 'good');
  for (const r of rejects) toast(`❌ Order canceled: ${esc(r.error)}`, 'bad');
  summary = E.valuePortfolio(game, quotes, optionQuotes);
  E.recordEquity(game, summary.equity);
  for (const a of E.checkAchievements(game, summary)) toast(`${a.icon} <b>Achievement unlocked:</b> ${esc(a.name)}<br><small>${esc(a.desc)}</small>`, 'achv');
  save();
  renderAll();
}

async function selectSymbol(sym, { keepTicket = false } = {}) {
  current.symbol = sym;
  current.chain = null;
  current.chainDate = null;
  if (!keepTicket) ticket = freshTicket('stock');
  renderAll();
  loadChart();
  if (!quotes[sym]) refreshQuotes();
  if (current.sub === 'chain') loadChain();
}

async function loadChart() {
  const canvas = $('#price-chart');
  const msg = $('#chart-msg');
  msg.textContent = 'Loading chart…';
  const sym = current.symbol;
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(sym)}&range=${current.range}`);
    if (sym !== current.symbol) return;
    msg.textContent = data.points.length < 2 ? 'No chart data for this range.' : '';
    const intraday = current.range === '1d' || current.range === '5d';
    lineChart(canvas, data.points, {
      baseline: current.range === '1d' ? data.previousClose : undefined,
      valueFmt: (v) => v.toFixed(2),
      timeFmt: (t, long) => {
        const d = new Date(t * 1000);
        if (intraday && current.range === '1d') return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        if (intraday) return d.toLocaleDateString(undefined, { weekday: 'short' }) + (long ? ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(current.range === '5y' || long ? { year: '2-digit' } : {}) });
      },
    });
  } catch (e) {
    lineChart(canvas, []);
    msg.textContent = `Chart unavailable: ${e.message}`;
  }
}

async function loadChain(date) {
  const sym = current.symbol;
  $('#chain').innerHTML = '<div class="empty">Loading option chain…</div>';
  try {
    const chain = await api(`/api/options?symbol=${encodeURIComponent(sym)}${date ? `&date=${date}` : ''}`);
    if (sym !== current.symbol) return;
    if (!date && E.daysToExpiry(chain.expiration) < 14) {
      // For learning, default to a ~30-45 day expiration rather than one that expires this week.
      const better = chain.expirations.find((e) => E.daysToExpiry(e) >= 25);
      if (better) return loadChain(better);
    }
    current.chain = chain;
    current.chainDate = chain.expiration;
    ingestChain(sym, chain);
    renderChain();
    renderQuoteHead();
  } catch (e) {
    current.chain = null;
    $('#exp-select').innerHTML = '';
    $('#chain').innerHTML = `<div class="empty">No options available for ${esc(sym)} (${esc(e.message)}). Try a large stock or ETF like SPY, AAPL or TSLA.</div>`;
  }
}

// ---------------------------------------------------------------- rendering
function renderAll() {
  renderHeader();
  renderWatchlist();
  renderQuoteHead();
  renderOverview();
  if (current.sub === 'chain' && current.chain) renderChain();
  if ($('#ticket').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') renderTicketLive();
  else renderTicket();
  if (current.view === 'portfolio') renderPortfolio();
  if (current.view === 'orders') renderOrders();
  if (current.view === 'progress') renderProgress();
}

function renderHeader() {
  const s = summary;
  $('#st-equity').textContent = usd(s.equity);
  $('#st-cash').textContent = usd(s.cash);
  $('#st-bp').textContent = usd(s.buyingPower);
  $('#st-bp').title = s.reserved ? `${usd(s.reserved)} reserved as collateral for short puts` : '';
  const day = $('#st-day');
  day.textContent = signedUsd(s.dayChange);
  day.className = cls(s.dayChange);
  const tot = $('#st-total');
  tot.textContent = `${signedUsd(s.totalPL)} (${pct(s.totalPLPct)})`;
  tot.className = cls(s.totalPL);
  const st = marketState();
  const badge = $('#market-badge');
  const label = { REGULAR: 'Market open', PRE: 'Pre-market', PREPRE: 'Market closed', POST: 'After hours', POSTPOST: 'Market closed', CLOSED: 'Market closed' }[st] || 'Market —';
  badge.textContent = '● ' + label;
  badge.className = 'badge ' + (st === 'REGULAR' ? 'open' : 'closed');
}

function renderWatchlist() {
  $('#watchlist').innerHTML = watchlist
    .map((s) => {
      const q = quotes[s];
      return `<li data-sym="${esc(s)}" class="${s === current.symbol ? 'active' : ''}">
        <div><div class="sym">${esc(s)}</div><div class="nm">${esc(q?.name || '')}</div></div>
        <div><div class="px">${q ? q.price?.toFixed(2) : '…'}</div><div class="chg ${cls(q?.changePercent)}">${q ? pct(q.changePercent) : ''}</div></div>
        <button class="rm" data-rm="${esc(s)}" title="Remove">×</button></li>`;
    })
    .join('');
}

function renderQuoteHead() {
  const q = quotes[current.symbol];
  const inWatch = watchlist.includes(current.symbol);
  const pos = E.stockPosition(game, current.symbol);
  $('#quote-head').innerHTML = `
    <div>
      <h2>${esc(current.symbol)}</h2>
      <div class="name">${esc(q?.name || 'Loading…')} ${q?.exchange ? '· ' + esc(q.exchange) : ''}</div>
    </div>
    <div>
      <div class="big">${q?.price != null ? q.price.toFixed(2) : '—'}</div>
      <div class="${cls(q?.change)} num">${q ? `${q.change >= 0 ? '+' : ''}${q.change?.toFixed(2)} (${pct(q.changePercent)})` : ''} <span class="muted">today</span></div>
    </div>
    <div class="actions">
      ${pos ? `<span class="badge">You own ${pos.qty}</span>` : ''}
      <button class="btn small" id="toggle-watch">${inWatch ? '★ Watching' : '☆ Watch'}</button>
      <button class="btn small buy" id="quick-buy">Buy</button>
      <button class="btn small sell" id="quick-sell" ${pos ? '' : 'disabled'}>Sell</button>
    </div>`;
}

function renderOverview() {
  const q = quotes[current.symbol];
  if (!q) return ($('#sub-overview').innerHTML = '<div class="empty">Loading quote…</div>');
  const kv = [
    ['Open', q.open?.toFixed(2)],
    ['Prev close', q.previousClose?.toFixed(2)],
    ['Day range', q.dayLow ? `${q.dayLow.toFixed(2)} – ${q.dayHigh.toFixed(2)}` : '—'],
    ['52-wk range', q.fiftyTwoWeekLow ? `${q.fiftyTwoWeekLow.toFixed(2)} – ${q.fiftyTwoWeekHigh.toFixed(2)}` : '—'],
    ['Bid / Ask', q.bid ? `${q.bid.toFixed(2)} / ${q.ask?.toFixed(2)}` : '—'],
    ['Volume', big(q.volume)],
    ['Avg volume', big(q.avgVolume)],
    ['Market cap', big(q.marketCap)],
    ['P/E', q.pe ? q.pe.toFixed(1) : '—'],
    ['50-day avg', q.fiftyDayAverage?.toFixed(2) ?? '—'],
    ['200-day avg', q.twoHundredDayAverage?.toFixed(2) ?? '—'],
    ['Div. yield', q.dividendYield ? q.dividendYield.toFixed(2) + '%' : '—'],
  ];
  const sig = [];
  if (q.fiftyDayAverage && q.twoHundredDayAverage) {
    const a50 = q.price > q.fiftyDayAverage;
    const a200 = q.price > q.twoHundredDayAverage;
    if (a50 && a200) sig.push(['good', '📈 Uptrend: price is above both its 50-day and 200-day moving averages. Trend-followers look for buying opportunities on pullbacks.']);
    else if (!a50 && !a200) sig.push(['warn', '📉 Downtrend: price is below both its 50-day and 200-day moving averages. Be cautious buying; bearish strategies (puts) fit this trend.']);
    else sig.push(['info', `↔️ Mixed trend: price is ${a50 ? 'above' : 'below'} the 50-day but ${a200 ? 'above' : 'below'} the 200-day average. Wait for confirmation or trade smaller.`]);
    sig.push(['info', `🎯 Possible support/resistance levels: 50-day avg $${q.fiftyDayAverage.toFixed(2)}, 200-day avg $${q.twoHundredDayAverage.toFixed(2)}. Traders often place stops just beyond these levels.`]);
  }
  if (q.fiftyTwoWeekHigh && q.price >= q.fiftyTwoWeekHigh * 0.97) sig.push(['info', '🔝 Trading near its 52-week high — strong momentum, but buying at highs carries pullback risk.']);
  if (q.fiftyTwoWeekLow && q.price <= q.fiftyTwoWeekLow * 1.05) sig.push(['warn', '🔻 Near its 52-week low. Cheap can get cheaper — wait for signs of a bottom.']);
  if (q.volume && q.avgVolume && q.volume > q.avgVolume * 1.5) sig.push(['info', '🔊 Volume is well above average today — big players are active. Moves on high volume are more meaningful.']);
  if (q.earningsTimestamp) {
    const d = (q.earningsTimestamp * 1000 - Date.now()) / 86400000;
    if (d > 0 && d < 30) sig.push(['warn', `📅 Earnings in about ${Math.ceil(d)} days (${new Date(q.earningsTimestamp * 1000).toLocaleDateString()}). Expect higher volatility and pricier options.`]);
  }
  $('#sub-overview').innerHTML = `
    <div class="kv">${kv.map(([k, v]) => `<div><span>${k}</span><span>${v ?? '—'}</span></div>`).join('')}</div>
    <h3 class="panel-title">Trading signals (educational)</h3>
    <div class="signals">${sig.map(([l, t]) => `<div class="signal ${l}">${t}</div>`).join('') || '<div class="muted">No signals available.</div>'}</div>`;
}

function renderChain() {
  const ch = current.chain;
  if (!ch) return;
  $('#exp-select').innerHTML = ch.expirations
    .map((e) => `<option value="${e}" ${e === ch.expiration ? 'selected' : ''}>${fmtExp(e)} (${Math.max(0, Math.round(E.daysToExpiry(e)))}d)</option>`)
    .join('');
  const S = ch.underlying?.price || quotes[current.symbol]?.price || 0;
  const strikes = [...new Set([...ch.calls.map((c) => c.strike), ...ch.puts.map((c) => c.strike)])].sort((a, b) => a - b);
  let shown = strikes;
  if (current.strikeRange !== 'all' && S) {
    const n = Number(current.strikeRange);
    const idx = strikes.findIndex((k) => k >= S);
    const center = idx < 0 ? strikes.length - 1 : idx;
    shown = strikes.slice(Math.max(0, center - n), center + n);
  }
  const callBy = Object.fromEntries(ch.calls.map((c) => [c.strike, c]));
  const putBy = Object.fromEntries(ch.puts.map((c) => [c.strike, c]));
  const held = new Set(E.optionPositions(game).map((p) => p.contract));
  const sel = ticket.contract?.contract;
  const cell = (c, f, right, extra = '') => {
    if (!c) return `<td></td>`;
    const v = c[f];
    const txt = f === 'iv' ? (v * 100).toFixed(0) + '%' : f === 'volume' || f === 'openInterest' ? (v || 0).toLocaleString() : v ? v.toFixed(2) : '—';
    const q = f === 'bid' || f === 'ask';
    return `<td class="${c.itm ? 'itm' : ''} ${q ? 'q ' + f : ''} ${q && sel === c.contract && ticket.side === (f === 'ask' ? 'buy' : 'sell') ? 'sel' : ''} ${extra}" ${q ? `data-c="${c.contract}" data-r="${right}" data-oside="${f === 'ask' ? 'buy' : 'sell'}"` : ''}>${txt}</td>`;
  };
  let barDone = false;
  const rows = shown
    .map((k) => {
      const c = callBy[k];
      const p = putBy[k];
      let bar = '';
      if (!barDone && S && k >= S) {
        barDone = true;
        bar = `<tr class="pricebar"><td colspan="13" title="${current.symbol} @ ${S.toFixed(2)}"></td></tr>`;
      }
      const mark = (o) => (o && held.has(o.contract) ? ' ●' : '');
      return `${bar}<tr>
        ${cell(c, 'openInterest', 'call')}${cell(c, 'volume', 'call')}${cell(c, 'iv', 'call')}${cell(c, 'last', 'call')}${cell(c, 'bid', 'call')}${cell(c, 'ask', 'call')}
        <td class="strike">${k}${mark(c)}${mark(p)}</td>
        ${cell(p, 'bid', 'put')}${cell(p, 'ask', 'put')}${cell(p, 'last', 'put')}${cell(p, 'iv', 'put')}${cell(p, 'volume', 'put')}${cell(p, 'openInterest', 'put')}
      </tr>`;
    })
    .join('');
  $('#chain').innerHTML = `<table>
    <thead><tr><th colspan="6" class="side up">Calls</th><th></th><th colspan="6" class="side down">Puts</th></tr>
    <tr><th>OI</th><th>Vol</th><th>IV</th><th>Last</th><th>Bid</th><th>Ask</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Last</th><th>IV</th><th>Vol</th><th>OI</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="13" class="empty">No contracts.</td></tr>'}</tbody></table>`;
}

// ---------------------------------------------------------------- ticket
function ticketContext() {
  const t = ticket;
  const q = quotes[t.asset === 'stock' ? current.symbol : t.contract?.symbol];
  const oq = t.contract ? optionQuotes[t.contract.contract] : null;
  const marketPx = t.asset === 'stock' ? q?.price : E.optionFillPrice(oq, t.side);
  const px = t.orderType === 'market' ? marketPx : Number(t.price) || 0;
  const position = t.asset === 'stock' ? E.stockPosition(game, current.symbol) : t.contract ? game.positions[t.contract.contract] : null;
  return { ...t, quote: q, optionQuote: oq, marketPx, price: px, qty: Math.max(0, Math.floor(Number(t.qty) || 0)), position, summary, marketOpen: marketOpen() };
}

function renderTicket() {
  const t = ticket;
  const isStock = t.asset === 'stock';
  const ctx = ticketContext();
  let html = isStock
    ? `<div class="seg"><button data-asset="stock" class="active">Stock · ${esc(current.symbol)}</button><button data-goto-chain>Options…</button></div>`
    : '<div id="t-contract"></div>';
  html += `<div class="seg"><button data-side="buy" class="buy ${t.side === 'buy' ? 'active' : ''}">Buy</button><button data-side="sell" class="sell ${t.side === 'sell' ? 'active' : ''}">Sell</button></div>`;
  html += `<div class="field"><label>Order type</label><select id="t-type">
      <option value="market" ${t.orderType === 'market' ? 'selected' : ''}>Market</option>
      <option value="limit" ${t.orderType === 'limit' ? 'selected' : ''}>Limit</option>
      ${t.side === 'sell' ? `<option value="stop" ${t.orderType === 'stop' ? 'selected' : ''}>Stop (stop-loss)</option>` : ''}
    </select></div>`;
  html += `<div class="field"><label>${isStock ? 'Shares' : 'Contracts'}</label><input id="t-qty" type="number" min="1" step="1" value="${esc(t.qty)}" /></div>`;
  html += `<div class="qty-quick">${(isStock ? [1, 10, 100] : [1, 5, 10]).map((n) => `<button data-qty="${n}">${n}</button>`).join('')}<button data-qty="max">Max</button></div>`;
  if (t.orderType !== 'market') {
    const ph = ctx.marketPx ? ctx.marketPx.toFixed(2) : '';
    html += `<div class="field"><label>${t.orderType === 'limit' ? 'Limit price' : 'Stop price'}</label><input id="t-price" type="number" min="0" step="0.01" placeholder="${ph}" value="${esc(t.price)}" /></div>`;
  }
  html += '<div id="t-est"></div>';
  html += `<button id="t-review" class="btn wide ${t.side === 'buy' ? 'buy' : 'sell'}">Review ${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.orderType !== 'market' ? t.orderType + ' ' : ''}order</button>`;
  html += `<div class="note">${t.orderType === 'market' ? 'Market orders fill immediately at the current price.' : t.orderType === 'limit' ? 'Limit orders wait until the price reaches your limit (or better).' : 'Stop orders sell automatically if the price falls to your stop.'}</div>`;
  $('#ticket').innerHTML = html;
  renderTicketLive();
}

/** Parts of the ticket that change with prices or typed input (never touches the inputs themselves). */
function renderTicketLive() {
  const ctx = ticketContext();
  const t = ticket;
  const isStock = t.asset === 'stock';
  if (!isStock && $('#t-contract')) {
    const c = t.contract;
    const oq = ctx.optionQuote || {};
    const S = quotes[c.symbol]?.price;
    const dte = E.daysToExpiry(c.expiration);
    const g = S ? E.greeks({ S, K: c.strike, T: Math.max(dte, 0.5) / 365, iv: oq.iv, right: c.right }) : null;
    $('#t-contract').innerHTML = `<div class="contract-box">
      <div class="title">${esc(contractLabel(c))} <span class="tag ${c.right}">${c.right.toUpperCase()}</span></div>
      <div class="muted">${dte.toFixed(1)} days to expiry · ${oq.itm ? 'In the money' : 'Out of the money'}</div>
      <div class="num">Bid ${oq.bid?.toFixed(2) ?? '—'} · Ask ${oq.ask?.toFixed(2) ?? '—'} · Last ${oq.last?.toFixed(2) ?? '—'}</div>
      ${g ? `<div class="num muted">Δ ${g.delta.toFixed(2)} · Θ ${(g.theta * 100).toFixed(2)}/day per contract · IV ${((oq.iv || 0) * 100).toFixed(0)}% · ${(g.probITM * 100).toFixed(0)}% ITM</div>` : ''}
      <button class="link" data-asset="stock">← back to stock</button>
    </div>`;
  }
  const mult = isStock ? 1 : E.OPTION_MULTIPLIER;
  const gross = ctx.price * ctx.qty * mult;
  const fee = isStock ? game.settings.stockFee || 0 : E.optionFee(game, ctx.qty);
  const total = t.side === 'buy' ? gross + fee : gross - fee;
  const rows = [
    [isStock ? 'Price' : 'Premium (per share)', ctx.price ? usd(ctx.price) : '—'],
    ...(isStock ? [] : [['× 100 × contracts', usd(gross)], ['Commission', usd(fee)]]),
    [t.side === 'buy' ? 'Est. cost' : 'Est. proceeds', usd(total)],
    ['Buying power', usd(summary.buyingPower)],
  ];
  if (isStock && ctx.position) rows.push(['You own', `${ctx.position.qty} @ ${usd(ctx.position.avgCost)}`]);
  if (!isStock && ctx.position) rows.push(['Your position', `${ctx.position.qty > 0 ? 'Long' : 'Short'} ${Math.abs(ctx.position.qty)} @ ${usd(ctx.position.avgPrice)}`]);
  if (!isStock) rows.unshift(['Action', optionActionLabel(ctx)]);
  if (!isStock && ctx.price) {
    const risk = E.optionRiskProfile({ right: t.contract.right, strike: t.contract.strike, premium: ctx.price, qty: ctx.qty || 1, side: t.side });
    rows.push(['Breakeven at expiry', usd(risk.breakeven)]);
    rows.push(['Max profit', risk.maxProfit === Infinity ? 'Unlimited' : usd(risk.maxProfit)]);
    rows.push(['Max loss', risk.maxLoss === Infinity ? 'Unlimited' : usd(risk.maxLoss)]);
  }
  let html = `<div class="estimate">${rows.map(([k, v]) => `<div><span class="muted">${k}</span><span>${v}</span></div>`).join('')}</div>`;
  if (!isStock) html += `<canvas id="payoff-chart" height="140"></canvas><div class="note">Profit/loss at expiration for this order.</div>`;
  $('#t-est').innerHTML = html;
  if (!isStock && ctx.price) drawPayoff(ctx);
  renderCoach(ctx);
}

function optionActionLabel(ctx) {
  const held = ctx.position?.qty || 0;
  if (ctx.side === 'buy') return held < 0 ? 'Buy to close' : 'Buy to open';
  if (held > 0) return 'Sell to close';
  return ctx.contract.right === 'call' ? 'Sell to open (covered call)' : 'Sell to open (cash-secured put)';
}

function drawPayoff(ctx) {
  const c = ctx.contract;
  const S = quotes[c.symbol]?.price || c.strike;
  const span = Math.max(Math.abs(S - c.strike) * 1.6, S * 0.2);
  const lo = Math.max(0, Math.min(S, c.strike) - span);
  const hi = Math.max(S, c.strike) + span;
  const sign = ctx.side === 'buy' ? 1 : -1;
  const qty = ctx.qty || 1;
  const leg = { right: c.right, strike: c.strike, premium: ctx.price, qty: sign * qty };
  const pos = E.stockPosition(game, c.symbol);
  // covered call: show combined shares + short call; otherwise the option alone
  const withShares = ctx.side === 'sell' && c.right === 'call' && pos && !(ctx.position?.qty > 0);
  const fn = (s) => E.optionPayoff(s, leg) + (withShares ? (s - pos.avgCost) * qty * 100 : 0);
  const be = withShares ? [pos.avgCost - ctx.price] : [c.right === 'call' ? c.strike + ctx.price : c.strike - ctx.price];
  payoffChart($('#payoff-chart'), fn, { spot: S, lo, hi, breakevens: be });
}

function renderCoach(ctx = ticketContext()) {
  const items = ctx.price ? reviewOrder(ctx) : [{ level: 'info', text: ctx.asset === 'option' ? 'This contract has no price right now.' : 'Waiting for a live price…' }];
  if (!items.length) items.push({ level: 'info', text: 'Looks good. Always know your exit before you enter.' });
  $('#coach').innerHTML = items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('');
}

function maxQty() {
  const ctx = ticketContext();
  if (!ctx.price) return 1;
  if (ticket.asset === 'stock') {
    if (ticket.side === 'buy') return Math.max(1, Math.floor(summary.buyingPower / ctx.price));
    const pos = ctx.position;
    return Math.max(1, pos ? pos.qty - E.sharesCommitted(game, current.symbol) : 1);
  }
  const held = ctx.position?.qty || 0;
  if (ticket.side === 'buy') return held < 0 ? -held : Math.max(1, Math.floor(summary.buyingPower / (ctx.price * 100 + game.settings.optionFee)));
  if (held > 0) return held;
  const c = ticket.contract;
  if (c.right === 'call') return Math.max(1, Math.floor(((E.stockPosition(game, c.symbol)?.qty || 0) - E.sharesCommitted(game, c.symbol)) / 100));
  return Math.max(1, Math.floor(summary.buyingPower / (c.strike * 100)));
}

function setOptionTicket(contractSymbol, side) {
  const q = optionQuotes[contractSymbol];
  if (!q) return;
  const contract = { contract: q.contract, symbol: q.symbol, right: q.right, strike: q.strike, expiration: q.expiration };
  const held = game.positions[contractSymbol]?.qty || 0;
  const qty = (side === 'sell' && held > 0) || (side === 'buy' && held < 0) ? Math.abs(held) : 1;
  ticket = freshTicket('option', { side, contract, qty });
  // Options are best traded with limit orders at the mid
  if (q.bid > 0 && q.ask > 0 && (q.ask - q.bid) / ((q.ask + q.bid) / 2) > 0.1) {
    ticket.orderType = 'limit';
    ticket.price = ((q.bid + q.ask) / 2).toFixed(2);
  }
  renderTicket();
  if (current.chain) renderChain();
  if (window.innerWidth < 1200) $('.ticket').scrollIntoView({ behavior: 'smooth' });
}

function reviewTicket() {
  const ctx = ticketContext();
  if (!ctx.qty) return toast('Enter a quantity of at least 1.', 'bad');
  if (!ctx.price) return toast(ctx.orderType === 'market' ? 'No live price available yet.' : `Enter a ${ctx.orderType} price.`, 'bad');
  const isStock = ctx.asset === 'stock';
  const what = isStock ? `${ctx.qty} share${ctx.qty > 1 ? 's' : ''} of ${current.symbol}` : `${ctx.qty} × ${contractLabel(ctx.contract)}`;
  const mult = isStock ? 1 : 100;
  const fee = isStock ? game.settings.stockFee || 0 : E.optionFee(game, ctx.qty);
  const gross = ctx.price * ctx.qty * mult;
  const tips = reviewOrder(ctx);
  $('#confirm-title').textContent = `${ctx.side === 'buy' ? 'Buy' : 'Sell'} ${what}`;
  $('#confirm-body').innerHTML = `
    <div class="estimate">
      ${!isStock ? `<div><span class="muted">Action</span><span>${optionActionLabel(ctx)}</span></div>` : ''}
      <div><span class="muted">Order type</span><span>${ctx.orderType.toUpperCase()}${ctx.orderType !== 'market' ? ' @ ' + usd(ctx.price) : ''}</span></div>
      <div><span class="muted">${ctx.orderType === 'market' ? 'Price' : 'Current market'}</span><span>${usd(ctx.marketPx)}</span></div>
      <div><span class="muted">Commission</span><span>${usd(fee)}</span></div>
      <div><span class="muted">${ctx.side === 'buy' ? 'Total cost' : 'Total proceeds'}</span><span>${usd(ctx.side === 'buy' ? gross + fee : gross - fee)}</span></div>
    </div>
    <ul class="coach" style="margin-top:12px">${tips.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>`;
  $('#confirm-go').className = `btn ${ctx.side === 'buy' ? 'buy' : 'sell'}`;
  pendingConfirm = ctx;
  $('#confirm-dialog').showModal();
}

function executeTicket(ctx) {
  const isStock = ctx.asset === 'stock';
  let res;
  if (ctx.orderType === 'market') {
    res = isStock
      ? E.tradeStock(game, { symbol: current.symbol, side: ctx.side, qty: ctx.qty, price: ctx.marketPx })
      : E.tradeOption(game, { contract: ctx.contract, side: ctx.side, qty: ctx.qty, price: ctx.marketPx });
    if (!res.ok) return toast(`❌ ${esc(res.error)}`, 'bad');
    toast(`✅ Filled: ${describeTrade(res.trade)}<br><small>${esc(afterTrade(res.trade))}</small>`, 'good');
    if (isStock && ctx.side === 'buy') tip = 'Set a stop-loss: choose Sell → Stop and enter a price ~5–8% below your entry, or just under a support level.';
  } else {
    res = E.placeOrder(game, {
      asset: ctx.asset,
      symbol: isStock ? current.symbol : ctx.contract.symbol,
      contract: isStock ? undefined : ctx.contract,
      side: ctx.side,
      orderType: ctx.orderType,
      qty: ctx.qty,
      price: ctx.price,
    });
    if (!res.ok) return toast(`❌ ${esc(res.error)}`, 'bad');
    toast(`📝 ${ctx.orderType.toUpperCase()} order working: ${ctx.side} ${ctx.qty} ${esc(isStock ? current.symbol : contractLabel(ctx.contract))} @ ${usd(ctx.price)}. See Orders & History.`);
  }
  ticket = isStock ? freshTicket('stock') : { ...ticket, price: '' };
  tick();
}

function describeTrade(t) {
  const what = t.asset === 'stock' ? `${t.qty} ${t.symbol}` : `${t.qty} × ${contractLabel(t)}`;
  const verb = t.action ? t.action.replace(/_/g, ' ') : t.side;
  return `${esc(verb)} ${esc(what)} @ ${usd(t.price)}${t.realized && Math.abs(t.realized) > (t.fee || 0) + 0.001 ? ` · P/L <span class="${cls(t.realized)}">${signedUsd(t.realized)}</span>` : ''}`;
}

// ---------------------------------------------------------------- portfolio / orders / progress
function renderPortfolio() {
  const s = summary;
  const cards = [
    ['Account value', usd(s.equity), `Started with ${usd(game.startingBalance, 0)}`],
    ['Total P/L', `<span class="${cls(s.totalPL)}">${signedUsd(s.totalPL)}</span>`, pct(s.totalPLPct)],
    ['Realized P/L', `<span class="${cls(s.realized)}">${signedUsd(s.realized)}</span>`, `Fees paid ${usd(game.totalFees)}`],
    ['Unrealized P/L', `<span class="${cls(s.unrealized)}">${signedUsd(s.unrealized)}</span>`, 'On open positions'],
    ['Cash', usd(s.cash), s.reserved ? `${usd(s.reserved)} reserved for short puts` : 'Available'],
    ['Stocks', usd(s.stocksValue), `${s.rows.filter((r) => r.type === 'stock').length} positions`],
    ['Options', usd(s.optionsValue), `${s.rows.filter((r) => r.type === 'option').length} positions`],
  ];
  $('#pf-cards').innerHTML = cards.map(([l, v, sub]) => `<div class="card"><label>${l}</label><strong>${v}</strong><small>${sub}</small></div>`).join('');
  const eq = game.equityHistory.map((p) => [p.t, p.v]);
  if (eq.length < 2) eq.push([Date.now(), s.equity]);
  lineChart($('#equity-chart'), eq, {
    baseline: game.startingBalance,
    valueFmt: (v) => '$' + Math.round(v).toLocaleString(),
    timeFmt: (t, long) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(long ? { hour: 'numeric', minute: '2-digit' } : {}) }),
  });
  if (!s.rows.length) {
    $('#positions').innerHTML = '<div class="empty">No open positions yet. Head to the <b>Trade</b> tab to make your first trade!</div>';
    return;
  }
  const rows = s.rows
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map((r) => {
      const isOpt = r.type === 'option';
      const name = isOpt ? `${esc(contractLabel(r))} <span class="tag ${r.right}">${r.qty > 0 ? 'LONG' : 'SHORT'}</span>` : `<b>${esc(r.symbol)}</b> <span class="muted">${esc(quotes[r.symbol]?.name || '')}</span>`;
      const alloc = s.equity ? (Math.abs(r.value) / s.equity) * 100 : 0;
      return `<tr>
        <td>${name}${isOpt ? `<div class="muted">${E.daysToExpiry(r.expiration).toFixed(1)} days left</div>` : ''}</td>
        <td class="r">${r.qty}</td>
        <td class="r">${usd(isOpt ? r.avgPrice : r.avgCost)}</td>
        <td class="r">${usd(r.price)}${r.stale ? ' <span class="muted" title="No live quote yet">*</span>' : ''}</td>
        <td class="r">${usd(r.value)}</td>
        <td class="r ${cls(r.pl)}">${signedUsd(r.pl)}</td>
        <td class="r ${cls(r.pl)}">${pct(r.plPct)}</td>
        <td class="r">${alloc.toFixed(1)}%</td>
        <td class="r"><button class="btn small" data-trade="${esc(r.key)}">Trade</button> <button class="btn small ${r.qty > 0 ? 'sell' : 'buy'}" data-close="${esc(r.key)}">Close</button></td>
      </tr>`;
    })
    .join('');
  $('#positions').innerHTML = `<table class="data"><thead><tr><th>Position</th><th class="r">Qty</th><th class="r">Avg cost</th><th class="r">Price</th><th class="r">Value</th><th class="r">P/L</th><th class="r">P/L %</th><th class="r">% of acct</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderOrders() {
  $('#orders').innerHTML = game.orders.length
    ? `<table class="data"><thead><tr><th>Placed</th><th>Instrument</th><th>Side</th><th>Type</th><th class="r">Qty</th><th class="r">Trigger price</th><th class="r">Market now</th><th></th></tr></thead><tbody>${game.orders
        .map((o) => {
          const mkt = o.asset === 'stock' ? quotes[o.symbol]?.price : E.optionMark(optionQuotes[o.contract.contract]);
          return `<tr><td>${new Date(o.createdAt).toLocaleString()}</td><td>${esc(o.asset === 'stock' ? o.symbol : contractLabel(o.contract))}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side.toUpperCase()}</td><td>${o.orderType}</td><td class="r">${o.qty}</td><td class="r">${usd(o.price)}</td><td class="r">${usd(mkt)}</td><td class="r"><button class="btn small" data-cancel="${o.id}">Cancel</button></td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<div class="empty">No working orders. Limit and stop orders you place will show here until they fill.</div>';

  const hist = game.history.slice(0, 300);
  $('#history').innerHTML = hist.length
    ? `<table class="data"><thead><tr><th>Time</th><th>Event</th><th>Instrument</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Cash</th><th class="r">Realized P/L</th><th>Note</th></tr></thead><tbody>${hist
        .map((h) => {
          const inst = h.asset === 'option' && h.strike ? contractLabel(h) : h.symbol;
          const ev = h.kind === 'trade' ? (h.action ? h.action.replace(/_/g, ' ') : h.side) : h.kind;
          return `<tr><td>${new Date(h.t).toLocaleString()}</td><td>${esc(ev)}</td><td>${esc(inst)}</td><td class="r">${h.qty ?? ''}</td><td class="r">${h.price != null ? usd(h.price) : ''}</td><td class="r ${cls(h.amount)}">${h.amount != null ? signedUsd(h.amount) : ''}</td><td class="r ${cls(h.realized)}">${h.realized ? signedUsd(h.realized) : ''}</td><td class="muted">${esc(h.note || '')}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<div class="empty">No trades yet.</div>';
}

function renderProgress() {
  $('#achievements').innerHTML = E.ACHIEVEMENTS.map((a) => {
    const at = game.achievements[a.id];
    return `<div class="ach ${at ? 'done' : ''}"><div class="ic">${a.icon}</div><div><b>${esc(a.name)}</b><small>${esc(a.desc)}${at ? `<br>Unlocked ${new Date(at).toLocaleDateString()}` : ''}</small></div></div>`;
  }).join('');
  const closes = game.history.filter((h) => (h.kind === 'trade' || h.kind === 'expiration') && h.realized && Math.abs(h.realized) > (h.fee || 0) + 0.001);
  const wins = closes.filter((h) => h.realized > 0);
  const losses = closes.filter((h) => h.realized < 0);
  const avg = (a) => (a.length ? a.reduce((s, h) => s + h.realized, 0) / a.length : 0);
  const trades = game.history.filter((h) => h.kind === 'trade').length;
  const stats = [
    ['Trades placed', trades],
    ['Closed trades', closes.length],
    ['Win rate', closes.length ? ((wins.length / closes.length) * 100).toFixed(0) + '%' : '—'],
    ['Average win', `<span class="up">${usd(avg(wins))}</span>`],
    ['Average loss', `<span class="down">${usd(avg(losses))}</span>`],
    ['Best trade', closes.length ? `<span class="up">${usd(Math.max(...closes.map((h) => h.realized)))}</span>` : '—'],
    ['Worst trade', closes.length ? `<span class="down">${usd(Math.min(...closes.map((h) => h.realized)))}</span>` : '—'],
    ['Fees paid', usd(game.totalFees)],
  ];
  $('#trade-stats').innerHTML = stats.map(([l, v]) => `<div class="card"><label>${l}</label><strong>${v}</strong></div>`).join('');
}

function renderLearn() {
  $('#strategies').innerHTML = STRATEGIES.map(
    (s) => `<article class="panel strategy">
      <h3>${esc(s.name)}</h3>
      <div class="meta"><span>${esc(s.level)}</span><span>Outlook: ${esc(s.outlook)}</span></div>
      <p>${esc(s.what)}</p>
      <h4>When to use it</h4><p>${esc(s.when)}</p>
      <h4>How to place it</h4><ol>${s.how.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
      <h4>Where to place it</h4><p>${esc(s.where)}</p>
      <div class="rr"><div><b class="down">Risk:</b> ${esc(s.risk)}</div><div><b class="up">Reward:</b> ${esc(s.reward)}</div></div>
      ${s.tips?.length ? `<h4>Pro tips</h4><ul>${s.tips.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <button class="btn primary small" data-practice="${s.id}">Practice it →</button>
    </article>`,
  ).join('');
  $('#glossary').innerHTML = GLOSSARY.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function renderTip() {
  $('#tip-text').textContent = tip;
}

// ---------------------------------------------------------------- navigation & events
function showView(view) {
  current.view = view;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  renderAll();
  if (view === 'trade') loadChart();
}

function showSub(sub) {
  current.sub = sub;
  document.querySelectorAll('.subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('.sub').forEach((v) => v.classList.toggle('active', v.id === 'sub-' + sub));
  if (sub === 'chain' && !current.chain) loadChain();
}

function addToWatch(sym) {
  if (!watchlist.includes(sym)) watchlist.unshift(sym);
  save();
}

function bind() {
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.querySelectorAll('.subtab').forEach((b) => b.addEventListener('click', () => showSub(b.dataset.sub)));
  $('#ranges').addEventListener('click', (e) => {
    const r = e.target.dataset.range;
    if (!r) return;
    current.range = r;
    document.querySelectorAll('#ranges button').forEach((b) => b.classList.toggle('active', b.dataset.range === r));
    loadChart();
  });

  // search
  let timer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (!q) return ($('#search-results').innerHTML = '');
    timer = setTimeout(async () => {
      try {
        const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
        $('#search-results').innerHTML = results.length
          ? results.map((r) => `<li data-pick="${esc(r.symbol)}"><b>${esc(r.symbol)}</b><small>${esc(r.name)} · ${esc(r.exchange || r.type)}</small></li>`).join('')
          : '<li class="muted">No matches</li>';
      } catch {
        $('#search-results').innerHTML = '<li class="muted">Search unavailable</li>';
      }
    }, 250);
  });
  $('#search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#search-results [data-pick]');
      const sym = first ? first.dataset.pick : e.target.value.trim().toUpperCase();
      if (sym) pick(sym);
    }
  });
  const pick = (sym) => {
    $('#search').value = '';
    $('#search-results').innerHTML = '';
    addToWatch(sym);
    selectSymbol(sym);
  };
  $('#search-results').addEventListener('click', (e) => {
    const li = e.target.closest('[data-pick]');
    if (li) pick(li.dataset.pick);
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) $('#search-results').innerHTML = '';
  });

  $('#watchlist').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      e.stopPropagation();
      watchlist = watchlist.filter((s) => s !== rm.dataset.rm);
      save();
      return renderWatchlist();
    }
    const li = e.target.closest('[data-sym]');
    if (li) selectSymbol(li.dataset.sym);
  });

  $('#quote-head').addEventListener('click', (e) => {
    if (e.target.id === 'toggle-watch') {
      if (watchlist.includes(current.symbol)) watchlist = watchlist.filter((s) => s !== current.symbol);
      else addToWatch(current.symbol);
      save();
      renderWatchlist();
      renderQuoteHead();
    }
    if (e.target.id === 'quick-buy' || e.target.id === 'quick-sell') {
      const side = e.target.id === 'quick-buy' ? 'buy' : 'sell';
      ticket = freshTicket('stock', { side, qty: side === 'sell' ? E.stockPosition(game, current.symbol)?.qty || 1 : 10 });
      renderTicket();
    }
  });

  $('#next-tip').addEventListener('click', () => {
    tip = randomTip(tip);
    renderTip();
  });

  // options chain
  $('#exp-select').addEventListener('change', (e) => loadChain(e.target.value));
  $('#strike-range').addEventListener('change', (e) => {
    current.strikeRange = e.target.value;
    renderChain();
  });
  $('#chain').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-c]');
    if (td) setOptionTicket(td.dataset.c, td.dataset.oside);
  });

  // ticket
  const tk = $('#ticket');
  tk.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.side) {
      ticket.side = b.dataset.side;
      if (ticket.side === 'buy' && ticket.orderType === 'stop') ticket.orderType = 'market';
      if (ticket.asset === 'option' && ticket.contract) {
        const q = optionQuotes[ticket.contract.contract];
        if (ticket.orderType === 'limit' && q?.bid > 0 && q?.ask > 0) ticket.price = ((q.bid + q.ask) / 2).toFixed(2);
      }
      renderTicket();
      if (current.chain) renderChain();
    } else if (b.dataset.asset === 'stock') {
      ticket = freshTicket('stock');
      renderTicket();
      if (current.chain) renderChain();
    } else if ('gotoChain' in b.dataset) {
      showSub('chain');
      $('#sub-chain').scrollIntoView({ behavior: 'smooth' });
    } else if (b.dataset.qty) {
      ticket.qty = b.dataset.qty === 'max' ? maxQty() : Number(b.dataset.qty);
      renderTicket();
    } else if (b.id === 't-review') {
      reviewTicket();
    }
  });
  tk.addEventListener('change', (e) => {
    if (e.target.id === 't-type') {
      ticket.orderType = e.target.value;
      const ctx = ticketContext();
      if (ticket.orderType !== 'market' && !ticket.price && ctx.marketPx) {
        ticket.price = (ticket.orderType === 'stop' ? ctx.marketPx * (ticket.asset === 'stock' ? 0.93 : 0.5) : ctx.marketPx).toFixed(2);
      }
      renderTicket();
    }
  });
  tk.addEventListener('input', (e) => {
    if (e.target.id === 't-qty') ticket.qty = e.target.value;
    if (e.target.id === 't-price') ticket.price = e.target.value;
    if (e.target.id === 't-qty' || e.target.id === 't-price') renderTicketLive();
  });

  $('#confirm-dialog').addEventListener('close', () => {
    if ($('#confirm-dialog').returnValue === 'confirm' && pendingConfirm) executeTicket(pendingConfirm);
    pendingConfirm = null;
  });

  // portfolio actions
  $('#positions').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const key = b.dataset.trade || b.dataset.close;
    const p = game.positions[key];
    if (!p) return;
    showView('trade');
    if (p.type === 'stock') {
      selectSymbol(p.symbol);
      if (b.dataset.close) ticket = freshTicket('stock', { side: 'sell', qty: p.qty - E.sharesCommitted(game, p.symbol) || p.qty });
      renderTicket();
    } else {
      selectSymbol(p.symbol, { keepTicket: true });
      if (!optionQuotes[p.contract]) {
        optionQuotes[p.contract] = { contract: p.contract, symbol: p.symbol, right: p.right, strike: p.strike, expiration: p.expiration, bid: 0, ask: 0, last: p.avgPrice };
      }
      setOptionTicket(p.contract, b.dataset.close ? (p.qty > 0 ? 'sell' : 'buy') : p.qty > 0 ? 'buy' : 'sell');
    }
  });
  $('#orders').addEventListener('click', (e) => {
    const id = Number(e.target.dataset.cancel);
    if (!id) return;
    E.cancelOrder(game, id);
    toast('Order canceled.');
    tick();
  });

  // learn
  $('#strategies').addEventListener('click', (e) => {
    const id = e.target.dataset.practice;
    if (!id) return;
    const strat = STRATEGIES.find((s) => s.id === id);
    tip = `Practicing: ${strat.name}. ${strat.where}`;
    showView('trade');
    if (id === 'buy-hold' && current.symbol !== 'SPY') selectSymbol('SPY');
    if (OPTION_STRATEGIES.has(id)) showSub('chain');
    else showSub('overview');
    if (id === 'limit-entry') {
      ticket = freshTicket('stock', { orderType: 'limit' });
      ticket.price = quotes[current.symbol]?.price ? (quotes[current.symbol].price * 0.98).toFixed(2) : '';
    }
    if (id === 'stop-loss' && E.stockPosition(game, current.symbol)) {
      const q = quotes[current.symbol];
      ticket = freshTicket('stock', { side: 'sell', orderType: 'stop', qty: E.stockPosition(game, current.symbol).qty, price: q ? (q.price * 0.93).toFixed(2) : '' });
    }
    renderTip();
    renderTicket();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // reset
  $('#btn-reset').addEventListener('click', () => $('#reset-dialog').showModal());
  $('#reset-dialog').addEventListener('close', () => {
    if ($('#reset-dialog').returnValue !== 'confirm') return;
    game = E.newGame(Number($('#reset-balance').value), { optionFee: Number($('#reset-fee').value) });
    ticket = freshTicket('stock');
    save();
    toast(`🔄 New game started with ${usd(game.startingBalance, 0)}. Good luck!`, 'good');
    tick();
  });

  window.addEventListener('resize', () => {
    clearTimeout(bind._r);
    bind._r = setTimeout(() => {
      loadChart();
      if (current.view === 'portfolio') renderPortfolio();
      renderTicket();
    }, 150);
  });
}

// ---------------------------------------------------------------- boot
bind();
renderLearn();
renderTip();
renderAll();
refreshQuotes();
loadChart();
setInterval(() => {
  if (document.visibilityState === 'visible') refreshQuotes();
}, REFRESH_MS);
setInterval(() => {
  tip = randomTip(tip);
  renderTip();
}, 60000);
