// Crow's Nest UI controller. Renders the six tabs from desk state and wires the controls.

import { createHostedRuntime, createLocalStore } from '../adapters/hosted.js';
import { createLocalRuntime } from '../adapters/local.js';
import { createDesk, statusText, PATHS } from '../core/desk.js';
import { MODES, PARAMS, resolveParams, modeById } from '../core/modes.js';
import { marketStatus, todayNY, label12, daysBetween, fmtDateNY, addDays } from '../core/market-clock.js';
import { nextSlot, dueSlot, todayTimeline, weekEvents } from '../core/planner.js';
import { AGENTS } from '../core/agents.js';
import { LESSONS, MODULES, GLOSSARY, lessonById, progressSummary } from '../core/academy.js';
import { contractLabel, STRATEGIES } from '../core/options.js';
import { esc, money, pct, qty, round, uniq } from '../core/util.js';
import { equityChart, priceChart, gaugeSVG } from './charts.js';

const HOSTED = typeof window.claude?.use === 'function';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  runtime: null,
  desk: null,
  tab: 'desk',
  settings: null,
  state: null,
  plan: null,
  exits: {},
  equity: { live: [], paper: [] },
  snap: null,
  snapError: null,
  snapAt: 0,
  intents: [],
  cycles: [],
  chat: [],
  roomCycleId: null,
  scan: null,
  scanError: null,
  selected: 'SPY',
  open: new Set(),
  busy: { cycle: false, chat: false, scan: false, refresh: false },
  progress: null,
  liveMessages: [],
  streaming: null,
  intentFilter: 'active',
  academy: { progress: {}, lesson: null, answers: {}, drill: null, glossaryQ: '' },
  deepDive: {},
  explains: {},
  searchResults: [],
  ready: false,
};

const ACTIVE = new Set(['watching', 'planned', 'proposed', 'queued', 'needs_review', 'sending', 'sent', 'pending_approval', 'working']);
const SENDABLE = new Set(['proposed', 'queued', 'needs_review', 'failed']);
const AGENT_COLORS = { honcho: 'var(--agent-honcho)', operator: 'var(--agent-operator)', scout: 'var(--agent-scout)', analyst: 'var(--agent-analyst)', gate: 'var(--agent-gate)', system: 'var(--agent-system)' };
const AGENT_NAMES = { honcho: 'Head Honcho', operator: 'Operator', scout: 'Scout', analyst: 'Analyst', gate: 'Risk gate', system: 'Desk' };
const AGENT_INITIALS = { honcho: 'HH', operator: 'OP', scout: 'SC', analyst: 'AN', gate: 'RG', system: 'CN' };

// ------------------------------------------------------------------ small helpers
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5200);
}

const signCls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const ago = (ms) => {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const timeNY = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const dateNY = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
const conv = (n) => (n ? '●'.repeat(Math.min(5, n)) + '○'.repeat(Math.max(0, 5 - n)) : '');

function confirmModal({ title, body, confirm = 'Confirm', danger = false, check }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    $('#modal-body').innerHTML = `<h2>${esc(title)}</h2><div>${body}</div>${check ? `<label class="field" style="border:0"><span><input type="checkbox" id="modal-check"> ${esc(check)}</span></label>` : ''}<div class="modal-actions"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" id="modal-ok" class="btn ${danger ? 'danger' : 'primary'}" ${check ? 'disabled' : ''}>${esc(confirm)}</button></div>`;
    if (check) $('#modal-check').addEventListener('change', (e) => ($('#modal-ok').disabled = !e.target.checked));
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.showModal();
  });
}

function infoModal(title, html) {
  $('#modal-body').innerHTML = `<h2>${esc(title)}</h2><div class="prose" style="white-space:normal">${html}</div><div class="modal-actions"><button value="ok" class="btn primary">Close</button></div>`;
  $('#modal').onclose = null;
  $('#modal').returnValue = '';
  $('#modal').showModal();
}

function aiErrorText(err) {
  return err?.message || 'Something went wrong.';
}

// ------------------------------------------------------------------ boot
async function boot() {
  renderShell();
  try {
    S.runtime = HOSTED ? await createHostedRuntime() : await createLocalRuntime();
  } catch (err) {
    S.runtime = { kind: 'none', market: null, brokers: {}, ai: null, store: createLocalStore(), capabilities: {} };
    toast(err.message, 'bad');
  }
  const rt = S.runtime;
  const noMarket = new Proxy({}, { get: () => async () => { throw rt.marketError || new Error('Market data is not connected.'); } });
  const noAI = { available: false, json: async () => { throw new Error('Claude is not available in this view.'); }, text: async () => { throw new Error('Claude is not available in this view.'); } };
  const brokers = { paper: rt.brokers?.paper || null, live: rt.brokers?.live || null };
  if (!brokers.paper) brokers.paper = { live: false, kind: 'paper', snapshot: async () => { throw rt.marketError || new Error('Market data is not connected.'); }, account: async () => ({}), preview: async () => ({ ok: false, alerts: [] }), place: async () => ({ ok: false }), cancel: async () => ({ ok: false }) };
  S.desk = createDesk({ market: rt.market || noMarket, brokers, ai: rt.ai || noAI, store: rt.store, log: (...a) => console.warn(...a) });
  const store = rt.store;
  S.settings = await S.desk.getSettings();
  S.state = await S.desk.getState();
  S.plan = await S.desk.getPlan();
  S.academy.progress = (await store.get('academy/progress').catch(() => null)) || {};
  S.ready = true;
  // Live updates (the background autopilot writes here too)
  store.watch?.(PATHS.settings, async () => {
    S.settings = await S.desk.getSettings();
    renderAll();
  });
  store.watch?.(PATHS.state, async () => {
    S.state = await S.desk.getState();
    renderHeader();
    renderBanners();
  });
  store.watch?.(PATHS.plan, async () => {
    S.plan = await S.desk.getPlan();
    if (S.tab === 'planner' || S.tab === 'desk') renderTab();
  });
  store.watch?.(PATHS.exits, (doc) => {
    S.exits = doc?.plans || {};
    if (S.tab === 'desk') renderDesk();
  });
  store.watch?.(PATHS.equity, (doc) => {
    S.equity = doc || { live: [], paper: [] };
    if (S.tab === 'desk') drawEquity();
  });
  store.watchList?.(PATHS.intents, { orderBy: 'createdAt', dir: 'desc', limit: 150 }, (rows) => {
    S.intents = rows;
    renderTabCounts();
    if (S.tab === 'desk') renderDesk();
    if (S.tab === 'ai') renderIntentFeed();
  });
  store.watchList?.(PATHS.cycles, { orderBy: 'at', dir: 'desc', limit: 40 }, (rows) => {
    S.cycles = rows;
    if (!S.busy.cycle) {
      if (S.tab === 'ai') renderRoom();
      if (S.tab === 'desk') renderDesk();
    }
  });
  store.watch?.(`${PATHS.chat}/${todayNY()}`, async () => {
    if (S.streaming) return;
    S.chat = await S.desk.chatHistory(3).catch(() => S.chat);
    renderChat();
  });
  S.chat = await S.desk.chatHistory(3).catch(() => []);
  renderAll();
  await refresh();
  loadScan();
  setInterval(tick, 30_000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
}

/** Account refresh + intent reconciliation + exit monitor. */
async function refresh({ force = false } = {}) {
  if (S.busy.refresh || !S.desk) return;
  S.busy.refresh = true;
  try {
    const snap = await S.desk.snapshot({ force: true });
    S.snap = snap;
    S.snapError = null;
    S.snapAt = Date.now();
    await S.desk.reconcile(snap).catch(() => {});
    const st = marketStatus();
    if (st.session === 'regular') {
      const exits = await S.desk.checkExits({ execute: S.settings.broker !== 'live' || S.settings.execution === 'auto', snap }).catch(() => []);
      for (const e of exits) toast(`Exit rule: ${e.headline} — ${statusText(e.status)}`, e.status === 'blocked' ? 'bad' : '');
    }
  } catch (err) {
    S.snapError = err;
  } finally {
    S.busy.refresh = false;
    renderHeader();
    renderBanners();
    if (S.tab === 'desk') renderDesk();
    if (force) toast('Account refreshed.');
  }
}

let ticks = 0;
function tick() {
  ticks++;
  renderHeader();
  renderBanners();
  const st = marketStatus();
  const every = st.session === 'regular' ? 2 : st.session === 'pre' || st.session === 'post' ? 6 : 20; // ×30s
  if (document.visibilityState === 'visible' && ticks % every === 0) refresh();
  if (S.tab === 'planner') renderPlanner();
}

async function loadScan() {
  if (S.busy.scan || !S.desk) return;
  S.busy.scan = true;
  if (S.tab === 'research') renderResearch();
  try {
    S.scan = await S.desk.scan();
    S.scanError = null;
  } catch (err) {
    S.scanError = err;
  } finally {
    S.busy.scan = false;
    if (S.tab === 'research' || S.tab === 'desk') renderTab();
  }
}

// ------------------------------------------------------------------ shell & header
function renderShell() {
  $('#mode-switch').innerHTML = MODES.map((m) => `<button type="button" role="radio" aria-checked="false" data-act="mode" data-id="${m.id}" style="--c:${m.color}" title="${esc(m.name)}: ${esc(m.tagline)}"><span class="pip"></span><span>${m.level}</span><span class="full">${esc(m.name)}</span></button>`).join('');
  for (const id of ['desk', 'planner', 'research', 'academy', 'settings']) $(`#tab-${id}`).innerHTML = `<div class="panel empty">Loading the desk…</div>`;
}

function renderAll() {
  renderHeader();
  renderBanners();
  renderTabCounts();
  renderTab();
  renderChat();
}

function renderHeader() {
  const st = marketStatus();
  const mins = st.minutesToClose;
  $('#mkt-chip').className = `chip ${st.isOpen ? 'open' : ''}`;
  $('#mkt-chip').innerHTML = `<span class="dot"></span><b>${esc(st.label)}</b>${st.isOpen && mins != null ? ` · ${Math.floor(mins / 60)}h ${mins % 60}m left` : ''}`;
  const s = S.settings;
  if (s) {
    const live = s.broker === 'live';
    const acct = S.snap?.account;
    $('#acct-chip').className = `chip ${live ? 'live' : 'paper'}`;
    $('#acct-chip').innerHTML = `<span class="dot"></span><b>${live ? 'LIVE' : 'PAPER'}</b> ${live ? esc(acct ? `${acct.nickname || 'Robinhood'} ${acct.masked}` : 'Robinhood') : 'simulated money'}${live ? ` · ${s.execution === 'auto' ? 'auto-send' : 'you confirm'}` : ''}`;
    for (const b of $$('#mode-switch button')) b.setAttribute('aria-checked', String(b.dataset.id === s.mode));
  }
  const kill = !!S.state?.killSwitch;
  $('#kill-btn').classList.toggle('on', kill);
  $('#kill-btn').textContent = kill ? 'Trading halted — resume' : 'Halt trading';
}

function renderTabCounts() {
  const ready = S.intents.filter((i) => ['queued', 'proposed', 'needs_review'].includes(i.status)).length;
  const deskTab = $('.tab[data-tab="desk"]');
  deskTab.innerHTML = `Desk${ready ? `<span class="count">${ready}</span>` : ''}`;
}

function renderBanners() {
  const out = [];
  const rt = S.runtime;
  if (!rt) return;
  if (HOSTED && !rt.capabilities.mcp) out.push({ kind: 'bad', html: `<span><b>Robinhood is not connected.</b> ${esc(rt.marketError?.message || '')}</span>` });
  if (HOSTED && !rt.capabilities.sample) out.push({ kind: 'warn', html: '<span><b>Claude is not available here.</b> The agents need the page’s Claude permission. Open the page on claude.ai and allow Claude when asked.</span>' });
  if (!HOSTED && !rt.ai) out.push({ kind: 'warn', html: '<span><b>No Claude API key on the server.</b> Start the server with ANTHROPIC_API_KEY set to use the agents.</span>' });
  if (HOSTED && !rt.hasDb) out.push({ kind: 'warn', html: '<span>The page’s database is unavailable, so plans and journals are saved in this browser only.</span>' });
  if (S.snapError) out.push({ kind: 'bad', html: `<span><b>Account data:</b> ${esc(S.snapError.message)}</span><span class="actions"><button class="btn small" data-act="refresh">Try again</button></span>` });
  if (S.state?.killSwitch) out.push({ kind: 'bad', html: '<span><b>Trading is halted.</b> The desk will not open new positions. Closing orders and exits still work.</span><span class="actions"><button class="btn small" data-act="kill">Resume trading</button></span>' });
  if (S.settings?.broker === 'paper' && rt.brokers?.live) out.push({ kind: 'info', html: '<span><b>Paper mode.</b> The desk is practicing with simulated money at real prices. Switch to your live agentic account in Settings when you are ready.</span><span class="actions"><button class="btn small" data-act="goto" data-id="settings">Settings</button></span>' });
  const ready = S.intents.filter((i) => ['queued', 'proposed', 'needs_review'].includes(i.status));
  if (ready.length) out.push({ kind: 'info', html: `<span><b>${ready.length} order${ready.length > 1 ? 's' : ''} waiting for you.</b> ${esc(ready.slice(0, 3).map((i) => i.headline).join(' · '))}</span><span class="actions"><button class="btn small primary" data-act="goto" data-id="desk">Review</button></span>` });
  const appr = S.snap?.approvals || [];
  if (appr.length) out.push({ kind: 'warn', html: `<span><b>${appr.length} order${appr.length > 1 ? 's' : ''} waiting for your approval in the Robinhood app.</b> Approve or decline them there; they expire on their own.</span>` });
  if (S.ready && rt.ai && !S.busy.cycle) {
    const due = dueSlot(new Date(), S.state?.lastCycle?.at || 0);
    if (due) out.push({ kind: 'info', html: `<span><b>${esc(due.name)} (${label12(due.time)}) is due.</b> ${esc(due.what)}</span><span class="actions"><button class="btn small primary" data-act="run-cycle" data-id="${due.kind}">Run it now</button></span>` });
  }
  $('#banners').innerHTML = out.map((b) => `<div class="banner ${b.kind}">${b.html}</div>`).join('');
}

function setTab(tab) {
  S.tab = tab;
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of $$('.view')) v.classList.toggle('active', v.id === `tab-${tab}`);
  renderTab();
  try {
    localStorage.setItem('crowsnest:tab', tab);
  } catch {
    /* ignore */
  }
}

