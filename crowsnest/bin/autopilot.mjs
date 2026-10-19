#!/usr/bin/env node
// Background autopilot helper. A scheduled Claude session (see AUTOPILOT.md) uses it to run the
// exact same desk cycle as the web page, with three differences:
//   - account state comes from Robinhood connector payloads the session saved to <dir>/inputs/
//   - each agent prompt is answered by a Claude agent the session spawns (files in <dir>/agents/)
//   - orders are not sent from here: they land in <dir>/out/outbox.json for the session to send
//     through the Robinhood connector, then `finalize` records what happened.
//
// Commands
//   node bin/autopilot.mjs slot                 which check-in is due now (JSON)
//   node bin/autopilot.mjs run <dir> [kind]     run or resume a cycle (refuses once out/outbox.json exists; --force overrides)
//   node bin/autopilot.mjs deadline <dir>       whether the outbox may still be sent (JSON: now, sendBy, late)
//   node bin/autopilot.mjs finalize <dir>       apply <dir>/results.json and rebuild the writes
//
// Writes to documents that already existed are exported as `update` diffs (changed keys only, removed
// keys as {"__delete__": true}), so a conflict retry never overwrites what the owner changed meanwhile.

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDesk, PATHS } from '../core/desk.js';
import { createYahooMarket } from '../server/yahoo.js';
import { marketStatus, isTradingDay } from '../core/market-clock.js';
import { mapAccount, mapEquityQuotes, mapOptionQuotes, mapInstruments, mapFundamentals, buildSnapshot, equityInput, optionInput } from '../adapters/robinhood-map.js';
import { chunk } from '../core/util.js';

const OCC = /^[A-Z.]+\d{6}[CP]\d{8}$/;
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const [cmd, dirArg, kindArg] = argv.filter((a) => a !== '--force');

