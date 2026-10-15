// Crow's Nest self-hosted server.
// - Serves the app (web/, core/, adapters/) to your browser.
// - Runs Claude with your ANTHROPIC_API_KEY (the key never reaches the browser).
// - Runs a paper-trading broker on Yahoo market data, saved to data/.
// - Runs the autopilot: the four-agent cycle on the desk's schedule (pre-market, hourly, power hour,
//   close review, Sunday weekly plan) and an exit monitor every minute while the market is open.
//
// Start:  ANTHROPIC_API_KEY=sk-... npm start   →  http://localhost:4000

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFileStore } from './server/store.js';
import { createYahooMarket } from './server/yahoo.js';
import { serverAI, MODEL, available as aiAvailable, complete } from './server/anthropic.js';
import { createPaperBroker } from './core/paper.js';
import { createDesk } from './core/desk.js';
import { marketStatus } from './core/market-clock.js';
import { dueSlot } from './core/planner.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.CROWSNEST_DATA || join(ROOT, 'data', 'store.json');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const STATIC_DIRS = ['web', 'core', 'adapters'];

const store = await createFileStore(DATA);
let watchlist = [];
const market = createYahooMarket({ watchlist: () => watchlist });
const paper = createPaperBroker({ market, load: () => store.get('desk/paper'), save: (st) => store.set('desk/paper', st) });
const ai = serverAI();
const desk = createDesk({ market, brokers: { paper, live: null }, ai, store, log: (...a) => console.warn('[desk]', ...a) });
watchlist = (await desk.getSettings()).watchlist;

// ------------------------------------------------------------------ autopilot
const autopilot = { running: false, last: null, lastError: null, lastExitCheck: 0 };

async function autopilotTick() {
  if (autopilot.running) return;
  const settings = await desk.getSettings();
  watchlist = settings.watchlist;
  if (!settings.serverAutopilot) return;
  const now = new Date();
  const st = marketStatus(now);
  try {
    autopilot.running = true;
    // Exit monitor: every minute in regular hours (pure code, no AI cost).
    if (st.session === 'regular' && Date.now() - autopilot.lastExitCheck > 60_000) {
      autopilot.lastExitCheck = Date.now();
      const exits = await desk.checkExits({ execute: true });
      if (exits.length) console.log(`[autopilot] exits: ${exits.map((e) => `${e.symbol} ${e.status}`).join(', ')}`);
      await desk.reconcile(await desk.snapshot({ force: true }));
    }
    if (!aiAvailable()) return;
    const state = await desk.getState();
    // Weekly plan: Sunday evening, or any time the current plan is more than 6 days old.
    const plan = await desk.getPlan();
    const weeklyDue = (st.weekday === 0 && st.minutes >= 18 * 60) && (!plan.week?.createdAt || Date.now() - plan.week.createdAt > 3 * 86400000);
    const slot = weeklyDue ? { kind: 'weekly', name: 'Weekly game plan' } : dueSlot(now, state.lastCycle?.at || 0);
    if (!slot) return;
    console.log(`[autopilot] running ${slot.name} (${slot.kind})`);
    const cycle = await desk.runCycle(slot.kind);
    autopilot.last = { id: cycle.id, kind: cycle.kind, status: cycle.status, headline: cycle.headline, at: cycle.at };
    autopilot.lastError = cycle.status === 'error' ? cycle.error : null;
    console.log(`[autopilot] ${cycle.status}: ${cycle.headline || cycle.error || ''}`);
  } catch (err) {
    autopilot.lastError = err.message;
    console.error('[autopilot]', err.message);
  } finally {
    autopilot.running = false;
  }
}
setInterval(autopilotTick, 30_000).unref();

// ------------------------------------------------------------------ http
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const MARKET_METHODS = new Set(['quotes', 'bars', 'fundamentals', 'expirations', 'chain', 'optionQuotes', 'earnings', 'ratings', 'search']);
const BROKER_METHODS = new Set(['account', 'snapshot', 'preview', 'place', 'cancel', 'reset']);

