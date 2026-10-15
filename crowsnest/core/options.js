// Options math: Black-Scholes pricing and Greeks, expected moves, strategy risk, and contract selection.

import { round, clamp } from './util.js';
import { daysBetween } from './market-clock.js';

export const MULTIPLIER = 100;
const RATE = 0.04; // risk-free rate assumption

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Black-Scholes price and Greeks. t in years, iv as a decimal (0.45 = 45%). Theta is per calendar day. */
export function blackScholes({ spot, strike, t, iv, right, rate = RATE }) {
  if (!(spot > 0 && strike > 0)) return null;
  if (!(t > 0) || !(iv > 0)) {
    const intrinsic = right === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
    return { price: intrinsic, delta: intrinsic > 0 ? (right === 'call' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, probITM: intrinsic > 0 ? 1 : 0 };
  }
  const sq = iv * Math.sqrt(t);
  const d1 = (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / sq;
  const d2 = d1 - sq;
  const disc = Math.exp(-rate * t);
  const call = right === 'call';
  const price = call ? spot * normCdf(d1) - strike * disc * normCdf(d2) : strike * disc * normCdf(-d2) - spot * normCdf(-d1);
  const delta = call ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (spot * sq);
  const vega = (spot * normPdf(d1) * Math.sqrt(t)) / 100;
  const thetaYear = call
    ? (-spot * normPdf(d1) * iv) / (2 * Math.sqrt(t)) - rate * strike * disc * normCdf(d2)
    : (-spot * normPdf(d1) * iv) / (2 * Math.sqrt(t)) + rate * strike * disc * normCdf(-d2);
  return { price, delta, gamma, theta: thetaYear / 365, vega, probITM: call ? normCdf(d2) : normCdf(-d2) };
}

/** Implied volatility from an option price (bisection). Returns undefined when the price is not usable. */
export function impliedVol({ price, spot, strike, t, right }) {
  if (!(price > 0 && spot > 0 && strike > 0 && t > 0)) return undefined;
  const intrinsic = right === 'call' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  if (price <= intrinsic + 1e-6) return undefined;
  let lo = 0.01;
  let hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const p = blackScholes({ spot, strike, t, iv: mid, right })?.price ?? 0;
    if (p > price) hi = mid;
    else lo = mid;
  }
  const iv = (lo + hi) / 2;
  return iv > 0.011 && iv < 4.99 ? iv : undefined;
}

/** Days to expiration from an ISO date, counting today as day 0. */
export function dte(expirationIso, todayIso) {
  return Math.max(0, daysBetween(todayIso, expirationIso));
}

/** One-standard-deviation expected move over `days` calendar days. */
export function expectedMove(price, iv, days) {
  if (!(price > 0 && iv > 0 && days >= 0)) return undefined;
  return price * iv * Math.sqrt(Math.max(days, 0.5) / 365);
}

/** Fill in delta/theta/etc. from Black-Scholes when the data source did not supply them. */
export function enrichContract(c, spot, todayIso) {
  const days = dte(c.expiration, todayIso);
  const mid = c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.mark || c.last || 0;
  const out = { ...c, dte: days, mid: round(mid, 4) };
  out.spreadPct = c.ask > 0 && mid > 0 ? round(((c.ask - c.bid) / mid) * 100, 1) : undefined;
  const t = Math.max(days, 0.25) / 365;
  // Some feeds report a near-zero IV when the book is empty; re-derive it from the price instead.
  if (!(c.iv > 0.03) && spot > 0) {
    const derived = impliedVol({ price: mid, spot, strike: c.strike, t, right: c.right });
    if (derived) out.iv = derived;
    else delete out.iv;
    if (c.delta != null && !(c.iv > 0.03)) out.delta = undefined;
  }
  if (spot > 0 && out.iv > 0) {
    const g = blackScholes({ spot, strike: c.strike, t, iv: out.iv, right: c.right });
    if (g) {
      if (out.delta == null) out.delta = round(g.delta, 3);
      if (out.gamma == null) out.gamma = round(g.gamma, 4);
      if (out.theta == null) out.theta = round(g.theta, 4);
      if (out.vega == null) out.vega = round(g.vega, 4);
      out.probITM = round(g.probITM, 3);
    }
  }
  out.breakeven = round(c.right === 'call' ? c.strike + mid : c.strike - mid, 2);
  out.intrinsic = round(spot ? (c.right === 'call' ? Math.max(0, spot - c.strike) : Math.max(0, c.strike - spot)) : 0, 2);
  return out;
}

/**
 * Score and pick contracts that fit a plan.
 * want: { right, targetDelta, minDte, maxDte, maxSpreadPct, minOpenInterest, maxPremium (per contract $) }
 * Returns contracts sorted best-first with a `fit` score and `why` notes.
 */
export function rankContracts(contracts, want) {
  const target = Math.abs(want.targetDelta ?? 0.5);
  const out = [];
  for (const c of contracts) {
    if (c.right !== want.right) continue;
    if (want.minDte != null && c.dte < want.minDte) continue;
    if (want.maxDte != null && c.dte > want.maxDte) continue;
    const price = c.ask > 0 ? c.ask : c.mid;
    if (!(price > 0)) continue;
    const cost = price * MULTIPLIER;
    if (want.maxPremium != null && cost > want.maxPremium) continue;
    const why = [];
    let fit = 100;
    if (c.delta == null) {
      fit -= 45;
      why.push('delta unknown');
    } else fit -= Math.abs(Math.abs(c.delta) - target) * 160;
    if (c.spreadPct != null) {
      fit -= Math.max(0, c.spreadPct - 4) * 2;
      if (want.maxSpreadPct != null && c.spreadPct > want.maxSpreadPct) {
        fit -= 40;
        why.push(`wide spread ${c.spreadPct}%`);
      }
    }
    const oi = c.openInterest ?? 0;
    if (oi < (want.minOpenInterest ?? 0)) {
      fit -= 30;
      why.push(`thin open interest ${oi}`);
    }
    fit += Math.min(10, Math.log10(oi + 1) * 3) + Math.min(6, Math.log10((c.volume ?? 0) + 1) * 2);
    if (want.preferDte != null) fit -= Math.abs(c.dte - want.preferDte) * 0.4;
    out.push({ ...c, fit: Math.round(fit), costPerContract: round(cost, 2), why });
  }
  return out.sort((a, b) => b.fit - a.fit);
}

/**
 * Risk profile for a single- or multi-leg position, per 1 unit (quantity 1), in dollars.
 * legs: [{ right, strike, side: 'buy'|'sell', price }]  (price = per-share premium)
 */
export function strategyRisk(legs, spot) {
  const netDebit = legs.reduce((a, l) => a + (l.side === 'buy' ? 1 : -1) * (l.price || 0), 0);
  // Evaluate payoff at expiration across a wide grid of prices, plus the kinks.
  const strikes = legs.map((l) => l.strike);
  const lo = Math.max(0, Math.min(spot, ...strikes) * 0.2);
  const hi = Math.max(spot, ...strikes) * 2.5;
  const grid = [lo, hi, ...strikes];
  for (let i = 0; i <= 200; i++) grid.push(lo + ((hi - lo) * i) / 200);
  const payoff = (S) =>
    legs.reduce((a, l) => {
      const intrinsic = l.right === 'call' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S);
      return a + (l.side === 'buy' ? 1 : -1) * intrinsic;
    }, 0) - netDebit;
  const vals = grid.map(payoff);
  let maxProfit = Math.max(...vals);
  let maxLoss = Math.min(...vals);
  // Unlimited upside/downside checks
  const unlimitedUp = payoff(hi * 2) > payoff(hi) + 1e-6;
  const unlimitedDownLoss = payoff(hi * 2) < payoff(hi) - 1e-6;
  const breakevens = [];
  const sorted = [...new Set(grid)].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const a = payoff(sorted[i - 1]);
    const b = payoff(sorted[i]);
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) breakevens.push(round(sorted[i - 1] + ((0 - a) * (sorted[i] - sorted[i - 1])) / (b - a), 2));
  }
  return {
    netDebit: round(netDebit * MULTIPLIER, 2),
    maxProfit: unlimitedUp ? Infinity : round(maxProfit * MULTIPLIER, 2),
    maxLoss: unlimitedDownLoss ? -Infinity : round(maxLoss * MULTIPLIER, 2),
    breakevens: [...new Set(breakevens)],
  };
}

