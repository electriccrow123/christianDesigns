// Small shared helpers. Pure and dependency-free so they run in the browser and in Node.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);
export const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
export const pos = (v) => (num(v) > 0 ? num(v) : undefined);
export const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
export const mean = (arr) => (arr.length ? sum(arr) / arr.length : NaN);
export const last = (arr, n = 1) => arr[arr.length - n];
export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
export const uniq = (arr) => [...new Set(arr)];

export function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(sum(arr.map((x) => (x - m) ** 2)) / (arr.length - 1));
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const shortId = () => uuid().replace(/-/g, '').slice(0, 12);

// ---------------------------------------------------------------- formatting
export function money(v, { sign = false, dp } = {}) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const digits = dp ?? (abs > 0 && abs < 1 ? 4 : 2);
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
  if (v < 0) return `−$${s}`;
  return `${sign && v > 0 ? '+' : ''}$${s}`;
}

export function pct(v, { sign = true, dp = 2 } = {}) {
  if (!Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(dp);
  if (v < 0) return `−${s}%`;
  return `${sign && v > 0 ? '+' : ''}${s}%`;
}

export function qty(v) {
  if (!Number.isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(v < 1 ? 6 : 4).replace(/0+$/, '').replace(/\.$/, '');
}

export function compact(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

/** HTML-escape anything that came from a user, a broker or a model before it reaches innerHTML. */
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Mask an account number to its last four digits, as Robinhood asks. */
export const maskAccount = (n) => (n ? '••••' + String(n).slice(-4) : '—');

// ---------------------------------------------------------------- JSON from model replies
/**
 * Read a JSON value out of a model reply: the whole reply, else a fenced block,
 * else the span from the first { or [ to the last } or ].
 */
export function parseJsonLoose(text) {
  if (text == null) throw new Error('Empty reply');
  if (typeof text === 'object') return text;
  const t = String(text).trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (starts.length) {
    const s = Math.min(...starts);
    const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (e > s) return JSON.parse(t.slice(s, e + 1));
  }
  throw new Error('Reply held no JSON');
}

/** Keep a value small enough to put in a prompt: trims long arrays and strings. */
export function slim(value, { maxArray = 30, maxString = 600, depth = 0 } = {}) {
  if (depth > 8) return undefined;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((v) => slim(v, { maxArray, maxString, depth: depth + 1 }));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null || v === '') continue;
      out[k] = slim(v, { maxArray, maxString, depth: depth + 1 });
    }
    return out;
  }
  if (typeof value === 'number') return Number.isInteger(value) ? value : round(value, Math.abs(value) < 1 ? 4 : 2);
  if (typeof value === 'string' && value.length > maxString) return value.slice(0, maxString) + '…';
  return value;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async jobs with a concurrency cap. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        out[idx] = { error: err };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Round a price to a valid tick: pennies at or above $1, 4 decimals for sub-dollar stocks. */
export function tickRound(price, { option = false, direction = 'nearest' } = {}) {
  if (!Number.isFinite(price)) return price;
  let tick;
  if (option) tick = price < 3 ? 0.01 : 0.05;
  else tick = price >= 1 ? 0.01 : 0.0001;
  const f = direction === 'up' ? Math.ceil : direction === 'down' ? Math.floor : Math.round;
  return round(f(price / tick - 1e-9 * (direction === 'up' ? 1 : direction === 'down' ? -1 : 0)) * tick, tick < 0.01 ? 4 : 2);
}

/**
 * Bid/ask you can trust: some feeds report stale or one-sided quotes. Any side more than 1.5% away
 * from the last price is replaced by the last price.
 */
export function saneQuote(q = {}) {
  const price = q.price || q.last || 0;
  if (!price) return { price, bid: q.bid, ask: q.ask };
  const ok = (v) => v > 0 && Math.abs(v - price) / price <= 0.015;
  return { price, bid: ok(q.bid) ? q.bid : price, ask: ok(q.ask) ? q.ask : price };
}
