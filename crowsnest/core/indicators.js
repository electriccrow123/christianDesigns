// Technical indicators over OHLCV bars. Every series function returns an array aligned with its
// input (undefined where there is not enough history yet).
// A bar is { t, o, h, l, c, v } with t in epoch seconds.

export function sma(values, period) {
  const out = new Array(values.length).fill(undefined);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= period) acc -= values[i - period];
    if (i >= period - 1) out[i] = acc / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(undefined);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(undefined);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : undefined));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(closes.length).fill(undefined);
  if (start >= 0) {
    const tail = ema(line.slice(start), signal);
    tail.forEach((v, i) => (sig[start + i] = v));
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : undefined));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = [];
  const lower = [];
  const width = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) {
      upper.push(undefined);
      lower.push(undefined);
      width.push(undefined);
      continue;
    }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
    width.push(mid[i] ? (2 * mult * sd) / mid[i] : undefined);
  }
  return { mid, upper, lower, width };
}

export function trueRange(bars) {
  return bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const pc = bars[i - 1].c;
    return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  });
}

/** Wilder's ATR. */
export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(undefined);
  if (bars.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** ADX with +DI / -DI (trend strength, 0-100). */
export function adx(bars, period = 14) {
  const n = bars.length;
  const plus = new Array(n).fill(undefined);
  const minus = new Array(n).fill(undefined);
  const out = new Array(n).fill(undefined);
  if (n < period * 2 + 1) return { adx: out, plusDI: plus, minusDI: minus };
  const tr = trueRange(bars);
  let trS = 0;
  let pS = 0;
  let mS = 0;
  const dx = new Array(n).fill(undefined);
  for (let i = 1; i < n; i++) {
    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    if (i <= period) {
      trS += tr[i];
      pS += pdm;
      mS += mdm;
      if (i < period) continue;
    } else {
      trS = trS - trS / period + tr[i];
      pS = pS - pS / period + pdm;
      mS = mS - mS / period + mdm;
    }
    plus[i] = trS ? (100 * pS) / trS : 0;
    minus[i] = trS ? (100 * mS) / trS : 0;
    const s = plus[i] + minus[i];
    dx[i] = s ? (100 * Math.abs(plus[i] - minus[i])) / s : 0;
  }
  let first = period * 2;
  let acc = 0;
  for (let i = period; i < first; i++) acc += dx[i] ?? 0;
  let prev = acc / period;
  out[first - 1] = prev;
  for (let i = first; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]) / period;
    out[i] = prev;
  }
  return { adx: out, plusDI: plus, minusDI: minus };
}

/** Slow stochastic %K / %D. */
export function stochastic(bars, period = 14, smoothK = 3, smoothD = 3) {
  const raw = bars.map((_, i) => {
    if (i < period - 1) return undefined;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].h);
      lo = Math.min(lo, bars[j].l);
    }
    return hi === lo ? 50 : (100 * (bars[i].c - lo)) / (hi - lo);
  });
  const smooth = (arr, p) => {
    const out = new Array(arr.length).fill(undefined);
    for (let i = 0; i < arr.length; i++) {
      const win = arr.slice(Math.max(0, i - p + 1), i + 1);
      if (win.length === p && win.every((v) => v != null)) out[i] = win.reduce((a, b) => a + b, 0) / p;
    }
    return out;
  };
  const k = smooth(raw, smoothK);
  const d = smooth(k, smoothD);
  return { k, d };
}

/** On-balance volume. */
export function obv(bars) {
  const out = [];
  let acc = 0;
  bars.forEach((b, i) => {
    if (i > 0) acc += b.c > bars[i - 1].c ? b.v : b.c < bars[i - 1].c ? -b.v : 0;
    out.push(acc);
  });
  return out;
}

/** Session VWAP for intraday bars (resets each New York trading day). */
export function vwap(bars) {
  const out = [];
  let pv = 0;
  let vol = 0;
  let day = '';
  for (const b of bars) {
    const d = new Date(b.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (b.h + b.l + b.c) / 3;
    pv += typical * (b.v || 0);
    vol += b.v || 0;
    out.push(vol ? pv / vol : typical);
  }
  return out;
}

/** Least-squares line through the last n values: { slope, intercept, r2 } with x = 0..n-1. */
export function linreg(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 };
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  values.forEach((y, x) => {
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
    syy += y * y;
  });
  const denom = n * sxx - sx * sx;
  const slope = denom ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  const rNum = n * sxy - sx * sy;
  const rDen = Math.sqrt(denom * (n * syy - sy * sy));
  const r = rDen ? rNum / rDen : 0;
  return { slope, intercept, r2: r * r };
}

/** Daily log returns. */
export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

/** Annualized realized volatility from the last `period` daily closes. */
export function realizedVol(closes, period = 20) {
  const r = logReturns(closes.slice(-(period + 1)));
  if (r.length < 2) return undefined;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252);
}

/** Percentile rank (0-100) of the last value within the series. */
export function percentileRank(series) {
  const vals = series.filter((v) => v != null);
  if (vals.length < 2) return undefined;
  const lastV = vals[vals.length - 1];
  const below = vals.filter((v) => v < lastV).length;
  return (100 * below) / (vals.length - 1);
}