const routes = {
  'GET /api/status': async () => ({ ai: aiAvailable(), model: MODEL, autopilot: { ...autopilot, enabled: !!(await desk.getSettings()).serverAutopilot }, market: marketStatus().label }),
  'POST /api/market': async ({ method, args = [] }) => {
    if (!MARKET_METHODS.has(method)) throw Object.assign(new Error('Unknown market method'), { status: 400 });
    return market[method](...args);
  },
  'POST /api/broker': async ({ method, args = [] }) => {
    if (!BROKER_METHODS.has(method)) throw Object.assign(new Error('Unknown broker method'), { status: 400 });
    return paper[method](...args);
  },
  'POST /api/ai/json': async ({ prompt, tier, effort }) => {
    if (!aiAvailable()) throw Object.assign(new Error('Set ANTHROPIC_API_KEY on the server to use the agents.'), { status: 503, code: 'not_granted' });
    return ai.json(String(prompt), { tier, effort });
  },
  'POST /api/store': async (b) => {
    switch (b.op) {
      case 'version':
        return store.version;
      case 'get':
        return store.get(b.path);
      case 'set':
        return store.set(b.path, b.data);
      case 'update':
        return store.update(b.path, b.data);
      case 'remove':
        return store.remove(b.path);
      case 'list':
        return store.list(b.collection, b);
      default:
        throw Object.assign(new Error('Unknown store op'), { status: 400 });
    }
  },
  'POST /api/autopilot': async ({ action, kind }) => {
    if (action === 'run') {
      if (autopilot.running) throw Object.assign(new Error('A cycle is already running.'), { status: 409 });
      autopilot.running = true;
      desk.runCycle(kind || 'manual').then((c) => {
        autopilot.last = { id: c.id, kind: c.kind, status: c.status, headline: c.headline, at: c.at };
      }).finally(() => (autopilot.running = false));
      return { started: true };
    }
    return autopilot;
  },
};

/** Streams a Messages API turn to the browser as newline-delimited JSON. */
async function streamMessages(req, res) {
  const body = await readBody(req);
  if (!aiAvailable()) return send(res, 503, { error: 'Set ANTHROPIC_API_KEY on the server to use the agents.', code: 'not_granted' });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const ctl = new AbortController();
  res.on('close', () => !res.writableEnded && ctl.abort());
  try {
    const message = await complete({ messages: body.messages, tools: body.tools, tier: body.tier, effort: body.effort, signal: ctl.signal, onText: (t) => res.write(JSON.stringify({ type: 'text', text: t }) + '\n') });
    res.write(JSON.stringify({ type: 'message', message: { content: message.content, stop_reason: message.stop_reason } }) + '\n');
  } catch (err) {
    res.write(JSON.stringify({ type: 'error', error: err.message, code: err.code }) + '\n');
  }
  res.end();
}

async function serveStatic(pathname, res) {
  if (pathname === '/' || pathname === '/index.html') pathname = '/web/index.html';
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (!STATIC_DIRS.some((d) => rel.startsWith(d + '/') || rel.startsWith(d + '\\'))) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) return send(res, 403, { error: 'Forbidden' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && url.pathname === '/api/ai/messages') return streamMessages(req, res).catch((e) => send(res, 500, { error: e.message }));
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return send(res, 404, { error: 'Unknown endpoint' });
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      send(res, 200, { result: (await route(body)) ?? null });
    } catch (err) {
      send(res, err.status || 500, { error: err.message || 'Server error', code: err.code });
    }
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Crow's Nest running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Claude: ${aiAvailable() ? `${MODEL} via your API key` : 'not configured (set ANTHROPIC_API_KEY)'}`);
  console.log('  Broker: paper trading on Yahoo Finance data (live Robinhood trading runs in the claude.ai version)\n');
});

for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    await store.close();
    process.exit(0);
  });
