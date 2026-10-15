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
//   node bin/autopilot.mjs run <dir> [kind]     run or resume a cycle
//   node bin/autopilot.mjs finalize <dir>       apply <dir>/results.json and rebuild the writes

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDesk, PATHS } from '../core/desk.js';
import { createYahooMarket } from '../server/yahoo.js';
import { marketStatus, isTradingDay } from '../core/market-clock.js';
import { mapAccount, mapEquityQuotes, mapOptionQuotes, mapInstruments, buildSnapshot, equityInput, optionInput } from '../adapters/robinhood-map.js';
import { chunk } from '../core/util.js';

const OCC = /^[A-Z.]+\d{6}[CP]\d{8}$/;
const [, , cmd, dirArg, kindArg] = process.argv;

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
  return { docs, versions };
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
  return { account, snap };
}

// ------------------------------------------------------------------ exports for ArtifactData
async function exportWrites(dir, store, versions) {
  const outDocs = join(dir, 'out', 'docs');
  await rm(outDocs, { recursive: true, force: true });
  const entries = [];
  for (const path of [...store.dirty].sort()) {
    const parts = path.split('/');
    const doc_id = parts.pop();
    const collection = parts.join('/');
    const entry = { op: store.docs[path] ? 'set' : 'delete', collection, doc_id };
    if (store.docs[path]) {
      const file = join(outDocs, collection, doc_id + '.json');
      await writeJson(file, store.docs[path]);
      entry.file_path = resolve(file);
    }
    if (versions[path] != null) entry.if_version = versions[path];
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
  const { docs, versions } = await loadDocs(dir);
  const store = memoryStore(docs);
  const settingsDoc = docs[PATHS.settings] || {};
  if (settingsDoc.broker !== 'live') {
    console.log(JSON.stringify({ status: 'skipped', reason: 'The desk is in paper mode; the background autopilot only trades the live account.' }));
    return;
  }
  const { snap } = await robinhoodState(dir, settingsDoc);
  const market = createYahooMarket({ watchlist: () => settingsDoc.watchlist || [] });
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
  if (cycle.status === 'paused') {
    const need = ['scout', 'analyst', 'honcho', 'operator'].filter((a) => existsSync(join(promptsDir, `${a}.txt`)) && !existsSync(join(agentsDir, `${a}.json`)));
    console.log(JSON.stringify({ status: 'need_agents', agents: need, prompts: need.map((a) => resolve(join(promptsDir, `${a}.txt`))), replies: need.map((a) => resolve(join(agentsDir, `${a}.json`))) }, null, 2));
    process.exitCode = 3;
    return;
  }
  // Orders the cycle wants sent: mark their intents "sending" until finalize records the outcome.
  const accountNumber = snap.account.number;
  const orders = [];
  for (const t of outbox) {
    const path = `${PATHS.intents}/${t.id}`;
    if (store.docs[path]) await store.update(path, { status: 'sending', updatedAt: Date.now() });
    const isOption = t.kind === 'option';
    const input = { ...(isOption ? optionInput(t, accountNumber) : equityInput(t, accountNumber)), ref_id: t.id };
    orders.push({
      intentId: t.id,
      headline: store.docs[path]?.headline,
      kind: t.kind,
      symbol: t.symbol,
      review_tool: isOption ? 'review_option_order' : 'review_equity_order',
      place_tool: isOption ? 'place_option_order' : 'place_equity_order',
      review_extra: isOption ? { chain_symbol: t.symbol, underlying_type: 'equity' } : {},
      input,
      refPrice: isOption ? t.price : t.limitPrice ?? null,
      legsToResolve: isOption ? t.legs.map((l, index) => ({ index, occ: l.contractId, chain_symbol: t.symbol, expiration_date: l.expiration, strike_price: Number(l.strike).toFixed(4), type: l.right })).filter((l) => OCC.test(l.occ)) : [],
    });
  }
  await writeJson(join(dir, 'out', 'outbox.json'), { accountNumber, orders, cancels: cancels.map((o) => ({ tool: o.kind === 'option' ? 'cancel_option_order' : 'cancel_equity_order', input: { account_number: accountNumber, order_id: o.id }, symbol: o.symbol })) });
  await writeJson(join(dir, 'out', 'state.json'), { docs: Object.fromEntries([...store.dirty].map((p) => [p, store.docs[p] ?? null])), versions });
  const w = await exportWrites(dir, store, versions);
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
  const results = (await readJson(join(dir, 'results.json'), [])) || [];
  const store = memoryStore({ ...saved.docs });
  for (const p of Object.keys(saved.docs)) store.dirty.add(p);
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
  const w = await exportWrites(dir, store, saved.versions || {});
  console.log(JSON.stringify({ status: 'finalized', updated: results.length, documents: w.count, batches: w.batches }));
}

try {
  if (cmd === 'slot') console.log(JSON.stringify(dueKind()));
  else if (cmd === 'run' && dirArg) {
    const kind = kindArg || dueKind().kind;
    if (kind === 'none') console.log(JSON.stringify({ status: 'skipped', reason: 'Market closed today.' }));
    else await run(resolve(dirArg), kind);
  } else if (cmd === 'finalize' && dirArg) await finalize(resolve(dirArg));
  else {
    console.error('Usage: node bin/autopilot.mjs slot | run <dir> [kind] | finalize <dir>');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(`autopilot: ${err.message}`);
  process.exitCode = 1;
}