const readJson = async (p, fallback = null) => {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = async (p, v) => {
  await mkdir(resolve(p, '..'), { recursive: true });
  await writeFile(p, JSON.stringify(v, null, 2));
};

/** The check-in due now, from the New York clock. Scheduled runs fire at :45 past 8–16 and Sunday 18:00. */
export function dueKind(now = new Date()) {
  const st = marketStatus(now);
  if (st.weekday === 0) return { kind: 'weekly', name: 'Weekly game plan' };
  if (!isTradingDay(st.iso)) return { kind: 'none', name: 'Market closed today' };
  const h = st.hour;
  if (h < 9) return { kind: 'premarket', name: 'Pre-market briefing' };
  if (st.minutes >= st.close) return { kind: 'close', name: 'Close review' };
  if (st.close - st.minutes <= 45) return { kind: 'power', name: 'Power hour' };
  return { kind: 'intraday', name: 'Hourly check' };
}

// ------------------------------------------------------------------ in-memory store seeded from files
async function loadDocs(dir) {
  const docs = {};
  const versions = (await readJson(join(dir, 'inputs', 'versions.json'), {})) || {};
  const root = join(dir, 'inputs', 'db');
  async function walk(rel) {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const ent of await readdir(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(r);
      else if (ent.name.endsWith('.json')) {
        const raw = await readJson(join(root, r));
        if (!raw || typeof raw !== 'object') continue;
        const path = r.replace(/\.json$/, '');
        // ArtifactData may save {id, version, data} or the bare document.
        const body = raw.data && typeof raw.data === 'object' && ('version' in raw || 'id' in raw) ? raw.data : raw;
        if (raw.version != null && versions[path] == null) versions[path] = raw.version;
        docs[path] = body;
      }
    }
  }
  await walk('');
  const missing = Object.keys(docs).filter((p) => versions[p] == null);
  if (missing.length) throw new Error(`inputs/versions.json has no version for: ${missing.join(', ')}. Add the version each ArtifactData read reported (AUTOPILOT.md step 2).`);
  return { docs, versions, original: JSON.parse(JSON.stringify(docs)) };
}

/** Replay market data on resume, so the Operator's reply is applied to the same drafts it reviewed. */
async function cachedMarket(base, file) {
  const cache = (await readJson(file, {})) || {};
  let dirty = false;
  const out = {};
  for (const [k, fn] of Object.entries(base)) {
    if (typeof fn !== 'function') {
      out[k] = fn;
      continue;
    }
    out[k] = async (...args) => {
      const key = `${k} ${JSON.stringify(args)}`;
      if (key in cache) return JSON.parse(JSON.stringify(cache[key]));
      const v = await fn(...args);
      cache[key] = v ?? null;
      dirty = true;
      return v;
    };
  }
  out.save = async () => {
    if (dirty) await writeJson(file, cache);
  };
  return out;
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** ArtifactData `update` merges objects deeply and replaces arrays, so send only what changed. */
function diffDoc(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const a = before?.[k];
    const b = after[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (isObj(a) && isObj(b)) {
      const d = diffDoc(a, b);
      if (Object.keys(d).length) out[k] = d;
    } else out[k] = b === undefined ? null : b;
  }
  for (const k of Object.keys(before || {})) if (!(k in after)) out[k] = { __delete__: true };
  return out;
}

function memoryStore(docs) {
  const dirty = new Set();
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    dirty,
    docs,
    async get(path) {
      return clone(docs[path]);
    },
    async set(path, data) {
      docs[path] = clone(data);
      dirty.add(path);
    },
    async update(path, data) {
      docs[path] = { ...(docs[path] || {}), ...clone(data) };
      dirty.add(path);
    },
    async remove(path) {
      delete docs[path];
      dirty.add(path);
    },
    async list(collection, { orderBy, dir = 'asc', limit = 100 } = {}) {
      const depth = collection.split('/').length + 1;
      const rows = Object.keys(docs)
        .filter((k) => k.startsWith(collection + '/') && k.split('/').length === depth)
        .map((k) => ({ id: k.split('/').pop(), ...clone(docs[k]) }));
      if (orderBy) rows.sort((a, b) => ((a[orderBy] ?? Infinity) > (b[orderBy] ?? Infinity) ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      return rows.slice(0, limit);
    },
  };
}

// ------------------------------------------------------------------ Robinhood state from saved payloads
async function robinhoodState(dir, settings) {
  const rh = await readJson(join(dir, 'inputs', 'robinhood.json'));
  if (!rh) throw new Error(`Missing ${join(dir, 'inputs', 'robinhood.json')}. Save the Robinhood payloads first (AUTOPILOT.md step 3).`);
  const accounts = rh.accounts?.accounts || rh.accounts || [];
  const agentic = accounts.filter((a) => a.agentic_allowed);
  if (settings.accountNumber && !agentic.some((x) => x.account_number === settings.accountNumber)) throw new Error('The account in desk/settings is not an agentic account any more. Stopping without trading.');
  const a = agentic.find((x) => x.account_number === settings.accountNumber) || agentic[0];
  if (!a) throw new Error('No agentic Robinhood account in accounts payload.');
  const account = mapAccount(a, rh.approvalSetting);
  const quotes = Object.fromEntries(mapEquityQuotes(rh.equityQuotes).map((q) => [q.symbol, q]));
  const meta = mapInstruments(rh.optionInstruments);
  const oq = mapOptionQuotes(rh.optionQuotes);
  const optionQuotes = Object.fromEntries(Object.keys({ ...meta, ...oq }).map((id) => [id, { ...meta[id], ...oq[id] }]));
  const list = (x, key) => (Array.isArray(x) ? x : x?.[key] || []);
  const snap = buildSnapshot({
    account,
    portfolio: rh.portfolio,
    stockPositions: list(rh.equityPositions, 'positions'),
    optionPositions: list(rh.optionPositions, 'positions'),
    quotes,
    optionQuotes,
    equityOrders: list(rh.equityOrders, 'orders'),
    optionOrders: list(rh.optionOrders, 'orders'),
    approvals: list(rh.approvals, 'approvals'),
    pnlTrades: list(rh.pnl, 'trades'),
  });
  const fundamentals = {};
  for (const payload of [].concat(rh.fundamentals || [])) {
    for (const [sym, f] of Object.entries(mapFundamentals(payload))) fundamentals[sym] = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  }
  return { account, snap, fundamentals };
}

// ------------------------------------------------------------------ exports for ArtifactData
async function exportWrites(dir, store, versions, original = {}) {
  const outDocs = join(dir, 'out', 'docs');
  await rm(outDocs, { recursive: true, force: true });
  const entries = [];
  for (const path of [...store.dirty].sort()) {
    const parts = path.split('/');
    const doc_id = parts.pop();
    const collection = parts.join('/');
    const existed = versions[path] != null;
    const now = store.docs[path];
    if (!now && !existed) continue; // created and removed in the same run
    const entry = { op: !now ? 'delete' : existed ? 'update' : 'set', collection, doc_id };
    if (now) {
      const body = existed ? diffDoc(original[path] || {}, now) : now;
      if (existed && !Object.keys(body).length) continue; // nothing changed
      const file = join(outDocs, collection, doc_id + '.json');
      await writeJson(file, body);
      entry.file_path = resolve(file);
    }
    if (existed) entry.if_version = versions[path];
    entries.push(entry);
  }
  // The page reads cycles before intents, so write desk/* last: the plan and state then point at
  // documents that already exist.
  entries.sort((a, b) => (a.collection === 'desk') - (b.collection === 'desk'));
  const batches = chunk(entries, 50);
  for (const [i, b] of batches.entries()) await writeJson(join(dir, 'out', `writes-${i + 1}.json`), b);
  return { count: entries.length, batches: batches.length };
}

// ------------------------------------------------------------------ run
async function run(dir, kind) {
  if (existsSync(join(dir, 'out', 'outbox.json')) && !force) {
    throw new Error(`This cycle already finished: ${join(dir, 'out', 'outbox.json')} exists. Continue at step 6 with those same orders and ref_ids; never run the cycle again (that would create new orders).`);
  }
  const { docs, versions, original } = await loadDocs(dir);
  const store = memoryStore(docs);
  const settingsDoc = docs[PATHS.settings] || {};
  if (settingsDoc.broker !== 'live') {
    console.log(JSON.stringify({ status: 'skipped', reason: 'The desk is in paper mode; the background autopilot only trades the live account.' }));
    return;
  }
  const { snap, fundamentals: rhFund } = await robinhoodState(dir, settingsDoc);
  const market = await cachedMarket(createYahooMarket({ watchlist: () => settingsDoc.watchlist || [] }), join(dir, 'cache', 'market.json'));
  // Robinhood's fundamentals (market cap above all) win over Yahoo's, which can fail without a cookie.
  const yahooFundamentals = market.fundamentals;
  market.fundamentals = async (symbols) => {
    const y = (await yahooFundamentals(symbols).catch(() => ({}))) || {};
    const out = { ...y };
    for (const sym of symbols) if (rhFund[sym]) out[sym] = { ...(y[sym] || {}), ...rhFund[sym] };
    return out;
  };
  const outbox = [];
  const cancels = [];
  const broker = {
    live: true,
    kind: 'robinhood-outbox',
    label: 'Robinhood',
    account: async () => snap.account,
    snapshot: async () => snap,
    preview: async () => ({ ok: true, alerts: [] }), // the real review_* call happens when the session sends
    place: async (t) => {
      outbox.push(t);
      return { ok: true, state: 'outbox' };
    },
    cancel: async (order) => {
      cancels.push(order);
      return { ok: true };
    },
  };
  const agentsDir = join(dir, 'agents');
  const promptsDir = join(dir, 'prompts');
  const ai = {
    available: true,
    async json(prompt, { agent } = {}) {
      const file = join(agentsDir, `${agent}.json`);
      if (existsSync(file)) {
        const v = await readJson(file);
        if (v == null) throw Object.assign(new Error(`${file} is not valid JSON`), { code: 'invalid_json' });
        return v;
      }
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, `${agent}.txt`), prompt);
      throw Object.assign(new Error(`need ${agent}`), { code: 'need_agent', agent });
    },
    async text() {
      throw new Error('Text replies are not used by the autopilot.');
    },
  };
  const desk = createDesk({ market, brokers: { live: broker, paper: broker }, ai, store, log: (...a) => console.error('[desk]', ...a) });
  const cycle = await desk.runCycle(kind, { source: 'autopilot', prune: false });
  await market.save();
  if (cycle.status === 'paused') {
    const need = ['scout', 'analyst', 'honcho', 'operator'].filter((a) => existsSync(join(promptsDir, `${a}.txt`)) && !existsSync(join(agentsDir, `${a}.json`)));
    console.log(JSON.stringify({ status: 'need_agents', agents: need, prompts: need.map((a) => resolve(join(promptsDir, `${a}.txt`))), replies: need.map((a) => resolve(join(agentsDir, `${a}.json`))) }, null, 2));
    process.exitCode = 3;
    return;
  }
  // Orders the cycle wants sent: mark their intents "sending" until finalize records the outcome.
  const accountNumber = snap.account.number;
  // Send nothing after this: prices go stale, and a market order sent after the close would run at the next open.
  const st = marketStatus(new Date());
  const sendBy = new Date(Date.now() + (st.session === 'regular' ? Math.min(15, Math.max(0, st.minutesToClose - 1)) : 10) * 60000).toISOString();
  const orders = [];
  for (const t of outbox) {
    const path = `${PATHS.intents}/${t.id}`;
    if (store.docs[path]) await store.update(path, { status: 'sending', updatedAt: Date.now() });
    const isOption = t.kind === 'option';
    const input = { ...(isOption ? optionInput(t, accountNumber) : equityInput(t, accountNumber)), ref_id: t.id };
    const opening = t.positionEffect === 'open' && !(t.kind === 'stock' && t.side === 'sell');
    const lastPx = snap.stocks.find((x) => x.symbol === t.symbol)?.price ?? (await market.quotes([t.symbol]).catch(() => []))[0]?.price ?? null;
    orders.push({
      intentId: t.id,
      headline: store.docs[path]?.headline,
      kind: t.kind,
      symbol: t.symbol,
      review_tool: isOption ? 'review_option_order' : 'review_equity_order',
      place_tool: isOption ? 'place_option_order' : 'place_equity_order',
      review_extra: isOption ? { chain_symbol: t.symbol, underlying_type: 'equity' } : {},
      input,
      opening, // false = closes a position: still sent when the kill switch is on, and exempt from the price check
      refPrice: isOption ? t.price : t.limitPrice ?? lastPx,
      legsToResolve: isOption ? t.legs.map((l, index) => ({ index, occ: l.contractId, chain_symbol: t.symbol, expiration_date: l.expiration, strike_price: Number(l.strike).toFixed(4), type: l.right })).filter((l) => OCC.test(l.occ)) : [],
    });
  }
  await writeJson(join(dir, 'out', 'outbox.json'), { accountNumber, sendBy, orders, cancels: cancels.map((o) => ({ tool: o.kind === 'option' ? 'cancel_option_order' : 'cancel_equity_order', input: { account_number: accountNumber, order_id: o.id }, symbol: o.symbol })) });
  const dirtyPaths = [...store.dirty];
  await writeJson(join(dir, 'out', 'state.json'), { docs: Object.fromEntries(dirtyPaths.map((p) => [p, store.docs[p] ?? null])), versions, original: Object.fromEntries(dirtyPaths.filter((p) => original[p]).map((p) => [p, original[p]])), cycleId: cycle.id });
  const w = await exportWrites(dir, store, versions, original);
  const summary = [
    `Cycle ${cycle.id} (${cycle.kind}) ${cycle.status}: ${cycle.headline || cycle.error || ''}`,
    cycle.summary || '',
    ...(cycle.results || []).map((r) => `- ${r.symbol}: ${r.status} — ${r.summary}`),
    `Orders to send: ${orders.length}. Cancels: ${cancels.length}. Documents to write: ${w.count} in ${w.batches} batch file(s).`,
  ].join('\n');
  await writeFile(join(dir, 'out', 'summary.txt'), summary);
  console.log(summary);
}

// ------------------------------------------------------------------ finalize
async function finalize(dir) {
  const saved = await readJson(join(dir, 'out', 'state.json'));
  if (!saved) throw new Error('Run the cycle first.');
  const results = await readJson(join(dir, 'results.json'));
  if (!Array.isArray(results)) throw new Error(`${join(dir, 'results.json')} is missing or is not a JSON array. Write one entry per outbox order (AUTOPILOT.md step 7), or [] when there were none.`);
  const outbox = (await readJson(join(dir, 'out', 'outbox.json'))) || { orders: [] };
  const unrecorded = (outbox.orders || []).filter((o) => !results.some((r) => r.intentId === o.intentId));
  if (unrecorded.length) throw new Error(`results.json has no entry for: ${unrecorded.map((o) => `${o.intentId} (${o.headline || o.symbol})`).join(', ')}. Record every outbox order, sent or not.`);
  const store = memoryStore({ ...saved.docs });
  for (const p of Object.keys(saved.docs)) if (saved.docs[p] != null || (saved.versions || {})[p] != null) store.dirty.add(p);
  for (const p of Object.keys(saved.docs)) if (saved.docs[p] == null) delete store.docs[p];
  const cyclePath = saved.cycleId ? `cycles/${saved.cycleId}` : null;
  const exitsPath = PATHS.exits;
  const exits = store.docs[exitsPath]?.plans ? JSON.parse(JSON.stringify(store.docs[exitsPath])) : null;
  for (const r of results) {
    const path = `${PATHS.intents}/${r.intentId}`;
    const intent = store.docs[path];
    if (!intent) continue;
    const idmap = r.optionIds || {};
    if (intent.ticket?.legs) intent.ticket.legs = intent.ticket.legs.map((l) => ({ ...l, contractId: idmap[l.contractId] || l.contractId }));
    intent.status = r.status || 'failed';
    intent.broker = { orderId: r.orderId || null, approvalPending: r.status === 'pending_approval', alerts: r.alerts || [], message: r.message || '' };
    intent.updatedAt = Date.now();
    await store.set(path, intent);
    const row = cyclePath && store.docs[cyclePath]?.results?.find((x) => x.intentId === r.intentId);
    if (row) {
      row.status = intent.status;
      row.broker = intent.broker;
      store.dirty.add(cyclePath);
    }
    if (exits) {
      for (const [occ, rhId] of Object.entries(idmap)) {
        if (exits.plans[occ]) {
          exits.plans[rhId] = exits.plans[occ];
          delete exits.plans[occ];
        }
      }
      if (!['sent', 'pending_approval', 'filled', 'working'].includes(intent.status)) {
        const key = intent.ticket?.kind === 'stock' ? intent.ticket.symbol : idmap[intent.ticket?.legs?.[0]?.contractId] || intent.ticket?.legs?.[0]?.contractId;
        if (key && exits.plans[key]?.intentId === intent.id) delete exits.plans[key];
      }
    }
  }
  if (exits) await store.set(exitsPath, exits);
  const w = await exportWrites(dir, store, saved.versions || {}, saved.original || {});
  console.log(JSON.stringify({ status: 'finalized', updated: results.length, documents: w.count, batches: w.batches }));
}

try {
  if (cmd === 'slot') console.log(JSON.stringify(dueKind()));
  else if (cmd === 'run' && dirArg) {
    const kind = kindArg || dueKind().kind;
    if (kind === 'none') console.log(JSON.stringify({ status: 'skipped', reason: 'Market closed today.' }));
    else await run(resolve(dirArg), kind);
  } else if (cmd === 'deadline' && dirArg) {
    const box = await readJson(join(resolve(dirArg), 'out', 'outbox.json'));
    if (!box) throw new Error('No out/outbox.json: run the cycle first.');
    const late = !box.sendBy || Date.now() >= Date.parse(box.sendBy);
    console.log(JSON.stringify({ now: new Date().toISOString(), sendBy: box.sendBy || null, late }));
  } else if (cmd === 'finalize' && dirArg) await finalize(resolve(dirArg));
  else {
    console.error('Usage: node bin/autopilot.mjs slot | run <dir> [kind] | deadline <dir> | finalize <dir>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`autopilot: ${err.message}`);
  process.exitCode = 1;
}