function renderTab() {
  if (!S.ready) return;
  ({ desk: renderDesk, ai: renderAI, planner: renderPlanner, research: renderResearch, academy: renderAcademy, settings: renderSettings })[S.tab]?.();
}

// ------------------------------------------------------------------ DESK (front page)
function renderDesk() {
  const el = $('#tab-desk');
  const snap = S.snap;
  const p = snap?.portfolio;
  const live = S.settings?.broker === 'live';
  const kpis = `<div class="kpis">
    <div class="kpi big"><span class="label">Account value</span><strong>${p ? money(p.equity) : '—'}</strong><small>${live ? esc(`${snap?.account?.nickname || 'Robinhood'} ${snap?.account?.masked || ''}`) : 'Paper account'}</small></div>
    <div class="kpi"><span class="label">Today</span><strong class="${signCls(p?.dayChange)}">${p ? money(p.dayChange, { sign: true }) : '—'}</strong><small class="${signCls(p?.dayChange)}">${p ? pct(p.dayChangePct) : ''}</small></div>
    <div class="kpi"><span class="label">Buying power</span><strong>${p ? money(p.buyingPower) : '—'}</strong><small>cash ${p ? money(p.cash) : '—'}</small></div>
    <div class="kpi"><span class="label">Unrealized P/L</span><strong class="${signCls(p?.unrealized)}">${p ? money(p.unrealized, { sign: true }) : '—'}</strong><small>open positions</small></div>
    <div class="kpi"><span class="label">Positions</span><strong>${snap ? snap.stocks.length + snap.options.length : '—'}</strong><small>${snap ? `${snap.stocks.length} stock · ${snap.options.length} option` : ''}</small></div>
    <div class="kpi"><span class="label">Mode</span><strong style="color:${modeById(S.settings.mode).color}">${esc(modeById(S.settings.mode).name)}</strong><small style="font-family:var(--font-body)">${modeById(S.settings.mode).level}/5 · ${esc(modeById(S.settings.mode).tagline)}</small></div>
  </div>`;
  el.innerHTML = `${kpis}
  <div class="grid-desk">
    <div class="stack">
      <div class="panel">${planPanel()}</div>
      <div class="panel">${positionsPanel()}</div>
      <div class="panel">${ordersPanel()}</div>
      <div class="panel">${historyPanel()}</div>
    </div>
    <div class="stack">
      <div class="panel">${honchoCard()}</div>
      <div class="panel">${regimeCard()}</div>
      <div class="panel"><div class="panel-head"><h2>Account value</h2><span class="tools faint">${S.snapAt ? `updated ${ago(S.snapAt)}` : ''} <button class="link" data-act="refresh">Refresh</button></span></div><canvas id="equity-canvas"></canvas></div>
      <div class="panel">${nextCheckCard()}</div>
    </div>
  </div>`;
  drawEquity();
}

function drawEquity() {
  const c = $('#equity-canvas');
  if (!c) return;
  const pts = (S.equity?.[S.settings?.broker === 'live' ? 'live' : 'paper'] || []).slice();
  if (S.snap?.portfolio?.equity != null) pts.push([Date.now(), S.snap.portfolio.equity]);
  equityChart(c, pts);
}

function intentSortKey(i) {
  const order = { needs_review: 0, queued: 1, proposed: 1, pending_approval: 2, working: 3, sent: 3, planned: 4, watching: 5, filled: 6, blocked: 7, vetoed: 7, failed: 7, rejected: 7, skipped: 8 };
  return (order[i.status] ?? 9) * 1e13 - i.createdAt / 1000;
}

function planPanel() {
  const today = todayNY();
  const items = S.intents
    .filter((i) => ACTIVE.has(i.status) || (todayNY(new Date(i.createdAt)) === today && i.status !== 'expired'))
    .sort((a, b) => intentSortKey(a) - intentSortKey(b))
    .slice(0, 30);
  const live = S.settings.broker === 'live';
  const head = `<div class="panel-head"><h2>Buy / sell plan</h2><span class="tools">${S.busy.cycle ? '<span class="muted">Agents working…</span>' : `<button class="btn primary small" data-act="run-cycle" data-id="manual" ${S.runtime?.ai ? '' : 'disabled'}>Run a cycle now</button>`}</span><span class="sub">Every idea the desk has right now. Open the arrow for the full reasoning and the risk checks.${live && S.settings.execution !== 'auto' ? ' Nothing goes to Robinhood until you press Send.' : ''}</span></div>`;
  if (!items.length)
    return `${head}<div class="empty">No buy or sell ideas yet today.<br>Press <b>Run a cycle now</b> and the four agents will read the market, decide, and post their plan here.</div>`;
  return `${head}<div class="rows">${items.map(intentRow).join('')}</div>`;
}

function sideTag(i) {
  if (['watching', 'planned'].includes(i.status) && !i.ticket) return '<span class="side-tag watch">WATCH</span>';
  const t = i.ticket;
  if (!t) return `<span class="side-tag ${i.action === 'close' || i.action === 'trim' ? 'sell' : 'buy'}">${i.action === 'close' ? 'SELL' : i.action === 'trim' ? 'TRIM' : 'BUY'}</span>`;
  const sell = t.kind === 'stock' ? t.side === 'sell' : t.positionEffect === 'close' || t.direction === 'credit';
  const label = t.kind === 'option' ? (t.positionEffect === 'close' ? 'CLOSE' : t.direction === 'credit' ? 'SELL OPT' : 'BUY OPT') : sell ? 'SELL' : 'BUY';
  return `<span class="side-tag ${sell ? 'sell' : 'buy'}">${label}</span>`;
}

function intentRow(i) {
  const key = `intent:${i.id}`;
  const open = S.open.has(key);
  const right = i.gate?.cost ? money(i.gate.cost) : i.sizePct ? `${i.sizePct}%` : '';
  return `<div class="row ${open ? 'open' : ''}">
    <div class="row-main" data-act="toggle" data-id="${esc(key)}">
      <button class="arrow" aria-label="Show reasoning" aria-expanded="${open}">▶</button>
      <div class="row-title"><span class="t">${sideTag(i)}${esc(i.headline || `${i.action} ${i.symbol}`)}</span><span class="s"><span class="st ${esc(i.status)}">${esc(statusText(i.status))}</span> ${esc(firstSentence(i.why))}</span></div>
      <div class="row-right">${esc(right)}<small class="conv">${conv(i.conviction)}</small></div>
    </div>
    ${open ? `<div class="row-detail">${intentDetail(i)}</div>` : ''}
  </div>`;
}

function firstSentence(t = '') {
  const s = String(t || '');
  const m = s.match(/^.{0,140}?[.!?](\s|$)/);
  return m ? m[0].trim() : s.slice(0, 140);
}

function ticketText(t) {
  if (!t) return '—';
  if (t.kind === 'stock') return `${t.side === 'buy' ? 'Buy' : 'Sell'} ${t.dollars ? money(t.dollars) + ' of' : `${qty(t.quantity)} share${t.quantity === 1 ? '' : 's'} of`} ${t.symbol}, ${t.orderType.replace('_', ' ')}${t.limitPrice ? ` at ${money(t.limitPrice)}` : ''}${t.stopPrice ? `, stop ${money(t.stopPrice)}` : ''}, ${t.tif === 'gtc' ? 'good till canceled' : 'day order'}${t.marketHours === 'extended_hours' ? ', extended hours' : ''}.`;
  const legs = (t.legs || []).map((l) => `${l.side === 'buy' ? 'buy' : 'sell'} ${contractLabel({ ...l, symbol: t.symbol })} (${l.positionEffect})`).join(' + ');
  return `${STRATEGIES[t.strategy]?.name || t.strategy}: ${legs}; ${t.quantity} × limit ${money(t.price)} ${t.direction || ''} (≈ ${money((t.price || 0) * 100 * (t.quantity || 0))}), ${t.tif === 'gtc' ? 'GTC' : 'day order'}.`;
}

function checksList(checks = []) {
  if (!checks.length) return '<p class="muted">No checks recorded.</p>';
  const icon = { block: '✕', warn: '!', info: '✓' };
  return `<ul class="checks">${checks.map((c) => `<li class="${c.level === 'block' && !c.ok ? 'block' : c.level === 'warn' ? 'warn' : 'ok'}"><span class="ic">${icon[c.level === 'info' || c.ok && c.level !== 'warn' ? 'info' : c.level]}</span><span><b>${esc(c.label)}</b> — ${esc(c.detail)}</span></li>`).join('')}</ul>`;
}