/** Human description of a strategy key. */
export const STRATEGIES = {
  stock: { name: 'Buy shares', level: 0, risk: 'Can lose what you paid; no expiration.' },
  long_call: { name: 'Long call', level: 2, risk: 'Max loss = premium paid. Needs the stock to rise past breakeven before expiration.' },
  long_put: { name: 'Long put', level: 2, risk: 'Max loss = premium paid. Needs the stock to fall past breakeven before expiration.' },
  covered_call: { name: 'Covered call', level: 2, risk: 'Caps your upside on 100 shares in exchange for income.' },
  cash_secured_put: { name: 'Cash-secured put', level: 2, risk: 'You may have to buy 100 shares at the strike; cash is set aside for that.' },
  call_debit_spread: { name: 'Call debit spread', level: 3, risk: 'Cheaper bullish bet with capped profit; max loss = net debit.' },
  put_debit_spread: { name: 'Put debit spread', level: 3, risk: 'Cheaper bearish bet with capped profit; max loss = net debit.' },
  put_credit_spread: { name: 'Put credit spread', level: 3, risk: 'Collect premium betting the stock stays above the short strike; max loss = width − credit.' },
  call_credit_spread: { name: 'Call credit spread', level: 3, risk: 'Collect premium betting the stock stays below the short strike; max loss = width − credit.' },
};

export function optionLevelNumber(level) {
  const m = String(level || '').match(/(\d)/);
  return m ? Number(m[1]) : 0;
}

/** Short OCC-style label: "NVDA 11/21 $140C". */
export function contractLabel(c) {
  if (!c) return '';
  const [y, m, d] = String(c.expiration || '').split('-');
  return `${c.symbol || ''} ${Number(m)}/${Number(d)}${y && y !== String(new Date().getFullYear()) ? `/${y.slice(2)}` : ''} $${round(c.strike, 2)}${c.right === 'call' ? 'C' : 'P'}`.trim();
}

/** Clamp a target delta into a mode's allowed band. */
export function clampDelta(d, band) {
  return clamp(Math.abs(d), band[0], band[1]);
}
