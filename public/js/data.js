// Market data provider for the self-hosted version: talks to server.js (/api/*).
// The published web version swaps this file for data-robinhood.js, which has the same exports.

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const priceLabel = 'Last';

export async function quotes(symbols) {
  if (!symbols.length) return [];
  const { quotes: list } = await api(`/api/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
  return list;
}

/** -> { points: [[unixSeconds, close]], previousClose } */
export function chart(symbol, range) {
  return api(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}`);
}

/** -> { symbol, expirations: [unix], expiration, underlying, calls: [contract], puts: [contract] } */
export function chain(symbol, date) {
  return api(`/api/options?symbol=${encodeURIComponent(symbol)}${date ? `&date=${date}` : ''}`);
}

/** Fresh quotes for held / ordered contracts. contracts: [{ contract, symbol, expiration }] -> { contractId: quote } */
export async function contractQuotes(contracts) {
  const groups = new Map();
  for (const c of contracts) groups.set(`${c.symbol}|${c.expiration}`, c);
  const out = {};
  await Promise.all(
    [...groups.values()].map(async ({ symbol, expiration }) => {
      try {
        const ch = await chain(symbol, expiration);
        for (const c of ch.calls) out[c.contract] = { ...c, symbol, right: 'call' };
        for (const c of ch.puts) out[c.contract] = { ...c, symbol, right: 'put' };
      } catch {
        /* keep last known marks */
      }
    }),
  );
  return out;
}

export async function search(q) {
  const { results } = await api(`/api/search?q=${encodeURIComponent(q)}`);
  return results;
}

// The self-hosted version keeps the game in browser storage only.
export async function loadGame() {
  return null;
}
export function saveGame() {}