function intentDetail(i) {
  const r = i.research || {};
  const sc = r.scout;
  const an = r.analyst;
  const ex = i.exit || i.ticket?.exit;
  const live = i.live;
  const canSend = SENDABLE.has(i.status) && i.ticket && i.gate?.decision !== 'block';
  const explain = S.explains[i.id];
  return `
    <div class="box"><h4>Why — Head Honcho</h4><p>${esc(i.why || '—')}</p>${i.teach ? `<p class="muted" style="margin-top:6px">Lesson: ${esc(i.teach)}</p>` : ''}${i.trigger ? `<p style="margin-top:6px"><b>Trigger:</b> ${esc(i.trigger)}</p>` : ''}</div>
    <div class="detail-grid">
      ${sc ? `<div class="box"><h4 style="color:var(--agent-scout)">Scout · charts</h4><p><b>${esc(sc.setup || '')}</b> (${esc(sc.confidence ?? '?')}%)</p><p class="muted">${esc(sc.why || '')}</p><p class="mono" style="font-size:12px">entry ${esc(sc.entry ?? '—')} · stop ${esc(sc.stop ?? '—')} · target ${esc(sc.target ?? '—')}</p></div>` : ''}
      ${an ? `<div class="box"><h4 style="color:var(--agent-analyst)">Analyst · options & catalysts</h4><p><b>${esc(STRATEGIES[an.vehicle]?.name || an.vehicle || '')}</b> (${esc(an.confidence ?? '?')}%) · IV ${esc(an.ivView || '?')}</p><p class="muted">${esc(an.why || '')}</p>${an.catalyst ? `<p style="font-size:12px">Catalyst: ${esc(an.catalyst)}</p>` : ''}</div>` : ''}
      ${r.technical ? `<div class="box"><h4>Technical read</h4><p class="muted">${esc(r.technical)}</p></div>` : ''}
    </div>
    <div class="detail-grid">
      <div class="box"><h4 style="color:var(--agent-operator)">Order — Operator</h4><p>${esc(ticketText(i.ticket))}</p>${i.operatorNote ? `<p class="muted" style="margin-top:4px">${esc(i.operatorNote)}</p>` : ''}${(i.draftNotes || []).length ? `<p class="muted" style="margin-top:4px">${esc(i.draftNotes.join(' '))}</p>` : ''}${i.vetoReason ? `<p class="down" style="margin-top:4px">${esc(i.vetoReason)}</p>` : ''}</div>
      ${i.ticket?.positionEffect === 'close' ? '' : `<div class="box"><h4>Exit plan</h4><p>${ex ? `Stop <b class="mono">${ex.stop != null ? esc(ex.stop) : '—'}</b> · Target <b class="mono">${ex.target != null ? esc(ex.target) : '—'}</b>${ex.timeStop ? ` · Time stop ${esc(ex.timeStop)}` : ''}` : 'None set'}</p><p class="muted" style="font-size:12px">${ex?.basis === 'option_premium' ? 'Levels are the option’s price per share.' : 'Levels are the stock price.'}</p></div>`}
    </div>
    ${i.gate ? `<div class="box"><h4>Risk gate — ${esc(i.gate.decision)}</h4>${checksList(i.gate.checks)}</div>` : ''}
    ${i.broker?.alerts?.length || i.broker?.message ? `<div class="box"><h4>Robinhood</h4>${(i.broker.alerts || []).map((a) => `<p class="warnc">${esc(a)}</p>`).join('')}${i.broker.message ? `<p>${esc(i.broker.message)}</p>` : ''}</div>` : ''}
    ${explain ? `<div class="box"><h4>In plain English</h4><p class="prose">${esc(explain)}</p></div>` : ''}
    <div class="actions-row">
      ${canSend ? `<button class="btn buy" data-act="send-intent" data-id="${esc(i.id)}">${live ? 'Send to Robinhood' : 'Send (paper)'}</button>` : ''}
      ${ACTIVE.has(i.status) ? `<button class="btn ghost" data-act="dismiss-intent" data-id="${esc(i.id)}">${['sent', 'working'].includes(i.status) ? 'Cancel order' : 'Dismiss'}</button>` : ''}
      <button class="btn ghost" data-act="explain" data-id="${esc(i.id)}" ${S.runtime?.ai ? '' : 'disabled'}>Explain like I’m new</button>
      <button class="btn ghost" data-act="ask-about" data-id="${esc(i.symbol)}">Ask the Head Honcho</button>
      <span class="faint" style="align-self:center;font-size:12px">${esc(sourceLabel(i))} · ${esc(dateNY(i.createdAt))} ${esc(timeNY(i.createdAt))}</span>
    </div>`;
}

function sourceLabel(i) {
  return { cycle: 'From a desk cycle', exit: 'Exit rule (code)', chat: 'From chat', owner: 'You', autopilot: 'Background autopilot' }[i.source] || i.source || '';
}

function positionsPanel() {
  const snap = S.snap;
  const head = `<div class="panel-head"><h2>Positions</h2><span class="sub">Stocks and option contracts the account holds now, with each one’s exit plan.</span></div>`;
  if (!snap) return `${head}<div class="empty">${S.snapError ? esc(S.snapError.message) : 'Loading positions…'}</div>`;
  if (!snap.stocks.length && !snap.options.length) return `${head}<div class="empty">No open positions. ${S.settings.broker === 'live' ? 'Your agentic account is all cash.' : 'The paper account is all cash.'}</div>`;
  const rows = [
    ...snap.stocks.map((s) => ({ key: `pos:${s.symbol}`, title: `${s.symbol}`, sub: `${qty(s.qty)} share${s.qty === 1 ? '' : 's'} · avg ${money(s.avgCost)} · now ${money(s.price)}`, value: s.value, pl: s.pl, plPct: s.plPct, item: s, kind: 'stock' })),
    ...snap.options.map((o) => ({ key: `pos:${o.id}`, title: contractLabel(o), sub: `${o.qty > 0 ? 'Long' : 'Short'} ${Math.abs(o.qty)} contract${Math.abs(o.qty) === 1 ? '' : 's'} · avg ${money(o.avgPrice)} · mark ${money(o.mark)}${o.expiration ? ` · ${daysBetween(todayNY(), o.expiration)}d left` : ''}`, value: o.value, pl: o.pl, plPct: o.plPct, item: o, kind: 'option' })),
  ];
  return `${head}<div class="rows">${rows
    .map((r) => {
      const open = S.open.has(r.key);
      return `<div class="row ${open ? 'open' : ''}"><div class="row-main" data-act="toggle" data-id="${esc(r.key)}"><button class="arrow" aria-label="Show details" aria-expanded="${open}">▶</button><div class="row-title"><span class="t">${esc(r.title)}</span><span class="s">${esc(r.sub)}</span></div><div class="row-right">${money(r.value)}<small class="${signCls(r.pl)}">${money(r.pl, { sign: true })} (${pct(r.plPct)})</small></div></div>${open ? `<div class="row-detail">${positionDetail(r)}</div>` : ''}</div>`;
    })
    .join('')}</div>`;
}

function positionDetail(r) {
  const key = r.kind === 'stock' ? r.item.symbol : r.item.id;
  const plan = S.exits[key];
  const sym = r.item.symbol;
  const intent = S.intents.find((i) => i.symbol === sym && i.action === 'open' && ['filled', 'sent', 'pending_approval', 'working'].includes(i.status) && (r.kind === 'stock' ? i.ticket?.kind === 'stock' : i.ticket?.legs?.some((l) => l.contractId === key)));
  const a = S.scan?.analyses?.[sym];
  return `<div class="detail-grid">
      <div class="box"><h4>Exit plan</h4><p>${plan ? `Stop <b class="mono">${esc(plan.stop ?? '—')}</b> · Target <b class="mono">${esc(plan.target ?? '—')}</b>${plan.timeStop ? ` · Time stop ${esc(plan.timeStop)}` : ''}` : 'No exit plan yet: the mode’s default stop applies.'}</p>${plan?.note ? `<p class="muted">${esc(plan.note)}</p>` : ''}<p style="margin-top:6px"><button class="link" data-act="edit-exit" data-id="${esc(key)}" data-kind="${r.kind}">Edit stop / target</button></p></div>
      <div class="box"><h4>Today</h4><p class="${signCls(r.item.dayPl)}">${money(r.item.dayPl, { sign: true })}</p>${r.kind === 'option' ? `<p class="muted" style="font-size:12px">Δ ${esc(r.item.delta ?? '—')} · IV ${r.item.iv ? round(r.item.iv * 100, 1) + '%' : '—'} · bid ${money(r.item.bid)} / ask ${money(r.item.ask)}</p>` : ''}</div>
      ${a ? `<div class="box"><h4>Technical read</h4><p class="muted">${esc(a.summary)}</p></div>` : ''}
    </div>
    ${intent ? `<div class="box"><h4>Why the desk bought it</h4><p>${esc(intent.why || '')}</p><p class="muted" style="font-size:12px">${esc(dateNY(intent.createdAt))} · ${esc(intent.headline)}</p></div>` : ''}
    <div class="actions-row">
      <button class="btn sell small" data-act="close-pos" data-id="${esc(sym)}" data-contract="${r.kind === 'option' ? esc(key) : ''}">Close position</button>
      ${r.kind === 'stock' || Math.abs(r.item.qty) > 1 ? `<button class="btn ghost small" data-act="trim-pos" data-id="${esc(sym)}" data-contract="${r.kind === 'option' ? esc(key) : ''}">Trim half</button>` : ''}
      <button class="btn ghost small" data-act="research" data-id="${esc(sym)}">Open in Research</button>
    </div>`;
}

function ordersPanel() {
  const orders = S.snap?.openOrders || [];
  const head = `<div class="panel-head"><h2>Working orders</h2><span class="sub">Orders sent to ${S.settings.broker === 'live' ? 'Robinhood' : 'the paper broker'} that have not filled yet.</span></div>`;
  if (!orders.length) return `${head}<div class="empty">No working orders.</div>`;
  return `${head}<div class="table-wrap"><table class="data"><thead><tr><th>Placed</th><th>Order</th><th>State</th><th class="r">Limit</th><th></th></tr></thead><tbody>${orders
    .map((o) => `<tr><td>${esc(timeNY(Date.parse(o.createdAt)))}</td><td>${esc(orderText(o))}${o.agent ? ' <span class="faint">· agent</span>' : ''}</td><td>${esc(o.state)}</td><td class="r">${o.price ? money(o.price) : 'mkt'}</td><td><button class="btn small ghost" data-act="cancel-order" data-id="${esc(o.id)}" data-kind="${esc(o.kind)}">Cancel</button></td></tr>`)
    .join('')}</tbody></table></div>`;
}

function orderText(o) {
  if (o.kind === 'option') {
    const legs = (o.legs || []).map((l) => `${l.side} ${contractLabel({ ...l, symbol: o.symbol })}`).join(' / ');
    return `${legs || o.symbol} ×${qty(o.qty)}`;
  }
  return `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.dollars ? money(o.dollars) : `${qty(o.qty)} sh`} ${o.symbol}${o.type && o.type !== 'market' ? ` (${o.type.replace('_', ' ')})` : ''}`;
}

