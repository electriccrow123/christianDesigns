// Self-hosted runtime (browser side): everything goes through server.js. Claude runs on the server
// with your API key; the browser drives the tool loop for chat so page tools run here.

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `Request failed (${res.status})`);
    e.code = data.code;
    throw e;
  }
  return data.result;
}

const proxy = (base, methods) => Object.fromEntries(methods.map((m) => [m, (...args) => post(base, { method: m, args })]));

function createAI() {
  async function json(prompt, o = {}) {
    return post('/api/ai/json', { prompt, tier: o.tier, effort: o.effort, agent: o.agent });
  }
  /** Chat-style call with optional page tools; runs the tool loop here in the browser. */
  async function text(input, o = {}) {
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map((m) => ({ role: m.role, content: m.content }));
    const tools = (o.tools || []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
    let full = '';
    for (let round = 0; round < 8; round++) {
      const res = await fetch('/api/ai/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, tools, tier: o.tier, effort: o.effort }),
        signal: o.signal,
      }).catch((err) => {
        throw Object.assign(new Error(o.signal?.aborted ? 'Stopped.' : err.message), { code: o.signal?.aborted ? 'cancelled' : 'upstream_error' });
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw Object.assign(new Error(data.error || `Claude request failed (${res.status})`), { code: data.code });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let message = null;
      const prefix = full ? full + '\n\n' : '';
      let turnText = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'text') {
            turnText += ev.text;
            o.onText?.({ text: prefix + turnText, delta: ev.text });
          } else if (ev.type === 'message') message = ev.message;
          else if (ev.type === 'error') throw Object.assign(new Error(ev.error), { code: ev.code });
        }
      }
      if (!message) throw Object.assign(new Error('No reply from Claude.'), { code: 'upstream_error' });
      if (turnText) full = prefix + turnText;
      if (message.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request.'), { code: 'refused', text: full });
      const uses = (message.content || []).filter((b) => b.type === 'tool_use');
      if (message.stop_reason !== 'tool_use' || !uses.length) return { text: full || '(no reply)', truncated: message.stop_reason === 'max_tokens' };
      messages.push({ role: 'assistant', content: message.content });
      const results = await Promise.all(
        uses.map(async (u) => {
          const tool = (o.tools || []).find((t) => t.name === u.name);
          try {
            const out = tool ? await tool.execute(u.input || {}, { signal: o.signal }) : `Unknown tool ${u.name}`;
            return { type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 30000) };
          } catch (err) {
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Error: ${err.message}` };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    return { text: full, truncated: true };
  }
  return { available: true, json, text };
}

function createStore() {
  let version = -1;
  const watchers = new Set();
  let timer = null;
  async function poll() {
    try {
      const v = await post('/api/store', { op: 'version' });
      if (v !== version) {
        version = v;
        for (const w of watchers) w();
      }
    } catch {
      /* server briefly away */
    }
  }
  function ensureTimer() {
    if (!timer) timer = setInterval(poll, 4000);
  }
  const store = {
    kind: 'server',
    get: (path) => post('/api/store', { op: 'get', path }),
    set: async (path, data) => {
      await post('/api/store', { op: 'set', path, data });
      setTimeout(poll, 50);
    },
    update: (path, data) => post('/api/store', { op: 'update', path, data }),
    remove: (path) => post('/api/store', { op: 'remove', path }),
    list: (collection, opts = {}) => post('/api/store', { op: 'list', collection, ...opts }),
    watch(path, cb) {
      const fn = async () => cb(await store.get(path).catch(() => null));
      watchers.add(fn);
      ensureTimer();
      fn();
      return () => watchers.delete(fn);
    },
    watchList(collection, opts, cb) {
      const fn = async () => cb(await store.list(collection, opts).catch(() => []));
      watchers.add(fn);
      ensureTimer();
      fn();
      return () => watchers.delete(fn);
    },
  };
  return store;
}

export async function createLocalRuntime() {
  const status = await fetch('/api/status').then((r) => r.json()).catch(() => ({}));
  const market = proxy('/api/market', ['quotes', 'bars', 'fundamentals', 'expirations', 'chain', 'optionQuotes', 'earnings', 'ratings', 'search']);
  const paper = { live: false, kind: 'paper', label: 'Paper account', ...proxy('/api/broker', ['account', 'snapshot', 'preview', 'place', 'cancel', 'reset']) };
  return {
    kind: 'local',
    hasDb: true,
    market,
    brokers: { live: null, paper },
    ai: status.ai ? createAI() : null,
    store: createStore(),
    capabilities: { mcp: false, sample: !!status.ai, db: true },
    server: status,
  };
}