function historyPanel() {
  const snap = S.snap;
  const head = `<div class="panel-head"><h2>Trade history</h2><span class="sub">Filled orders from the last 30 days and realized profit or loss. Agent trades link to their reasoning.</span></div>`;
  if (!snap) return `${head}<div class="empty">Loading…</div>`;
  const filled = (snap.orders || []).filter((o) => o.state === 'filled').slice(0, 25);
  if (!filled.length && !(snap.realized || []).length) return `${head}<div class="empty">No trades yet.</div>`;
  const realizedTotal = (snap.realized || []).reduce((a, r) => a + (r.gain || 0), 0);
  const rows = filled
    .map((o) => {
      const key = `hist:${o.id}`;
      const open = S.open.has(key);
      const intent = S.intents.find((i) => i.id === o.refId || i.broker?.orderId === o.id);
      const value = (o.avgPrice || 0) * (o.filledQty || 0) * (o.kind === 'option' ? 100 : 1);
      return `<div class="row ${open ? 'open' : ''}"><div class="row-main" data-act="toggle" data-id="${esc(key)}"><button class="arrow" aria-label="Show details" aria-expanded="${open}">▶</button><div class="row-title"><span class="t"><span class="side-tag ${o.side === 'sell' || o.positionEffect === 'close' ? 'sell' : 'buy'}">${o.side === 'sell' || o.positionEffect === 'close' ? 'SELL' : 'BUY'}</span>${esc(orderText(o))}</span><span class="s">${esc(dateNY(Date.parse(o.updatedAt || o.createdAt)))} · ${o.agent || intent ? 'agent' : 'you'}${intent ? ' · reasoning saved' : ''}</span></div><div class="row-right">${money(value)}<small>@ ${money(o.avgPrice)}</small></div></div>${
        open ? `<div class="row-detail">${intent ? `<div class="box"><h4>Why</h4><p>${esc(intent.why || '—')}</p></div>` : '<p class="muted">Placed outside Crow’s Nest or before it started tracking reasoning.</p>'}<p class="faint">Order ${esc(o.id)}</p></div>` : ''
      }</div>`;
    })
    .join('');
  const realized = (snap.realized || []).slice(0, 12);
  return `${head}<div class="rows">${rows}</div>${realized.length ? `<h3 class="label" style="margin:16px 0 6px">Realized P/L (30 days): <span class="${signCls(realizedTotal)}">${money(realizedTotal, { sign: true })}</span></h3><div class="table-wrap"><table class="data"><tbody>${realized.map((r) => `<tr><td>${esc(new Date(r.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</td><td>${esc(r.symbol)}</td><td>${esc(r.side)} ${esc(qty(r.qty))}</td><td class="r ${signCls(r.gain)}">${money(r.gain, { sign: true })}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}

function honchoCard() {
  const c = S.cycles.find((x) => x.status === 'done' && x.headline) || S.cycles[0];
  if (!c) return `<div class="say"><span class="label">Head Honcho</span><p class="headline">No cycles yet.</p><p class="muted">When the desk runs, its summary of what it sees and what it is doing shows here.</p></div>`;
  return `<div class="say"><span class="label">Head Honcho · ${esc(c.kind)} · ${esc(dateNY(c.at))} ${esc(timeNY(c.at))}</span><p class="headline">${esc(c.headline || (c.status === 'error' ? 'Cycle failed' : 'Cycle'))}</p><p>${esc(c.summary || c.error || '')}</p>${c.messageToOwner ? `<p class="warnc"><b>For you:</b> ${esc(c.messageToOwner)}</p>` : ''}<button class="link" data-act="open-room" data-id="${esc(c.id)}">See the agent conversation →</button></div>`;
}

function regimeCard() {
  const r = S.scan?.regime || S.cycles.find((c) => c.regime)?.regime;
  if (!r) return `<div class="panel-head"><h2>Market regime</h2></div><div class="empty">${S.busy.scan ? 'Reading the market…' : S.scanError ? esc(S.scanError.message) : 'Not loaded yet.'}</div>`;
  return `<div class="panel-head"><h2>Market regime</h2><span class="tools"><button class="link" data-act="goto" data-id="research">Details</button></span></div>${gaugeSVG(r.score)}<div class="regime-label">${esc(r.label)} <span class="mono" style="font-size:15px">${r.score > 0 ? '+' : ''}${r.score}</span></div><p class="muted" style="text-align:center;margin:4px 0 0;font-size:12.5px">Volatility ${esc(r.volatility || '—')}${r.breadth != null ? ` · ${r.breadth}% above 50-day` : ''}</p><p style="font-size:13px;margin:10px 0 0">${esc(r.posture || '')}</p>`;
}

function nextCheckCard() {
  const n = nextSlot();
  const last = S.state?.lastCycle;
  return `<div class="panel-head"><h2>Next check-in</h2><span class="tools"><button class="link" data-act="goto" data-id="planner">Planner</button></span></div>${n ? `<p style="margin:0"><b>${esc(n.name)}</b> · ${esc(n.iso === todayNY() ? 'today' : fmtDateNY(n.iso + 'T16:00:00Z', { weekday: 'short', month: 'short', day: 'numeric' }))} ${esc(label12(n.time))} ET</p><p class="muted" style="margin:4px 0 0">${esc(n.what)}</p>` : ''}${last ? `<p class="faint" style="margin:10px 0 0;font-size:12px">Last cycle: ${esc(last.kind)} ${esc(ago(last.at))}${last.headline ? ` — ${esc(last.headline)}` : ''}</p>` : ''}`;
}

// ------------------------------------------------------------------ AI DESK
function renderAI() {
  renderChat();
  renderRoom();
  renderIntentFeed();
}

const SUGGESTIONS = ['What’s the plan for today?', 'Why did you make your last trade?', 'How is the account doing?', 'What are you watching this week?', 'Be more careful this week.', 'Explain the current market like I’m new.'];

function renderChat() {
  const log = $('#chat-log');
  if (!log) return;
  const msgs = S.chat.filter((m) => (m.channel || 'desk') === 'desk');
  const html = msgs.map((m) => `<div class="msg ${m.role === 'owner' ? 'owner' : 'honcho'}">${m.role === 'owner' ? '' : '<span class="who">Head Honcho</span>'}${esc(m.text)}</div>`);
  if (S.streaming) html.push(`<div class="msg owner">${esc(S.streaming.q)}</div><div class="msg honcho ${S.streaming.text ? '' : 'thinking'}"><span class="who">Head Honcho</span>${esc(S.streaming.text || 'Thinking…')}</div>`);
  if (!html.length) html.push(`<div class="empty">Say hello to the Head Honcho. It sees your account, positions, plan and the latest cycle, can look up live prices and charts, and can queue trades for you to send.</div>`);
  log.innerHTML = html.join('');
  log.scrollTop = log.scrollHeight;
  $('#chat-suggest').innerHTML = SUGGESTIONS.map((s) => `<button type="button" data-act="suggest" data-id="${esc(s)}">${esc(s)}</button>`).join('');
  $('#chat-send').disabled = !!S.streaming || !S.runtime?.ai;
  $('#chat-stop').hidden = !S.streaming;
}

let chatCtl = null;
async function sendChat(text) {
  text = text.trim();
  if (!text || S.streaming || !S.desk) return;
  if (!S.runtime?.ai) return toast('Claude is not available in this view.', 'bad');
  $('#chat-input').value = '';
  S.streaming = { q: text, text: '' };
  renderChat();
  chatCtl = new AbortController();
  try {
    await S.desk.chat(text, {
      signal: chatCtl.signal,
      onText: ({ text: t }) => {
        S.streaming.text = t;
        const last = $('#chat-log .msg.honcho:last-child');
        if (last) {
          last.classList.remove('thinking');
          last.innerHTML = `<span class="who">Head Honcho</span>${esc(t)}`;
          $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
        }
      },
    });
  } catch (err) {
    if (err.code !== 'cancelled') toast(aiErrorText(err), 'bad');
  } finally {
    S.streaming = null;
    S.chat = await S.desk.chatHistory(3).catch(() => S.chat);
    renderChat();
  }
}

function renderRoom() {
  const controls = $('#room-controls');
  const feed = $('#room-feed');
  if (!controls) return;
  const steps = ['system', 'scout', 'analyst', 'honcho', 'operator', 'gate'];
  const prog = S.progress;
  const stepper = prog ? `<div class="steps">${steps.map((s) => `<span class="step ${prog.done.has(s) ? 'done' : prog.active.has(s) ? 'active' : ''}" style="--c:${AGENT_COLORS[s]}">${esc(AGENT_NAMES[s])}</span>`).join('')}</div>` : '';
  const options = S.cycles.map((c) => `<option value="${esc(c.id)}" ${c.id === (S.roomCycleId || S.cycles[0]?.id) ? 'selected' : ''}>${esc(dateNY(c.at))} ${esc(timeNY(c.at))} · ${esc(c.kind)}${c.source === 'autopilot' ? ' · autopilot' : ''} · ${esc((c.headline || c.status || '').slice(0, 60))}</option>`).join('');
  controls.innerHTML = `<div class="cycle-pick">${S.busy.cycle ? '<span class="muted">Cycle running…</span><button class="btn small ghost" data-act="stop-cycle">Stop</button>' : `<select id="cycle-select" aria-label="Choose a cycle">${options || '<option>No cycles yet</option>'}</select><select id="cycle-kind" aria-label="Cycle type"><option value="manual">Right-now check</option><option value="premarket">Pre-market briefing</option><option value="weekly">Weekly game plan</option><option value="power">Power hour</option><option value="close">Close review</option></select><button class="btn primary small" data-act="run-cycle-pick" ${S.runtime?.ai ? '' : 'disabled'}>Run</button>`}</div>${stepper}`;
  let msgs;
  if (S.busy.cycle) msgs = S.liveMessages;
  else {
    const c = S.cycles.find((x) => x.id === S.roomCycleId) || S.cycles[0];
    msgs = c?.messages || [];
  }
  if (!msgs.length) {
    feed.innerHTML = `<div class="empty">The agents talk here while they work. Run a cycle to watch Scout and Analyst report, the Head Honcho decide, the Operator build orders, and the risk gate check them.</div>`;
    return;
  }
  feed.innerHTML = msgs
    .map((m) => `<div class="agent-msg" style="--c:${AGENT_COLORS[m.agent] || 'var(--faint)'}"><div class="avatar">${AGENT_INITIALS[m.agent] || '··'}</div><div class="bubble"><div class="meta"><b>${esc(AGENT_NAMES[m.agent] || m.agent)}</b><span class="faint">${esc(timeNY(m.at))}</span></div>${m.title ? `<div class="title">${esc(m.title)}</div>` : ''}<div class="body">${esc(m.text || '')}</div></div></div>`)
    .join('');
  if (S.busy.cycle) feed.scrollTop = feed.scrollHeight;
}

function renderIntentFeed() {
  const el = $('#intent-feed');
  if (!el) return;
  const f = S.intentFilter;
  const list = S.intents
    .filter((i) => (f === 'active' ? ACTIVE.has(i.status) : f === 'done' ? ['filled', 'sent', 'pending_approval', 'working'].includes(i.status) : f === 'blocked' ? ['blocked', 'vetoed', 'rejected', 'failed', 'skipped'].includes(i.status) : true))
    .slice(0, 40);
  const byDay = {};
  for (const c of S.cycles.filter((c) => c.status === 'done' || c.status === 'error')) (byDay[dateNY(c.at)] ||= []).push(c);
  el.innerHTML = `<div class="filters">${[['active', 'Active'], ['done', 'Sent & filled'], ['blocked', 'Blocked'], ['all', 'All']].map(([k, l]) => `<button data-act="intent-filter" data-id="${k}" class="${f === k ? 'on' : ''}">${l}</button>`).join('')}</div>
  <div class="rows">${list.length ? list.map(intentRow).join('') : '<div class="empty">Nothing here yet.</div>'}</div>
  <h3 class="label" style="margin-top:18px">Journal</h3>
  ${Object.keys(byDay).length ? Object.entries(byDay).slice(0, 7).map(([day, cs]) => `<div class="journal-day"><h3>${esc(day)}</h3>${cs.map((c) => `<div class="journal-entry"><div class="when">${esc(timeNY(c.at))} · ${esc(c.kind)}${c.regime ? ` · ${esc(c.regime.label)}` : ''}</div><div class="hl">${esc(c.headline || (c.status === 'error' ? 'Cycle failed' : ''))}</div><p>${esc(c.summary || c.error || '')}</p><button class="link" data-act="open-room" data-id="${esc(c.id)}">Agent conversation</button></div>`).join('')}</div>`).join('') : '<div class="empty">The journal fills in as cycles run.</div>'}`;
}

let cycleCtl = null;
async function runCycle(kind = 'manual') {
  if (S.busy.cycle || !S.desk) return;
  if (!S.runtime?.ai) return toast('Claude is not available in this view.', 'bad');
  S.busy.cycle = true;
  S.liveMessages = [];
  S.progress = { active: new Set(['system']), done: new Set() };
  cycleCtl = new AbortController();
  if (S.tab !== 'ai') setTab('ai');
  renderRoom();
  renderBanners();
  try {
    const cycle = await S.desk.runCycle(kind, {
      signal: cycleCtl.signal,
      onStep: (agent, m) => {
        const P = S.progress;
        if (!m.at) P.active.add(agent); // an agent started working
        else {
          S.liveMessages.push(m);
          if (agent === 'system' && m.title === 'Data gathered') P.done.add('system');
          if (['scout', 'analyst', 'honcho', 'operator'].includes(agent)) {
            P.done.add(agent);
            P.active.delete(agent);
          }
          if (agent === 'gate') {
            P.done.add('operator');
            P.active.delete('operator');
            P.active.add('gate');
          }
        }
        if (P.active.has('scout') || P.active.has('analyst')) {
          P.done.add('system');
          P.active.delete('system');
        }
        renderRoom();
      },
    });
    S.roomCycleId = cycle.id;
    if (cycle.status === 'done') toast(cycle.headline || 'Cycle complete.', 'good');
    else if (cycle.status === 'error') toast(cycle.error, 'bad');
  } finally {
    S.busy.cycle = false;
    S.progress = null;
    await refresh();
    S.cycles = await S.desk.listCycles(40).catch(() => S.cycles);
    renderAll();
  }
}

// ------------------------------------------------------------------ PLANNER
function renderPlanner() {
  const el = $('#tab-planner');
  const plan = S.plan || {};
  const week = plan.week || {};
  const today = plan.today || {};
  const iso = todayNY();
  const earnings = [];
  const focusSyms = [...(week.focus || []).map((f) => f.symbol), ...(S.snap?.stocks || []).map((s) => s.symbol), ...(S.settings?.watchlist || [])];
  const evDays = weekEvents(iso, { earnings: S.earningsCache || earnings, focusSymbols: focusSyms });
  if (!S.earningsCache && S.desk && !S.loadingEarnings) {
    S.loadingEarnings = true;
    S.desk.earningsList().then((l) => {
      S.earningsCache = l;
      if (S.tab === 'planner') renderPlanner();
    }).catch(() => {});
  }
  const aiDays = Object.fromEntries((week.days || []).map((d) => [d.day, d]));
  const tl = todayTimeline({ aiSchedule: today.schedule || [], cycles: S.cycles });
  const next = nextSlot();
  el.innerHTML = `
  <div class="panel" style="margin-bottom:14px">
    <div class="panel-head"><h2>This week${week.weekOf ? ` · week of ${esc(fmtDateNY(week.weekOf + 'T16:00:00Z'))}` : ''}</h2><span class="tools"><button class="btn small primary" data-act="run-cycle" data-id="weekly" ${S.runtime?.ai ? '' : 'disabled'}>Build the weekly plan</button></span><span class="sub">The Head Honcho’s plan for each day, with market events and earnings for the names the desk follows.</span></div>
    <div class="week">${evDays
      .map((d) => {
        const ai = aiDays[d.day] || {};
        return `<div class="day ${d.iso === iso ? 'today' : ''} ${d.trading ? '' : 'closed'}"><h3>${esc(d.day)} <small>${esc(d.iso.slice(5).replace('-', '/'))}</small></h3>${d.events.map((e) => `<div class="ev ${e.severity}">${esc(e.text)}</div>`).join('')}${ai.theme ? `<div class="theme">${esc(ai.theme)}</div>` : ''}${ai.plan ? `<p class="plan">${esc(ai.plan)}</p>` : !d.events.length ? '<p class="plan faint">No plan yet.</p>' : ''}</div>`;
      })
      .join('')}</div>
  </div>
  <div class="grid-2">
    <div class="stack">
      <div class="panel"><div class="panel-head"><h2>Weekly thesis</h2>${week.createdAt ? `<span class="tools faint">${esc(ago(week.createdAt))}</span>` : ''}</div>${week.thesis ? `<p style="margin:0 0 8px">${esc(week.thesis)}</p>${week.riskBudget ? `<p class="muted" style="margin:0">Risk budget: ${esc(week.riskBudget)}</p>` : ''}` : '<div class="empty">No weekly plan yet. Press <b>Build the weekly plan</b>; the desk also builds one every Sunday evening when the autopilot is on.</div>'}</div>
      <div class="panel"><div class="panel-head"><h2>Focus list</h2><span class="sub">The names the team expects to trade this week, with levels.</span></div>${(week.focus || []).length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Symbol</th><th>Bias</th><th>Setup</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">Target</th></tr></thead><tbody>${week.focus.map((f) => `<tr class="click" data-act="research" data-id="${esc(f.symbol)}"><td><b>${esc(f.symbol)}</b></td><td class="${f.bias === 'bullish' ? 'up' : f.bias === 'bearish' ? 'down' : ''}">${esc(f.bias || '')}</td><td style="white-space:normal">${esc(f.setup || '')}${f.catalyst ? `<br><span class="faint">${esc(f.catalyst)}</span>` : ''}${f.plan ? `<br><span class="muted">${esc(f.plan)}</span>` : ''}</td><td class="r">${esc(f.levels?.entry ?? '—')}</td><td class="r">${esc(f.levels?.stop ?? '—')}</td><td class="r">${esc(f.levels?.target ?? '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">The focus list appears with the weekly plan.</div>'}</div>
      <div class="panel"><div class="panel-head"><h2>If this, then that</h2><span class="sub">Scenarios the desk has pre-planned.</span></div>${(week.scenarios || []).length ? `<ul class="notes" style="color:var(--text)">${week.scenarios.map((s) => `<li><b>If</b> ${esc(s.if)} <b>→</b> ${esc(s.then)}</li>`).join('')}</ul>` : '<div class="empty">None yet.</div>'}</div>
    </div>
    <div class="stack">
      <div class="panel"><div class="panel-head"><h2>${tl.isToday ? 'Today' : `Next trading day (${esc(fmtDateNY(tl.iso + 'T16:00:00Z', { weekday: 'long', month: 'short', day: 'numeric' }))})`}, hour by hour</h2><span class="tools"><button class="btn small" data-act="run-cycle" data-id="premarket" ${S.runtime?.ai ? '' : 'disabled'}>Rebuild today’s plan</button></span></div>
        ${today.briefing ? `<div class="box" style="margin-bottom:12px"><h4>Briefing</h4><p>${esc(today.briefing)}</p></div>` : ''}
        <div class="timeline">${tl.rows
          .map((r) => {
            const isNext = next && next.iso === tl.iso && next.time === r.time;
            const cls = isNext ? 'next' : r.status;
            return `<div class="slot ${cls}"><div class="time">${esc(label12(r.time))}</div><div class="rail"></div><div class="what"><b>${esc(r.name)}${r.status === 'done' ? ' · done' : isNext ? ' · next' : r.status === 'missed' ? ' · not run' : ''}</b><span>${esc(r.what || '')}</span>${(r.tasks || []).map((t) => `<div class="task">${esc(t.task || '')}${t.symbols?.length ? ` <span class="faint">${esc(t.symbols.join(', '))}</span>` : ''}</div>`).join('')}</div></div>`;
          })
          .join('') || '<div class="empty">Market closed.</div>'}</div>
      </div>
      <div class="panel"><div class="panel-head"><h2>Key levels & triggers</h2></div>${(today.keyLevels || []).length || (today.watch || []).length ? `${(today.keyLevels || []).length ? `<div class="kv">${today.keyLevels.map((k) => `<div><span>${esc(k.symbol)} ${esc(k.note || '')}</span><span>${esc(k.level)}</span></div>`).join('')}</div>` : ''}${(today.watch || []).length ? `<ul class="notes" style="color:var(--text);margin-top:10px">${today.watch.map((w) => `<li><b>${esc(w.symbol)}</b>: if ${esc(w.trigger)} → ${esc(w.action)}</li>`).join('')}</ul>` : ''}` : '<div class="empty">Levels and triggers appear with the daily plan.</div>'}</div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ RESEARCH
function renderResearch() {
  const el = $('#tab-research');
  const scan = S.scan;
  const r = scan?.regime;
  const rows = scan ? Object.values(scan.analyses).filter((a) => !a.insufficient).sort((a, b) => b.score - a.score) : [];
  const sel = scan?.analyses?.[S.selected] || rows[0];
  if (sel && !scan?.analyses?.[S.selected]) S.selected = sel.symbol;
  el.innerHTML = `
  <div class="research-grid">
    <div class="stack">
      <div class="panel"><div class="panel-head"><h2>Market regime</h2><span class="tools"><button class="link" data-act="rescan">${S.busy.scan ? 'Scanning…' : 'Re-scan'}</button></span></div>
        ${r ? `<div class="grid-2" style="align-items:center"><div>${gaugeSVG(r.score)}<div class="regime-label">${esc(r.label)} <span class="mono" style="font-size:15px">${r.score > 0 ? '+' : ''}${r.score}</span></div></div><div><p style="margin:0 0 6px"><b>Posture:</b> ${esc(r.posture)}</p><ul class="notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></div>
        <div class="index-cards">${Object.entries(r.indexes || {}).map(([s, v]) => `<div class="box"><h4>${esc(s)}</h4><strong class="${signCls(v.changePct)}">${pct(v.changePct)}</strong><span class="faint" style="font-size:12px">${esc(v.trend)} · score ${v.score > 0 ? '+' : ''}${v.score}</span></div>`).join('')}</div>` : `<div class="empty">${S.busy.scan ? 'Reading the market…' : S.scanError ? esc(S.scanError.message) : 'Not loaded.'}</div>`}
      </div>
      <div class="panel"><div class="panel-head"><h2>Scanner</h2><span class="sub">Your watchlist ranked by technical score (−100 very bearish … +100 very bullish). Click a row for the chart and patterns.</span></div>
        <div class="search-box"><input id="sym-search" type="search" placeholder="Look up any ticker…" autocomplete="off" aria-label="Search symbols" /><div id="sym-results" class="search-results" hidden></div></div>
        <div class="table-wrap" style="margin-top:10px"><table class="data"><thead><tr><th>Symbol</th><th class="r">Price</th><th class="r">Day</th><th>Score</th><th>Top pattern</th><th class="r">RSI</th></tr></thead><tbody>${rows
          .map((a) => `<tr class="click ${a.symbol === S.selected ? 'sel' : ''}" data-act="select-sym" data-id="${esc(a.symbol)}"><td><b>${esc(a.symbol)}</b></td><td class="r">${money(a.price)}</td><td class="r ${signCls(a.changePct)}">${pct(a.changePct)}</td><td>${scoreBar(a.score)} <span class="mono" style="font-size:12px">${a.score > 0 ? '+' : ''}${a.score}</span></td><td style="font-size:12.5px">${esc(a.patterns[0]?.name || '—')}</td><td class="r">${a.indicators.rsi ?? '—'}</td></tr>`)
          .join('')}</tbody></table></div>
      </div>
    </div>
    <div class="stack">${sel ? symbolDetail(sel) : `<div class="panel empty">${S.busy.scan ? 'Loading charts…' : 'Pick a symbol.'}</div>`}</div>
  </div>`;
  if (sel) priceChart($('#price-canvas'), sel.bars, sel);
}

function scoreBar(score) {
  const w = Math.abs(score) / 2;
  const left = score >= 0 ? 50 : 50 - w;
  return `<span class="scorebar"><i style="left:${left}%;width:${w}%;background:${score >= 0 ? 'var(--up)' : 'var(--down)'}"></i></span>`;
}

function symbolDetail(a) {
  const ind = a.indicators;
  const dd = S.deepDive[a.symbol];
  const inWatch = S.settings.watchlist.includes(a.symbol);
  return `<div class="panel"><div class="panel-head"><h2>${esc(a.symbol)} <span class="mono" style="font-size:15px">${money(a.price)}</span> <span class="mono ${signCls(a.changePct)}" style="font-size:13px">${pct(a.changePct)}</span></h2><span class="tools">${inWatch ? `<button class="btn small ghost" data-act="unwatch" data-id="${esc(a.symbol)}">Remove from watchlist</button>` : `<button class="btn small" data-act="watch" data-id="${esc(a.symbol)}">Add to watchlist</button>`}<button class="btn small ghost" data-act="ask-about" data-id="${esc(a.symbol)}">Ask the Head Honcho</button></span><span class="sub">${esc(a.summary)}</span></div>
    <canvas id="price-canvas" aria-label="${esc(a.symbol)} price chart with moving averages, support and resistance, and a one-week projection"></canvas>
  </div>
  <div class="panel"><div class="panel-head"><h2>Patterns found</h2><span class="sub">Detected by code from a year of daily bars. Confidence is how reliable the pattern usually is, not a guarantee.</span></div>
    <div class="pattern-list">${a.patterns.length ? a.patterns.map((p) => `<div class="pattern ${p.bias}"><b><span>${esc(p.name)}</span><span class="mono" style="font-size:12px">${esc(p.bias)} · ${Math.round(p.confidence * 100)}%</span></b><span>${esc(p.detail)}</span>${p.target ? `<span class="mono" style="display:block;font-size:12px;margin-top:2px">level ${esc(p.level ?? '—')} → target ${esc(p.target)}</span>` : ''}</div>`).join('') : '<div class="empty">No clear patterns right now: often a sign to wait.</div>'}</div>
  </div>
  <div class="panel"><div class="panel-head"><h2>Numbers</h2></div>
    <div class="kv">
      <div><span>Trend</span><span>${esc(a.trend.direction)} (${a.trend.strength})</span></div>
      <div><span>RSI 14</span><span>${ind.rsi ?? '—'}</span></div>
      <div><span>MACD hist</span><span>${ind.macdHist ?? '—'}</span></div>
      <div><span>ADX</span><span>${ind.adx ?? '—'}</span></div>
      <div><span>50-day</span><span>${ind.sma50 ?? '—'}</span></div>
      <div><span>200-day</span><span>${ind.sma200 ?? '—'}</span></div>
      <div><span>ATR</span><span>${ind.atr} (${ind.atrPct}%)</span></div>
      <div><span>Volume vs avg</span><span>${ind.volRatio ?? '—'}×</span></div>
      <div><span>52-wk range</span><span>${a.low52}–${a.high52}</span></div>
      <div><span>Support</span><span>${esc(a.levels.support.slice(0, 2).join(', ') || '—')}</span></div>
      <div><span>Resistance</span><span>${esc(a.levels.resistance.slice(0, 2).join(', ') || '—')}</span></div>
      <div><span>1-wk range (68%)</span><span>${a.projection.low1}–${a.projection.high1}</span></div>
    </div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">${esc(a.projection.note)} Bull target ${esc(a.projection.bullTarget)}, bear target ${esc(a.projection.bearTarget)}.</p>
  </div>
  <div class="panel"><div class="panel-head"><h2>Researchers’ deep dive</h2><span class="tools"><button class="btn small primary" data-act="deep-dive" data-id="${esc(a.symbol)}" ${S.runtime?.ai && !dd?.busy ? '' : 'disabled'}>${dd?.busy ? 'Writing…' : dd?.text ? 'Refresh' : 'Ask Scout & Analyst'}</button></span><span class="sub">Charts, options pricing, events and fundamentals in one note, with what the desk would do in the current mode.</span></div>${dd?.text ? `<div class="prose">${esc(dd.text)}</div>` : dd?.error ? `<p class="down">${esc(dd.error)}</p>` : '<div class="empty">Not requested yet.</div>'}</div>`;
}

let searchTimer = null;
function onSearchInput(e) {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#sym-results');
  if (!q) {
    box.hidden = true;
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const res = await S.runtime.market.search(q);
      box.innerHTML = res.slice(0, 8).map((r) => `<button type="button" data-act="select-new" data-id="${esc(r.symbol)}"><b>${esc(r.symbol)}</b><span class="muted">${esc(r.name)}</span></button>`).join('') || '<div class="empty">No matches.</div>';
      box.hidden = false;
    } catch (err) {
      box.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      box.hidden = false;
    }
  }, 300);
}

async function selectSymbol(sym, { fetch = false } = {}) {
  S.selected = sym;
  if (fetch && !S.scan?.analyses?.[sym]) {
    try {
      const a = await S.desk.analyzeSymbols([sym]);
      S.scan = S.scan || { analyses: {}, regime: null };
      S.scan.analyses[sym] = a[sym];
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
  if (S.tab !== 'research') setTab('research');
  else renderResearch();
}

async function deepDive(sym) {
  S.deepDive[sym] = { busy: true, text: '' };
  renderResearch();
  try {
    const r = await S.desk.deepDive(sym, {
      onText: ({ text }) => {
        S.deepDive[sym].text = text;
        const el = $('#tab-research .prose');
        if (el) el.textContent = text;
        else renderResearch();
      },
    });
    S.deepDive[sym] = { text: r.text };
  } catch (err) {
    S.deepDive[sym] = { error: aiErrorText(err) };
  }
  renderResearch();
}

// ------------------------------------------------------------------ ACADEMY
function renderAcademy() {
  const el = $('#tab-academy');
  const A = S.academy;
  const sum = progressSummary(A.progress);
  if (A.lesson) return renderLesson(el, lessonById(A.lesson));
  const q = A.glossaryQ.toLowerCase();
  el.innerHTML = `
  <div class="panel" style="margin-bottom:14px"><div class="academy-head"><div><h2>Trading Academy</h2><p class="muted" style="margin:4px 0 0">Learn to trade stocks and options, and to read every decision your AI desk makes. ${sum.done} of ${sum.total} lessons passed.</p></div><div><div class="progress" aria-label="Course progress"><i style="width:${sum.pct}%"></i></div><p class="faint mono" style="font-size:12px;margin:4px 0 0">${sum.pct}% · quiz ${sum.quizScore}/${sum.quizTotal}</p></div></div></div>
  <div class="modules">${MODULES.map((m) => `<div class="panel"><span class="label">${esc(m.name)}</span><p class="muted" style="margin:4px 0 8px">${esc(m.blurb)}</p>${LESSONS.filter((l) => l.module === m.id).map((l) => `<button class="lesson-btn" data-act="lesson" data-id="${l.id}"><b>${A.progress[l.id]?.passed ? '✓ ' : ''}${esc(l.title)}</b><small>${l.minutes} min</small></button>`).join('')}</div>`).join('')}</div>
  <div class="grid-2" style="margin-top:14px">
    <div class="panel">${drillPanel()}</div>
    <div class="panel">${tutorPanel()}</div>
  </div>
  <div class="panel" style="margin-top:14px"><div class="panel-head"><h2>Glossary</h2><span class="tools"><input id="gloss-q" type="search" placeholder="Filter terms…" value="${esc(A.glossaryQ)}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px 9px" aria-label="Filter glossary" /></span></div>
    <dl class="glossary">${GLOSSARY.filter(([t, d]) => !q || t.toLowerCase().includes(q) || d.toLowerCase().includes(q)).map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>
  </div>`;
}

function renderLesson(el, l) {
  const A = S.academy;
  const ans = A.answers[l.id] || {};
  const idx = LESSONS.indexOf(l);
  el.innerHTML = `<div class="panel lesson">
    <button class="link" data-act="lesson-back">← All lessons</button>
    <span class="label" style="display:block;margin-top:10px">${esc(MODULES.find((m) => m.id === l.module)?.name || '')} · ${l.minutes} min</span>
    <h2 style="font-size:24px;margin:4px 0 14px">${esc(l.title)}</h2>
    ${l.body.map((p) => `<p>${esc(p)}</p>`).join('')}
    ${l.example ? `<div class="box" style="margin-bottom:12px"><h4>Example</h4><p>${esc(l.example)}</p></div>` : ''}
    <div class="keys"><span class="label">Key points</span><ul>${l.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>
    <h3 style="margin:20px 0 10px;font-size:17px">Check yourself</h3>
    <div class="quiz">${l.quiz
      .map((q, qi) => {
        const picked = ans[qi];
        return `<div class="q"><b>${qi + 1}. ${esc(q.q)}</b><div class="choices">${q.choices.map((c, ci) => `<button type="button" data-act="answer" data-id="${l.id}" data-q="${qi}" data-c="${ci}" class="${picked != null ? (ci === q.answer ? 'right' : ci === picked ? 'wrong' : '') : ''}" ${picked != null ? 'disabled' : ''}>${esc(c)}</button>`).join('')}</div>${picked != null ? `<div class="explain">${picked === q.answer ? '✓ Correct. ' : '✕ Not quite. '}${esc(q.explain)}</div>` : ''}</div>`;
      })
      .join('')}</div>
    <div class="actions-row" style="margin-top:16px">
      ${idx > 0 ? `<button class="btn ghost" data-act="lesson" data-id="${LESSONS[idx - 1].id}">← ${esc(LESSONS[idx - 1].title)}</button>` : ''}
      ${idx < LESSONS.length - 1 ? `<button class="btn primary" data-act="lesson" data-id="${LESSONS[idx + 1].id}">Next: ${esc(LESSONS[idx + 1].title)} →</button>` : ''}
      <button class="btn ghost" data-act="tutor-ask" data-id="${esc(`Explain "${l.title}" again with a different example.`)}" ${S.runtime?.ai ? '' : 'disabled'}>Explain it differently</button>
    </div>
  </div>
  <div class="panel lesson" style="margin-top:14px">${tutorPanel()}</div>`;
}

function drillPanel() {
  const d = S.academy.drill;
  const head = `<div class="panel-head"><h2>Pattern drill</h2><span class="sub">A real chart from your watchlist with the labels hidden. Call it, then see what the Scout’s code found.</span></div>`;
  const pool = S.scan ? Object.values(S.scan.analyses).filter((a) => !a.insufficient && a.bars?.length > 60) : [];
  if (!pool.length) return `${head}<div class="empty">${S.busy.scan ? 'Loading charts…' : 'Charts load from the Research scan.'}</div>`;
  if (!d) return `${head}<button class="btn primary" data-act="drill-new">Start a drill</button>`;
  const a = S.scan.analyses[d.symbol];
  return `${head}<canvas id="drill-canvas" aria-label="Unlabeled practice chart"></canvas>
    ${d.guess ? `<div class="box" style="margin-top:10px"><h4>${esc(a.symbol)} · score ${a.score > 0 ? '+' : ''}${a.score} (${esc(a.bias)})</h4><p>${d.guess === a.bias ? '✓ You read it the same way as the desk.' : `The desk read it as <b>${esc(a.bias)}</b>.`}</p><p class="muted">${esc(a.summary)}</p></div><div class="actions-row" style="margin-top:10px"><button class="btn primary" data-act="drill-new">Next chart</button></div>` : `<div class="actions-row" style="margin-top:10px"><button class="btn buy" data-act="drill-guess" data-id="bullish">Bullish</button><button class="btn" data-act="drill-guess" data-id="neutral">Neutral</button><button class="btn sell" data-act="drill-guess" data-id="bearish">Bearish</button></div>`}`;
}

function drawDrill() {
  const d = S.academy.drill;
  const c = $('#drill-canvas');
  if (!d || !c) return;
  const a = S.scan.analyses[d.symbol];
  priceChart(c, a.bars, d.guess ? a : { levels: { support: [], resistance: [] } }, { height: 240, days: 90 });
}

function tutorPanel() {
  const t = S.academy.tutor || {};
  return `<div class="panel-head"><h2>Ask the tutor</h2><span class="sub">The Head Honcho in teaching mode. Ask about anything you don’t understand.</span></div>
    <form id="tutor-form" class="composer"><textarea id="tutor-input" rows="2" placeholder="e.g. What is implied volatility, really?" aria-label="Ask the tutor"></textarea><div class="composer-actions"><button class="btn primary" type="submit" ${S.runtime?.ai && !t.busy ? '' : 'disabled'}>${t.busy ? 'Answering…' : 'Ask'}</button></div></form>
    ${t.q ? `<div class="box" style="margin-top:10px"><h4>You asked</h4><p>${esc(t.q)}</p></div><div class="prose" id="tutor-answer" style="margin-top:10px">${esc(t.a || (t.busy ? 'Thinking…' : ''))}</div>` : ''}`;
}

async function askTutor(q) {
  if (!q.trim() || S.academy.tutor?.busy) return;
  S.academy.tutor = { q, a: '', busy: true };
  renderAcademy();
  try {
    const r = await S.desk.chat(q, {
      tutor: true,
      onText: ({ text }) => {
        S.academy.tutor.a = text;
        const el = $('#tutor-answer');
        if (el) el.textContent = text;
      },
    });
    S.academy.tutor = { q, a: r.text, busy: false };
  } catch (err) {
    S.academy.tutor = { q, a: aiErrorText(err), busy: false };
  }
  renderAcademy();
}

async function answerQuiz(lessonId, qi, ci) {
  const A = S.academy;
  A.answers[lessonId] = { ...(A.answers[lessonId] || {}), [qi]: ci };
  const l = lessonById(lessonId);
  const ans = A.answers[lessonId];
  if (Object.keys(ans).length === l.quiz.length) {
    const score = l.quiz.filter((q, i) => ans[i] === q.answer).length;
    const passed = score >= Math.ceil(l.quiz.length * 0.66);
    A.progress[lessonId] = { score: Math.max(score, A.progress[lessonId]?.score || 0), passed: passed || !!A.progress[lessonId]?.passed, at: Date.now() };
    await S.runtime.store.set('academy/progress', A.progress).catch(() => {});
    toast(passed ? `Lesson passed: ${score}/${l.quiz.length}` : `${score}/${l.quiz.length}. Review and try again later.`, passed ? 'good' : '');
  }
  renderAcademy();
}

// ------------------------------------------------------------------ SETTINGS
function renderSettings() {
  const el = $('#tab-settings');
  const s = S.settings;
  const st = S.state || {};
  const params = resolveParams(s.mode, st.paramOverrides, s.limits);
  const L = s.limits;
  const liveAvail = !!S.runtime?.brokers?.live;
  const acct = S.snap?.live ? S.snap.account : null;
  el.innerHTML = `
  <div class="stack">
    <div class="panel"><div class="panel-head"><h2>Trading account</h2><span class="sub">Paper trades simulated money at real prices. Live trades your Robinhood agentic account with real money.</span></div>
      <div class="field"><div><label>Account</label><small>${liveAvail ? 'Live uses the one Robinhood account you opened to AI agents (your agentic account).' : HOSTED ? 'Connect Robinhood to enable live trading.' : 'Live trading runs in the claude.ai version, through your Robinhood connector.'}</small></div><div class="seg" role="radiogroup"><button data-act="broker" data-id="paper" class="${s.broker === 'paper' ? 'on' : ''}">Paper</button><button data-act="broker" data-id="live" class="${s.broker === 'live' ? 'on' : ''}" ${liveAvail ? '' : 'disabled'}>Live (Robinhood)</button></div></div>
      ${s.broker === 'live' ? `<div class="field"><div><label>Live account</label><small>${acct ? `${esc(acct.nickname)} ${esc(acct.masked)} · ${esc(acct.type)} · options ${esc(String(acct.optionLevel || '').replace('option_level_', 'level '))} · ${acct.approvalsRequired ? 'you approve each trade in the Robinhood app' : 'trades execute without app approval'}` : 'Loading…'}</small></div></div>
      <div class="field"><div><label>Order sending</label><small>Confirm: every order waits for you to press Send. Automatic: orders that pass the risk gate go straight to Robinhood${acct?.approvalsRequired ? ' (then to your Robinhood app for approval)' : ''}.</small></div><div class="seg"><button data-act="execution" data-id="confirm" class="${s.execution !== 'auto' ? 'on' : ''}">Confirm each</button><button data-act="execution" data-id="auto" class="${s.execution === 'auto' ? 'on' : ''}">Automatic</button></div></div>` : `<div class="field"><div><label>Paper account</label><small>Start over with a fresh simulated balance. Clears paper positions and orders.</small></div><div class="actions-row"><select id="paper-cash" aria-label="Starting balance">${[1000, 5000, 10000, 25000, 100000].map((v) => `<option value="${v}" ${v === s.paperStartCash ? 'selected' : ''}>$${v.toLocaleString()}</option>`).join('')}</select><button class="btn" data-act="paper-reset">Reset paper account</button></div></div>`}
    </div>

    <div class="panel"><div class="panel-head"><h2>Risk mode</h2><span class="sub">How much risk the desk may take. The AI can fine-tune inside the mode’s bounds but never beyond them.</span></div>
      <div class="mode-cards">${MODES.map((m) => `<button class="mode-card ${m.id === s.mode ? 'on' : ''}" style="--c:${m.color}" data-act="mode" data-id="${m.id}"><h3>${esc(m.name)} <small>${m.level}/5</small></h3><span class="tag">${esc(m.tagline)}</span><p>${esc(m.description)}</p><p><b>Goal:</b> ${esc(m.goal)}</p></button>`).join('')}</div>
      <h3 class="label" style="margin:16px 0 8px">${esc(params.mode.name)} settings in force</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Setting</th><th class="r">Now</th><th class="r">AI may set</th><th>What it means</th></tr></thead><tbody>${Object.entries(PARAMS)
        .filter(([k]) => params[k] !== undefined && !(params.strategies.length === 1 && /option|Dte|delta|Spread|OpenInterest/i.test(k)))
        .map(([k, d]) => {
          const b = params.mode.bounds[k];
          const adj = params.adjusted[k];
          return `<tr><td>${esc(d.label)}</td><td class="r">${esc(params[k])} <span class="faint">${esc(d.unit)}</span>${adj ? ` <span class="warnc" title="AI adjusted from ${esc(adj.from)}">•</span>` : ''}</td><td class="r">${b && d.ai ? `${b[0]}–${b[1]}` : '<span class="faint">fixed</span>'}</td><td style="white-space:normal;color:var(--muted)">${esc(d.explain)}</td></tr>`;
        })
        .join('')}</tbody></table></div>
      ${Object.keys(params.adjusted).length ? `<p style="margin:10px 0 0"><span class="warnc">•</span> The Head Honcho tuned ${Object.keys(params.adjusted).length} setting${Object.keys(params.adjusted).length > 1 ? 's' : ''} for current conditions. <button class="link" data-act="reset-tuning">Reset to mode defaults</button></p>` : ''}
    </div>

    <div class="panel"><div class="panel-head"><h2>Your hard limits</h2><span class="sub">These only ever tighten the mode. The risk gate enforces them on every order.</span></div>
      ${numField('maxOrderDollars', 'Max dollars per order', 'Caps any single order. 0 = no extra cap.', L.maxOrderDollars, 1)}
      ${numField('dailyLossLimitPct', 'Daily loss limit (%)', `Stop opening trades after this loss in a day. 0 = use the mode’s (${modeById(s.mode).values.dailyLossLimitPct}%).`, L.dailyLossLimitPct, 0.5)}
      ${numField('maxTradesPerDay', 'Max new trades per day', '0 = use the mode’s.', L.maxTradesPerDay, 1)}
      ${numField('autoDowngradeOnDrawdownPct', 'Auto-lower the mode after a drawdown of (%)', 'If the account falls this far below its peak, drop one mode level. 0 = off.', L.autoDowngradeOnDrawdownPct, 1)}
      ${toggleField('pdtGuard', 'Pattern-day-trader guard', 'Warn and block trades that would break the day-trade limit on accounts under $25k.', L.pdtGuard)}
      ${toggleField('allowExtendedHours', 'Allow extended-hours stock orders', 'Only in modes that permit it; limit orders only.', L.allowExtendedHours)}
      ${toggleField('requireExitPlan', 'Require an exit plan on every entry', 'Adds the mode’s default stop and target when the agents leave them out.', L.requireExitPlan)}
      <div class="field"><div><label>Never trade</label><small>Symbols the desk must not touch.</small><div class="taglist" style="margin-top:6px">${(L.blocklist || []).map((sym) => `<span>${esc(sym)}<button data-act="unblock" data-id="${esc(sym)}" aria-label="Remove ${esc(sym)}">×</button></span>`).join('') || '<span class="faint" style="border:0;background:none">none</span>'}</div></div><form class="actions-row" id="block-form"><input id="block-input" type="text" placeholder="TICKER" style="width:110px;text-transform:uppercase" aria-label="Symbol to block" /><button class="btn small">Add</button></form></div>
    </div>

    <div class="panel"><div class="panel-head"><h2>Watchlist</h2><span class="sub">What the researchers scan every cycle, along with anything you hold and the week’s focus list.</span></div>
      <div class="taglist">${s.watchlist.map((sym) => `<span>${esc(sym)}<button data-act="unwatch" data-id="${esc(sym)}" aria-label="Remove ${esc(sym)}">×</button></span>`).join('')}</div>
      <form class="actions-row" id="watch-form" style="margin-top:10px"><input id="watch-input" type="text" placeholder="Add ticker" style="width:130px;text-transform:uppercase;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px 9px" aria-label="Symbol to add" /><button class="btn small">Add</button></form>
    </div>

    <div class="panel"><div class="panel-head"><h2>Autopilot</h2><span class="sub">How the desk keeps working when this page is closed.</span></div>
      ${autopilotSection()}
    </div>

    <div class="panel"><div class="panel-head"><h2>Standing instructions & memory</h2><span class="sub">Instructions you gave in chat that every cycle follows, and notes the Head Honcho keeps between cycles.</span></div>
      ${(st.directives || []).length ? `<ul class="notes" style="color:var(--text)">${st.directives.map((d, i) => `<li>${esc(d.text)} <button class="link" data-act="drop-directive" data-id="${i}">remove</button></li>`).join('')}</ul>` : '<p class="muted">No standing instructions. Tell the Head Honcho things like “avoid TSLA” or “keep 50% cash this week” in the AI Desk.</p>'}
      ${(st.memory || []).length ? `<h3 class="label" style="margin:14px 0 6px">Head Honcho’s notes</h3><ul class="notes">${st.memory.slice(-10).map((m) => `<li>${esc(m.text || m)}</li>`).join('')}</ul><button class="link" data-act="clear-memory">Clear notes</button>` : ''}
    </div>
  </div>`;
}

function numField(key, label, help, value, step) {
  return `<div class="field"><div><label for="lim-${key}">${esc(label)}</label><small>${esc(help)}</small></div><input id="lim-${key}" type="number" min="0" step="${step}" value="${esc(value ?? 0)}" data-limit="${key}" /></div>`;
}
function toggleField(key, label, help, on) {
  return `<div class="field"><div><label for="lim-${key}">${esc(label)}</label><small>${esc(help)}</small></div><label class="switch"><input id="lim-${key}" type="checkbox" data-limit-bool="${key}" ${on ? 'checked' : ''}/><span></span></label></div>`;
}

function autopilotSection() {
  if (!HOSTED) {
    const srv = S.runtime?.server || {};
    return `${toggleField('serverAutopilot', 'Run the desk on schedule from this server', 'Runs every check-in on the Planner’s schedule and checks exits every minute while the market is open (paper trading).', S.settings.serverAutopilot).replace('data-limit-bool', 'data-setting-bool')}<p class="muted" style="margin:8px 0 0">Server: ${srv.ai ? `Claude ${esc(srv.model)}` : 'no API key'}${srv.autopilot?.last ? ` · last autopilot cycle ${esc(ago(srv.autopilot.last.at))}` : ''}</p>`;
  }
  const bg = S.cycles.find((c) => c.source === 'autopilot');
  return `<p style="margin:0 0 10px">This page runs the agents when you press a button and checks exits while it is open. To trade on schedule when the page is closed, Crow’s Nest uses a <b>scheduled Claude session</b> that follows the same playbook, uses your Robinhood connector, passes every order through the same risk gate code, and writes its plans and journal back here.</p>
  <ol class="notes" style="color:var(--text)"><li>Open Claude Code on the web for the <span class="mono">christianDesigns</span> repository.</li><li>Ask: <span class="mono">Arm the Crow’s Nest autopilot</span> (or “disarm” to stop it).</li><li>Claude creates the schedule: pre-market, hourly checks, power hour, close review and Sunday’s weekly plan.</li></ol>
  <p class="muted" style="margin:10px 0 0">${bg ? `Last background cycle: ${esc(bg.kind)} ${esc(ago(bg.at))} — ${esc(bg.headline || bg.status)}` : 'No background cycles have run yet.'}</p>`;
}

async function saveLimits(patch) {
  S.settings = await S.desk.saveSettings({ limits: { ...S.settings.limits, ...patch } });
  toast('Limits saved.', 'good');
  renderSettings();
}

async function setMode(id) {
  const m = modeById(id);
  if (id === S.settings.mode) return;
  if (m.level >= 4) {
    const ok = await confirmModal({ title: `Switch to ${m.name}?`, body: `<p>${esc(m.description)}</p><p><b>Goal:</b> ${esc(m.goal)}</p><p class="warnc">${m.level === 5 ? 'Moonshot allows same-day options and long-shot contracts. Many trades will lose 100% of what they risk.' : 'Aggressive mode takes larger positions with shorter-dated options. Expect sharp drawdowns.'}</p>`, confirm: `Use ${m.name}`, danger: true, check: S.settings.broker === 'live' ? 'I understand this risks real money.' : undefined });
    if (!ok) return;
  }
  S.settings = await S.desk.saveSettings({ mode: id });
  await S.desk.patchState({ paramOverrides: {} });
  S.state = await S.desk.getState();
  toast(`Mode: ${m.name}`, 'good');
  renderAll();
}

async function setBroker(kind) {
  if (kind === S.settings.broker) return;
  if (kind === 'live') {
    let acct;
    try {
      acct = await S.runtime.brokers.live.account();
    } catch (err) {
      return toast(err.message, 'bad');
    }
    const ok = await confirmModal({
      title: 'Trade your live Robinhood account?',
      body: `<p>Crow’s Nest will trade <b>${esc(acct.nickname)} ${esc(acct.masked)}</b> (${esc(acct.type)}, options ${esc(String(acct.optionLevel || '').replace('option_level_', 'level '))}) with real money.</p><p>${acct.approvalsRequired ? 'Your Robinhood setting requires you to approve each agent trade in the Robinhood app.' : 'Your Robinhood setting lets agent trades execute without approval in the app.'}</p><p>Order sending starts on <b>Confirm each</b>: nothing goes out until you press Send. You can switch to automatic later.</p>`,
      confirm: 'Go live',
      danger: true,
      check: 'I understand trades can lose real money, and that this is not financial advice.',
    });
    if (!ok) return;
    S.settings = await S.desk.saveSettings({ broker: 'live', accountNumber: acct.number, execution: 'confirm' });
  } else S.settings = await S.desk.saveSettings({ broker: 'paper' });
  S.snap = null;
  renderAll();
  refresh();
}

async function setExecution(mode) {
  if (mode === S.settings.execution) return;
  if (mode === 'auto') {
    const ok = await confirmModal({ title: 'Send orders automatically?', body: `<p>Orders the agents create will go to Robinhood as soon as they pass the risk gate and Robinhood’s own review, without waiting for you. Exits triggered by stops and targets will also go out automatically while this page or the autopilot is running.</p><p>Robinhood alerts (buying power, day-trade warnings and similar) still stop an order and wait for you.</p>`, confirm: 'Turn on automatic sending', danger: true, check: 'I understand the desk will place real trades without asking me first.' });
    if (!ok) return;
  }
  S.settings = await S.desk.saveSettings({ execution: mode });
  renderAll();
}

async function toggleKill() {
  const on = !S.state?.killSwitch;
  if (on) {
    const open = S.snap?.openOrders || [];
    const ok = await confirmModal({ title: 'Halt trading?', body: `<p>The desk will stop opening new positions. Exits and closing orders still work.</p>${open.length ? `<p>There ${open.length === 1 ? 'is 1 working order' : `are ${open.length} working orders`}. Cancel ${open.length === 1 ? 'it' : 'them'} too?</p>` : ''}`, confirm: open.length ? 'Halt and cancel orders' : 'Halt trading', danger: true });
    if (!ok) return;
    await S.desk.patchState({ killSwitch: true, killedAt: Date.now() });
    for (const o of open) await S.desk.cancelOrder(o).catch((e) => toast(`Could not cancel ${o.symbol}: ${e.message}`, 'bad'));
    toast('Trading halted.', 'bad');
  } else {
    await S.desk.patchState({ killSwitch: false });
    toast('Trading resumed.', 'good');
  }
  S.state = await S.desk.getState();
  renderAll();
  refresh();
}

// ------------------------------------------------------------------ events
document.addEventListener('click', async (e) => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) return setTab(tabBtn.dataset.tab);
  if (e.target.closest('#kill-btn')) return toggleKill();
  const t = e.target.closest('[data-act]');
  if (!t || !S.desk) return;
  const { act, id } = t.dataset;
  switch (act) {
    case 'toggle':
      S.open.has(id) ? S.open.delete(id) : S.open.add(id);
      return renderTab();
    case 'goto':
      return setTab(id);
    case 'refresh':
      return refresh({ force: true });
    case 'kill':
      return toggleKill();
    case 'mode':
      return setMode(id);
    case 'broker':
      return setBroker(id);
    case 'execution':
      return setExecution(id);
    case 'run-cycle':
      return runCycle(id || 'manual');
    case 'run-cycle-pick':
      return runCycle($('#cycle-kind')?.value || 'manual');
    case 'stop-cycle':
      return cycleCtl?.abort();
    case 'open-room':
      S.roomCycleId = id;
      setTab('ai');
      return;
    case 'intent-filter':
      S.intentFilter = id;
      return renderIntentFeed();
    case 'send-intent': {
      const i = S.intents.find((x) => x.id === id);
      const live = S.settings.broker === 'live';
      if (live) {
        const ok = await confirmModal({ title: 'Send this order to Robinhood?', body: `<p><b>${esc(i?.headline)}</b></p><p>${esc(ticketText(i?.ticket))}</p>${i?.gate?.cost ? `<p>Uses about <b>${money(i.gate.cost)}</b>.</p>` : ''}${(i?.broker?.alerts || []).map((a) => `<p class="warnc">${esc(a)}</p>`).join('')}`, confirm: 'Send order', danger: false });
        if (!ok) return;
      }
      t.disabled = true;
      try {
        const r = await S.desk.sendIntent(id);
        toast(`${r.headline}: ${statusText(r.status)}`, ['filled', 'sent', 'pending_approval'].includes(r.status) ? 'good' : 'bad');
      } catch (err) {
        toast(err.message, 'bad');
      }
      return refresh();
    }
    case 'dismiss-intent':
      await S.desk.dismissIntent(id).catch((err) => toast(err.message, 'bad'));
      return refresh();
    case 'explain': {
      const i = S.intents.find((x) => x.id === id);
      if (!i) return;
      S.explains[id] = 'Thinking…';
      renderTab();
      try {
        const r = await S.desk.explain(i, {
          onText: ({ text }) => {
            S.explains[id] = text;
          },
        });
        S.explains[id] = r.text;
      } catch (err) {
        S.explains[id] = aiErrorText(err);
      }
      return renderTab();
    }
    case 'ask-about':
      setTab('ai');
      $('#chat-input').value = `What do you think about ${id} right now?`;
      $('#chat-input').focus();
      return;
    case 'suggest':
      return sendChat(id);
    case 'cancel-order': {
      const o = (S.snap?.openOrders || []).find((x) => x.id === id);
      if (!(await confirmModal({ title: 'Cancel this order?', body: `<p>${esc(o ? orderText(o) : id)}</p>`, confirm: 'Cancel order', danger: true }))) return;
      try {
        await S.desk.cancelOrder(o || { id, kind: t.dataset.kind });
        toast('Order cancelled.', 'good');
      } catch (err) {
        toast(err.message, 'bad');
      }
      return refresh();
    }
    case 'close-pos':
    case 'trim-pos': {
      const contract = t.dataset.contract || undefined;
      const frac = act === 'trim-pos' ? 0.5 : 1;
      if (!(await confirmModal({ title: `${frac < 1 ? 'Trim' : 'Close'} ${id}?`, body: `<p>${frac < 1 ? 'Sell about half' : 'Sell all'} of ${esc(contract ? 'this option position' : `your ${id} shares`)} now${S.settings.broker === 'live' ? ' in your live Robinhood account' : ''}. The order still passes the risk gate.</p>`, confirm: frac < 1 ? 'Trim' : 'Close position', danger: true }))) return;
      try {
        const r = await S.desk.closePosition({ symbol: id, contractId: contract, fraction: frac });
        toast(`${r.headline}: ${statusText(r.status)}`, ['filled', 'sent', 'pending_approval'].includes(r.status) ? 'good' : 'bad');
      } catch (err) {
        toast(err.message, 'bad');
      }
      return refresh();
    }
    case 'edit-exit':
      return editExit(id, t.dataset.kind);
    case 'research':
      return selectSymbol(id, { fetch: true });
    case 'select-sym':
      S.selected = id;
      return renderResearch();
    case 'select-new':
      $('#sym-results').hidden = true;
      return selectSymbol(id, { fetch: true });
    case 'rescan':
      return loadScan();
    case 'deep-dive':
      return deepDive(id);
    case 'watch':
    case 'unwatch': {
      const list = act === 'watch' ? uniq([...S.settings.watchlist, id]) : S.settings.watchlist.filter((x) => x !== id);
      S.settings = await S.desk.saveSettings({ watchlist: list });
      toast(act === 'watch' ? `${id} added to the watchlist.` : `${id} removed.`);
      return renderTab();
    }
    case 'unblock':
      return saveLimits({ blocklist: (S.settings.limits.blocklist || []).filter((x) => x !== id) });
    case 'reset-tuning':
      await S.desk.patchState({ paramOverrides: {} });
      S.state = await S.desk.getState();
      return renderSettings();
    case 'drop-directive': {
      const d = [...(S.state.directives || [])];
      d.splice(Number(id), 1);
      await S.desk.patchState({ directives: d });
      S.state = await S.desk.getState();
      return renderSettings();
    }
    case 'clear-memory':
      await S.desk.patchState({ memory: [] });
      S.state = await S.desk.getState();
      return renderSettings();
    case 'paper-reset': {
      const cash = Number($('#paper-cash').value) || 10000;
      if (!(await confirmModal({ title: 'Reset the paper account?', body: `<p>Start over with $${cash.toLocaleString()} of simulated money. Paper positions and orders are cleared.</p>`, confirm: 'Reset', danger: true }))) return;
      await S.runtime.brokers.paper.reset(cash);
      S.settings = await S.desk.saveSettings({ paperStartCash: cash });
      const eq = (await S.runtime.store.get(PATHS.equity).catch(() => null)) || {};
      await S.runtime.store.set(PATHS.equity, { ...eq, paper: [] });
      toast('Paper account reset.', 'good');
      return refresh();
    }
    case 'lesson':
      S.academy.lesson = id;
      S.academy.answers[id] = {};
      renderAcademy();
      window.scrollTo({ top: 0 });
      return;
    case 'lesson-back':
      S.academy.lesson = null;
      return renderAcademy();
    case 'answer':
      return answerQuiz(id, Number(t.dataset.q), Number(t.dataset.c));
    case 'drill-new': {
      const pool = Object.values(S.scan?.analyses || {}).filter((a) => !a.insufficient && a.bars?.length > 60 && a.symbol !== S.academy.drill?.symbol);
      if (!pool.length) return;
      S.academy.drill = { symbol: pool[Math.floor(Math.random() * pool.length)].symbol, guess: null };
      renderAcademy();
      return drawDrill();
    }
    case 'drill-guess':
      S.academy.drill.guess = id;
      renderAcademy();
      return drawDrill();
    case 'tutor-ask':
      return askTutor(id);
  }
});

document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id === 'chat-form') {
    e.preventDefault();
    return sendChat($('#chat-input').value);
  }
  if (f.id === 'tutor-form') {
    e.preventDefault();
    return askTutor($('#tutor-input').value);
  }
  if (f.id === 'watch-form') {
    e.preventDefault();
    const sym = $('#watch-input').value.trim().toUpperCase();
    if (!/^[A-Z.]{1,10}$/.test(sym)) return toast('Enter a ticker like NVDA.', 'bad');
    S.settings = await S.desk.saveSettings({ watchlist: uniq([...S.settings.watchlist, sym]) });
    return renderSettings();
  }
  if (f.id === 'block-form') {
    e.preventDefault();
    const sym = $('#block-input').value.trim().toUpperCase();
    if (!/^[A-Z.]{1,10}$/.test(sym)) return toast('Enter a ticker like TSLA.', 'bad');
    return saveLimits({ blocklist: uniq([...(S.settings.limits.blocklist || []), sym]) });
  }
  if (f.id === 'exit-form') {
    e.preventDefault();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.limit) return saveLimits({ [t.dataset.limit]: Math.max(0, Number(t.value) || 0) });
  if (t.dataset.limitBool) return saveLimits({ [t.dataset.limitBool]: t.checked });
  if (t.dataset.settingBool) {
    S.settings = await S.desk.saveSettings({ [t.dataset.settingBool]: t.checked });
    return toast(t.checked ? 'Server autopilot on.' : 'Server autopilot off.', 'good');
  }
  if (t.id === 'cycle-select') {
    S.roomCycleId = t.value;
    return renderRoom();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'sym-search') return onSearchInput(e);
  if (e.target.id === 'gloss-q') {
    S.academy.glossaryQ = e.target.value;
    const pos = e.target.selectionStart;
    renderAcademy();
    const el = $('#gloss-q');
    el.focus();
    el.setSelectionRange(pos, pos);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'chat-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat(e.target.value);
  }
});

$('#chat-stop').addEventListener('click', () => chatCtl?.abort());

async function editExit(key, kind) {
  const cur = S.exits[key] || {};
  $('#modal-body').innerHTML = `<h2>Exit plan</h2><p class="muted">${kind === 'option' ? 'Option price per share (the premium).' : 'Stock price.'} The code checks these on every refresh and closes the position when one is hit.</p>
    <div class="field"><div><label for="ex-stop">Stop</label></div><input id="ex-stop" type="number" step="0.01" min="0" value="${esc(cur.stop ?? '')}" /></div>
    <div class="field"><div><label for="ex-target">Target</label></div><input id="ex-target" type="number" step="0.01" min="0" value="${esc(cur.target ?? '')}" /></div>
    <div class="field"><div><label for="ex-time">Time stop (date)</label></div><input id="ex-time" type="date" value="${esc(cur.timeStop ?? '')}" style="background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:6px 9px" /></div>
    <div class="modal-actions"><button value="cancel" class="btn ghost">Cancel</button><button value="ok" class="btn primary">Save</button></div>`;
  const dlg = $('#modal');
  dlg.returnValue = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const plan = { stop: Number($('#ex-stop').value) || null, target: Number($('#ex-target').value) || null, timeStop: $('#ex-time').value || null, basis: kind === 'option' ? 'option_premium' : 'stock_price', note: 'Set by you' };
    await S.desk.setExitPlan(key, plan);
    toast('Exit plan saved.', 'good');
  };
  dlg.showModal();
}

window.addEventListener('resize', () => {
  if (S.tab === 'desk') drawEquity();
  if (S.tab === 'research') {
    const sel = S.scan?.analyses?.[S.selected];
    if (sel) priceChart($('#price-canvas'), sel.bars, sel);
  }
  if (S.tab === 'academy') drawDrill();
});

try {
  const t = localStorage.getItem('crowsnest:tab');
  if (t && $(`#tab-${t}`)) S.tab = t;
} catch {
  /* ignore */
}
setTab(S.tab);
boot();
