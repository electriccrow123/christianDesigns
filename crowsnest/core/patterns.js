// Chart-pattern and candlestick detection, support/resistance, a composite technical score,
// a one-week projection, and a plain-English read of all of it.
// Input: daily bars [{ t, o, h, l, c, v }] oldest first. Works with ~60 bars, best with 250+.

import { sma, ema, rsi, macd, bollinger, atr, adx, stochastic, linreg, realizedVol, percentileRank, vwap } from './indicators.js';
import { clamp, round, mean } from './util.js';

const BULL = 'bullish';
const BEAR = 'bearish';
const NEUTRAL = 'neutral';

// ---------------------------------------------------------------- swing points and levels
/** Swing highs and lows: a bar whose high (low) is the extreme of the k bars on each side. */
export function pivots(bars, k = 3) {
  const highs = [];
  const lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) highs.push({ i, price: bars[i].h });
    if (isLow) lows.push({ i, price: bars[i].l });
  }
  return { highs, lows };
}

/** Cluster swing points into horizontal support/resistance levels. */
export function levels(bars, { k = 3, lookback = 250 } = {}) {
  const slice = bars.slice(-lookback);
  const offset = bars.length - slice.length;
  if (slice.length < 2 * k + 2) return { support: [], resistance: [], all: [] };
  const { highs, lows } = pivots(slice, k);
  const atrNow = atr(slice, 14).filter((v) => v != null).pop() || slice[slice.length - 1].c * 0.02;
  const tol = Math.max(atrNow * 0.6, slice[slice.length - 1].c * 0.006);
  const points = [...highs.map((p) => ({ ...p, kind: 'h' })), ...lows.map((p) => ({ ...p, kind: 'l' }))].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of points) {
    const c = clusters[clusters.length - 1];
    if (c && p.price - c.max <= tol) {
      c.items.push(p);
      c.max = p.price;
    } else clusters.push({ items: [p], max: p.price });
  }
  const price = slice[slice.length - 1].c;
  const n = slice.length;
  const all = clusters.map((c) => {
    const prices = c.items.map((x) => x.price);
    const lastIndex = Math.max(...c.items.map((x) => x.i));
    const recency = 1 - (n - 1 - lastIndex) / n;
    return {
      price: round(mean(prices), 2),
      touches: c.items.length,
      lastIndex: lastIndex + offset,
      strength: round(c.items.length + recency * 1.5, 2),
    };
  });
  const support = all.filter((l) => l.price < price).sort((a, b) => b.price - a.price);
  const resistance = all.filter((l) => l.price > price).sort((a, b) => a.price - b.price);
  // Add the 52-week extremes as levels when nothing nearer exists.
  const hi = Math.max(...slice.map((b) => b.h));
  const lo = Math.min(...slice.map((b) => b.l));
  if (!resistance.length && hi > price) resistance.push({ price: round(hi, 2), touches: 1, lastIndex: bars.length - 1, strength: 1 });
  if (!support.length && lo < price) support.push({ price: round(lo, 2), touches: 1, lastIndex: bars.length - 1, strength: 1 });
  return { support: support.slice(0, 4), resistance: resistance.slice(0, 4), all };
}

// ---------------------------------------------------------------- candlesticks
const body = (b) => Math.abs(b.c - b.o);
const range = (b) => Math.max(b.h - b.l, 1e-9);
const upperWick = (b) => b.h - Math.max(b.o, b.c);
const lowerWick = (b) => Math.min(b.o, b.c) - b.l;
const green = (b) => b.c > b.o;
const red = (b) => b.c < b.o;

export function candlesticks(bars, trendDir) {
  const out = [];
  const n = bars.length;
  if (n < 4) return out;
  const b = bars[n - 1];
  const p = bars[n - 2];
  const pp = bars[n - 3];
  const avgBody = mean(bars.slice(-15).map(body)) || range(b) * 0.5;
  const add = (id, name, bias, confidence, detail) => out.push({ id, name, bias, confidence, detail, kind: 'candle' });

  if (red(p) && green(b) && b.o <= p.c && b.c >= p.o && body(b) > body(p) * 1.05)
    add('bull_engulfing', 'Bullish engulfing', BULL, trendDir === 'down' ? 0.68 : 0.55, 'Today’s green candle swallowed yesterday’s red one: buyers overpowered sellers.');
  if (green(p) && red(b) && b.o >= p.c && b.c <= p.o && body(b) > body(p) * 1.05)
    add('bear_engulfing', 'Bearish engulfing', BEAR, trendDir === 'up' ? 0.68 : 0.55, 'Today’s red candle swallowed yesterday’s green one: sellers took control.');
  if (lowerWick(b) >= 2 * body(b) && upperWick(b) <= body(b) * 0.6 && body(b) / range(b) < 0.4)
    add('hammer', trendDir === 'down' ? 'Hammer' : 'Hanging man', trendDir === 'down' ? BULL : BEAR, trendDir === 'down' ? 0.6 : 0.45, trendDir === 'down' ? 'Long lower wick after a decline: buyers rejected lower prices.' : 'Long lower wick after a rise: a warning that selling pressure appeared.');
  if (upperWick(b) >= 2 * body(b) && lowerWick(b) <= body(b) * 0.6 && body(b) / range(b) < 0.4)
    add('shooting_star', trendDir === 'up' ? 'Shooting star' : 'Inverted hammer', trendDir === 'up' ? BEAR : BULL, trendDir === 'up' ? 0.6 : 0.45, trendDir === 'up' ? 'Long upper wick after a rise: sellers rejected higher prices.' : 'Long upper wick after a decline: buyers are testing higher prices.');
  if (body(b) <= range(b) * 0.1 && range(b) > 0) add('doji', 'Doji', NEUTRAL, 0.4, 'Open and close are almost equal: indecision. Watch the next candle for direction.');
  if (red(pp) && body(pp) > avgBody && body(p) < avgBody * 0.5 && green(b) && b.c > (pp.o + pp.c) / 2)
    add('morning_star', 'Morning star', BULL, 0.66, 'Three-candle bottom: a big red day, a small pause, then a strong green day.');
  if (green(pp) && body(pp) > avgBody && body(p) < avgBody * 0.5 && red(b) && b.c < (pp.o + pp.c) / 2)
    add('evening_star', 'Evening star', BEAR, 0.66, 'Three-candle top: a big green day, a small pause, then a strong red day.');
  if ([pp, p, b].every(green) && pp.c < p.c && p.c < b.c && [pp, p, b].every((x) => body(x) > avgBody * 0.7))
    add('three_soldiers', 'Three white soldiers', BULL, 0.62, 'Three strong green days in a row, each closing higher.');
  if ([pp, p, b].every(red) && pp.c > p.c && p.c > b.c && [pp, p, b].every((x) => body(x) > avgBody * 0.7))
    add('three_crows', 'Three black crows', BEAR, 0.62, 'Three strong red days in a row, each closing lower.');
  if (b.h < p.h && b.l > p.l) add('inside_bar', 'Inside day', NEUTRAL, 0.35, 'Today traded inside yesterday’s range: energy is coiling for a move.');
  return out;
}

// ---------------------------------------------------------------- chart patterns
function trendStructure(piv) {
  const h = piv.highs.slice(-3);
  const l = piv.lows.slice(-3);
  if (h.length < 2 || l.length < 2) return null;
  const hh = h[h.length - 1].price > h[h.length - 2].price;
  const hl = l[l.length - 1].price > l[l.length - 2].price;
  const lh = h[h.length - 1].price < h[h.length - 2].price;
  const ll = l[l.length - 1].price < l[l.length - 2].price;
  if (hh && hl) return { id: 'hh_hl', name: 'Higher highs & higher lows', bias: BULL, confidence: 0.6, detail: 'Each swing high and swing low is above the last one: the textbook definition of an uptrend.', kind: 'chart' };
  if (lh && ll) return { id: 'lh_ll', name: 'Lower highs & lower lows', bias: BEAR, confidence: 0.6, detail: 'Each swing high and swing low is below the last one: the textbook definition of a downtrend.', kind: 'chart' };
  return null;
}

function doubleTopBottom(bars, piv, a) {
  const out = [];
  const n = bars.length;
  const price = bars[n - 1].c;
  const H = piv.highs.filter((p) => p.i >= n - 90);
  const L = piv.lows.filter((p) => p.i >= n - 90);
  if (H.length >= 2) {
    const [p1, p2] = H.slice(-2);
    const gap = p2.i - p1.i;
    const between = bars.slice(p1.i, p2.i + 1);
    const trough = Math.min(...between.map((b) => b.l));
    if (gap >= 8 && Math.abs(p2.price - p1.price) / p1.price < 0.03 && (Math.max(p1.price, p2.price) - trough) / trough > 0.04 && price < p2.price) {
      const confirmed = price < trough;
      const height = Math.max(p1.price, p2.price) - trough;
      out.push({
        id: 'double_top',
        name: confirmed ? 'Double top (confirmed)' : 'Possible double top',
        bias: BEAR,
        confidence: confirmed ? 0.7 : 0.45,
        level: round(trough, 2),
        target: round(trough - height, 2),
        detail: `Price failed twice near $${round(Math.max(p1.price, p2.price), 2)}. ${confirmed ? 'It has broken' : 'A close below'} the $${round(trough, 2)} neckline ${confirmed ? 'and points' : 'would point'} toward ~$${round(trough - height, 2)}.`,
        kind: 'chart',
      });
    }
  }
  if (L.length >= 2) {
    const [p1, p2] = L.slice(-2);
    const gap = p2.i - p1.i;
    const between = bars.slice(p1.i, p2.i + 1);
    const peak = Math.max(...between.map((b) => b.h));
    if (gap >= 8 && Math.abs(p2.price - p1.price) / p1.price < 0.03 && (peak - Math.min(p1.price, p2.price)) / peak > 0.04 && price > p2.price) {
      const confirmed = price > peak;
      const height = peak - Math.min(p1.price, p2.price);
      out.push({
        id: 'double_bottom',
        name: confirmed ? 'Double bottom (confirmed)' : 'Possible double bottom',
        bias: BULL,
        confidence: confirmed ? 0.7 : 0.45,
        level: round(peak, 2),
        target: round(peak + height, 2),
        detail: `Price held twice near $${round(Math.min(p1.price, p2.price), 2)}. ${confirmed ? 'It has cleared' : 'A close above'} the $${round(peak, 2)} neckline ${confirmed ? 'and points' : 'would point'} toward ~$${round(peak + height, 2)}.`,
        kind: 'chart',
      });
    }
  }
  return out;
}

function headAndShoulders(bars, piv) {
  const out = [];
  const n = bars.length;
  const price = bars[n - 1].c;
  const H = piv.highs.filter((p) => p.i >= n - 120).slice(-3);
  if (H.length === 3) {
    const [l, h, r] = H;
    if (h.price > l.price * 1.03 && h.price > r.price * 1.03 && Math.abs(l.price - r.price) / l.price < 0.05) {
      const t1 = Math.min(...bars.slice(l.i, h.i + 1).map((b) => b.l));
      const t2 = Math.min(...bars.slice(h.i, r.i + 1).map((b) => b.l));
      const neck = (t1 + t2) / 2;
      const confirmed = price < neck;
      out.push({
        id: 'head_shoulders',
        name: confirmed ? 'Head & shoulders (confirmed)' : 'Possible head & shoulders',
        bias: BEAR,
        confidence: confirmed ? 0.68 : 0.42,
        level: round(neck, 2),
        target: round(neck - (h.price - neck), 2),
        detail: `Three peaks with the middle one highest: a classic topping shape. Neckline ≈ $${round(neck, 2)}.`,
        kind: 'chart',
      });
    }
  }
  const L = piv.lows.filter((p) => p.i >= n - 120).slice(-3);
  if (L.length === 3) {
    const [l, h, r] = L;
    if (h.price < l.price * 0.97 && h.price < r.price * 0.97 && Math.abs(l.price - r.price) / l.price < 0.05) {
      const p1 = Math.max(...bars.slice(l.i, h.i + 1).map((b) => b.h));
      const p2 = Math.max(...bars.slice(h.i, r.i + 1).map((b) => b.h));
      const neck = (p1 + p2) / 2;
      const confirmed = price > neck;
      out.push({
        id: 'inv_head_shoulders',
        name: confirmed ? 'Inverse head & shoulders (confirmed)' : 'Possible inverse head & shoulders',
        bias: BULL,
        confidence: confirmed ? 0.68 : 0.42,
        level: round(neck, 2),
        target: round(neck + (neck - h.price), 2),
        detail: `Three troughs with the middle one lowest: a classic bottoming shape. Neckline ≈ $${round(neck, 2)}.`,
        kind: 'chart',
      });
    }
  }
  return out;
}

function flags(bars, atrPct) {
  const out = [];
  const n = bars.length;
  if (n < 30) return out;
  const minImpulse = Math.max(0.07, atrPct * 3);
  for (let len = 4; len <= 14; len++) {
    const end = n - 1 - len; // last bar of the impulse
    let best = null;
    for (let w = 4; w <= 12; w++) {
      const start = end - w;
      if (start < 0) break;
      const move = (bars[end].c - bars[start].c) / bars[start].c;
      if (Math.abs(move) >= minImpulse && (!best || Math.abs(move) > Math.abs(best.move))) best = { start, move };
    }
    if (!best) continue;
    const cons = bars.slice(end + 1);
    const hi = Math.max(...cons.map((b) => b.h));
    const lo = Math.min(...cons.map((b) => b.l));
    const impulseSize = Math.abs(bars[end].c - bars[best.start].c);
    const retrace = best.move > 0 ? (bars[end].c - lo) / impulseSize : (hi - bars[end].c) / impulseSize;
    const tight = (hi - lo) / bars[end].c < Math.abs(best.move) * 0.6;
    const volImp = mean(bars.slice(best.start, end + 1).map((b) => b.v || 0));
    const volCons = mean(cons.map((b) => b.v || 0));
    if (retrace >= 0 && retrace < 0.5 && tight) {
      const bull = best.move > 0;
      const breakout = bull ? bars[n - 1].c > hi * 0.995 : bars[n - 1].c < lo * 1.005;
      out.push({
        id: bull ? 'bull_flag' : 'bear_flag',
        name: bull ? 'Bull flag' : 'Bear flag',
        bias: bull ? BULL : BEAR,
        confidence: clamp(0.5 + (volCons < volImp ? 0.1 : 0) + (breakout ? 0.12 : 0), 0, 0.8),
        level: round(bull ? hi : lo, 2),
        target: round(bull ? hi + impulseSize : lo - impulseSize, 2),
        detail: `A ${round(Math.abs(best.move) * 100, 1)}% ${bull ? 'surge' : 'drop'} followed by ${len} days of tight sideways drift${volCons < volImp ? ' on lighter volume' : ''}. ${bull ? `A push through $${round(hi, 2)}` : `A break below $${round(lo, 2)}`} would signal the next leg.`,
        kind: 'chart',
      });
      break;
    }
  }
  return out;
}

function triangles(bars, piv) {
  const n = bars.length;
  const H = piv.highs.filter((p) => p.i >= n - 60).slice(-4);
  const L = piv.lows.filter((p) => p.i >= n - 60).slice(-4);
  if (H.length < 2 || L.length < 2) return [];
  const price = bars[n - 1].c;
  const hs = linreg(H.map((p) => p.price));
  const ls = linreg(L.map((p) => p.price));
  const hSlope = hs.slope / price;
  const lSlope = ls.slope / price;
  const flat = (s) => Math.abs(s) < 0.006;
  const top = Math.max(...H.map((p) => p.price));
  const bottom = Math.min(...L.map((p) => p.price));
  if (flat(hSlope) && lSlope > 0.006)
    return [{ id: 'asc_triangle', name: 'Ascending triangle', bias: BULL, confidence: 0.55, level: round(top, 2), target: round(top + (top - bottom), 2), detail: `Flat ceiling near $${round(top, 2)} with rising lows: buyers keep stepping in higher. A breakout above the ceiling is the trigger.`, kind: 'chart' }];
  if (flat(lSlope) && hSlope < -0.006)
    return [{ id: 'desc_triangle', name: 'Descending triangle', bias: BEAR, confidence: 0.55, level: round(bottom, 2), target: round(bottom - (top - bottom), 2), detail: `Flat floor near $${round(bottom, 2)} with falling highs: sellers keep leaning lower. A break of the floor is the trigger.`, kind: 'chart' }];
  if (hSlope < -0.004 && lSlope > 0.004)
    return [{ id: 'sym_triangle', name: 'Symmetrical triangle', bias: NEUTRAL, confidence: 0.45, level: round((top + bottom) / 2, 2), detail: 'Highs falling and lows rising: the range is squeezing. It usually breaks in the direction of the prior trend.', kind: 'chart' }];
  return [];
}

function divergences(bars, rsiSeries, piv) {
  const out = [];
  const n = bars.length;
  const L = piv.lows.filter((p) => p.i >= n - 45 && rsiSeries[p.i] != null).slice(-2);
  if (L.length === 2 && L[1].price < L[0].price && rsiSeries[L[1].i] > rsiSeries[L[0].i] + 2)
    out.push({ id: 'bull_divergence', name: 'Bullish RSI divergence', bias: BULL, confidence: 0.55, detail: 'Price made a lower low but RSI made a higher low: selling pressure is fading.', kind: 'indicator' });
  const H = piv.highs.filter((p) => p.i >= n - 45 && rsiSeries[p.i] != null).slice(-2);
  if (H.length === 2 && H[1].price > H[0].price && rsiSeries[H[1].i] < rsiSeries[H[0].i] - 2)
    out.push({ id: 'bear_divergence', name: 'Bearish RSI divergence', bias: BEAR, confidence: 0.55, detail: 'Price made a higher high but RSI made a lower high: buying pressure is fading.', kind: 'indicator' });
  return out;
}

// ---------------------------------------------------------------- full analysis
/**
 * Analyze one symbol's daily bars.
 * Returns trend, indicators, levels, patterns, a -100..100 score, a 5-day projection and a summary.
 */
export function analyze(bars, { symbol = '', intraday } = {}) {
  bars = (bars || []).filter((b) => [b.o, b.h, b.l, b.c].every(Number.isFinite));
  const n = bars.length;
  if (n < 30) return { symbol, insufficient: true, bars: n, summary: `Not enough price history for ${symbol || 'this symbol'} (${n} days).`, patterns: [], score: 0, bias: NEUTRAL };
  const closes = bars.map((b) => b.c);
  const price = closes[n - 1];
  const prev = closes[n - 2];
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const s200 = sma(closes, 200);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const at = atr(bars, 14);
  const ad = adx(bars, 14);
  const st = stochastic(bars);
  const L = (arr) => arr[n - 1];
  const atrNow = L(at) ?? price * 0.02;
  const atrPct = atrNow / price;
  const vol20 = mean(bars.slice(-21, -1).map((b) => b.v || 0));
  const volRatio = vol20 ? (bars[n - 1].v || 0) / vol20 : undefined;
  const slope20 = linreg(closes.slice(-20));
  const slopePct = slope20.slope / price; // per day
  const hi52 = Math.max(...bars.slice(-252).map((b) => b.h));
  const lo52 = Math.min(...bars.slice(-252).map((b) => b.l));
  const rv = realizedVol(closes, 20);
  const bbWidthRank = percentileRank(bb.width.slice(-126));

  // Trend
  const above50 = L(s50) != null ? price > L(s50) : undefined;
  const above200 = L(s200) != null ? price > L(s200) : undefined;
  let trendPts = 0;
  if (above50 != null) trendPts += above50 ? 1 : -1;
  if (above200 != null) trendPts += above200 ? 1 : -1;
  if (L(e9) != null && L(e21) != null) trendPts += L(e9) > L(e21) ? 1 : -1;
  trendPts += slopePct > 0.001 ? 1 : slopePct < -0.001 ? -1 : 0;
  const direction = trendPts >= 2 ? 'up' : trendPts <= -2 ? 'down' : 'sideways';
  const adxNow = L(ad.adx);
  const strength = Math.round(clamp((adxNow ?? 15) * 2.2, 0, 100));

  // Patterns
  const piv = pivots(bars, 3);
  const lv = levels(bars);
  const patterns = [];
  const add = (p) => p && patterns.push(p);
  add(trendStructure(piv));
  const crossed = (a, b, look = 10) => {
    for (let i = n - look; i < n; i++) {
      if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
      if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return { up: true, ago: n - 1 - i };
      if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return { up: false, ago: n - 1 - i };
    }
    return null;
  };
  const gc = crossed(s50, s200, 10);
  if (gc) add({ id: gc.up ? 'golden_cross' : 'death_cross', name: gc.up ? 'Golden cross' : 'Death cross', bias: gc.up ? BULL : BEAR, confidence: 0.6, detail: `The 50-day average crossed ${gc.up ? 'above' : 'below'} the 200-day ${gc.ago === 0 ? 'today' : `${gc.ago} day${gc.ago > 1 ? 's' : ''} ago`}: a long-term trend ${gc.up ? 'upgrade' : 'downgrade'}.`, kind: 'indicator' });
  const mc = crossed(m.line, m.signal, 3);
  if (mc) add({ id: mc.up ? 'macd_bull' : 'macd_bear', name: mc.up ? 'MACD bullish crossover' : 'MACD bearish crossover', bias: mc.up ? BULL : BEAR, confidence: 0.5, detail: `Momentum line crossed ${mc.up ? 'above' : 'below'} its signal line ${mc.ago === 0 ? 'today' : `${mc.ago} day${mc.ago > 1 ? 's' : ''} ago`}: short-term momentum is turning ${mc.up ? 'up' : 'down'}.`, kind: 'indicator' });
  const rNow = L(r);
  if (rNow != null) {
    if (rNow >= 70) add({ id: 'rsi_overbought', name: 'RSI overbought', bias: BEAR, confidence: rNow > 78 ? 0.5 : 0.35, detail: `RSI is ${round(rNow, 0)}. Strong stocks can stay overbought, but chasing here carries pullback risk.`, kind: 'indicator' });
    if (rNow <= 30) add({ id: 'rsi_oversold', name: 'RSI oversold', bias: BULL, confidence: rNow < 22 ? 0.5 : 0.35, detail: `RSI is ${round(rNow, 0)}. Selling looks stretched; bounces are common from here, but wait for a turn.`, kind: 'indicator' });
  }
  divergences(bars, r, piv).forEach(add);
  if (bbWidthRank != null && bbWidthRank < 12) {
    const up = price > L(bb.upper);
    const dn = price < L(bb.lower);
    add({ id: up ? 'squeeze_break_up' : dn ? 'squeeze_break_down' : 'bb_squeeze', name: up ? 'Squeeze breakout (up)' : dn ? 'Squeeze breakdown' : 'Volatility squeeze', bias: up ? BULL : dn ? BEAR : NEUTRAL, confidence: up || dn ? 0.62 : 0.45, detail: `Bollinger Bands are the tightest in ~6 months. Quiet periods like this tend to end with a sharp move${up ? ', and price just broke upward' : dn ? ', and price just broke downward' : ''}.`, kind: 'indicator' });
  }
  // Breakouts through levels found before the last few bars
  const prior = levels(bars.slice(0, -2));
  const res = prior.resistance[0];
  const sup = prior.support[0];
  if (res && prev <= res.price * 1.002 && price > res.price * 1.004)
    add({ id: 'breakout', name: 'Resistance breakout', bias: BULL, confidence: clamp(0.5 + (volRatio > 1.4 ? 0.15 : 0) + res.touches * 0.03, 0, 0.8), level: res.price, detail: `Closed above $${res.price} resistance (${res.touches} prior touches)${volRatio > 1.4 ? ` on ${round(volRatio, 1)}× normal volume` : volRatio != null ? ', but volume was not convincing' : ''}.`, kind: 'chart' });
  if (sup && prev >= sup.price * 0.998 && price < sup.price * 0.996)
    add({ id: 'breakdown', name: 'Support breakdown', bias: BEAR, confidence: clamp(0.5 + (volRatio > 1.4 ? 0.15 : 0) + sup.touches * 0.03, 0, 0.8), level: sup.price, detail: `Closed below $${sup.price} support (${sup.touches} prior touches)${volRatio > 1.4 ? ` on ${round(volRatio, 1)}× normal volume` : ''}.`, kind: 'chart' });
  doubleTopBottom(bars, piv).forEach(add);
  headAndShoulders(bars, piv).forEach(add);
  flags(bars, atrPct).forEach(add);
  triangles(bars, piv).forEach(add);
  const gap = (bars[n - 1].o - prev) / prev;
  if (Math.abs(gap) >= 0.02) {
    const held = gap > 0 ? price > prev * (1 + gap / 2) : price < prev * (1 + gap / 2);
    add({ id: gap > 0 ? 'gap_up' : 'gap_down', name: gap > 0 ? 'Gap up' : 'Gap down', bias: gap > 0 === held ? BULL : BEAR, confidence: held ? 0.5 : 0.4, detail: `Opened ${round(Math.abs(gap) * 100, 1)}% ${gap > 0 ? 'above' : 'below'} yesterday’s close and ${held ? 'held most of it' : 'gave much of it back'}.`, kind: 'chart' });
  }
  if (volRatio != null && volRatio >= 2)
    add({ id: 'volume_spike', name: 'Volume spike', bias: price >= prev ? BULL : BEAR, confidence: 0.4, detail: `${round(volRatio, 1)}× normal volume on a ${price >= prev ? 'green' : 'red'} day: big players are active.`, kind: 'indicator' });
  if (price >= hi52 * 0.985) add({ id: 'near_52w_high', name: 'At 52-week high', bias: BULL, confidence: 0.45, detail: 'Trading at or near its highest level of the year: momentum is on the buyers’ side, with no overhead supply.', kind: 'chart' });
  if (price <= lo52 * 1.015) add({ id: 'near_52w_low', name: 'At 52-week low', bias: BEAR, confidence: 0.45, detail: 'Trading at or near its lowest level of the year: the trend is weak until it proves otherwise.', kind: 'chart' });
  const stretch = L(s20) != null ? (price - L(s20)) / atrNow : 0;
  if (stretch > 2.5) add({ id: 'stretched_up', name: 'Stretched above average', bias: BEAR, confidence: 0.35, detail: `Price is ${round(stretch, 1)} ATRs above its 20-day average. Extended moves often pause or pull back.`, kind: 'indicator' });
  if (stretch < -2.5) add({ id: 'stretched_down', name: 'Stretched below average', bias: BULL, confidence: 0.35, detail: `Price is ${round(Math.abs(stretch), 1)} ATRs below its 20-day average. Snap-back bounces are common.`, kind: 'indicator' });
  candlesticks(bars, direction).forEach(add);
  patterns.sort((a, b) => b.confidence - a.confidence);

  // Composite score
  let score = 0;
  if (above50 != null) score += above50 ? 10 : -10;
  if (above200 != null) score += above200 ? 12 : -12;
  score += clamp(slopePct * 4000, -12, 12);
  if (L(e9) != null && L(e21) != null) score += L(e9) > L(e21) ? 6 : -6;
  if (rNow != null) score += clamp((rNow - 50) * 0.35, -10, 10) - (rNow > 75 ? 6 : 0) + (rNow < 25 ? 6 : 0);
  if (L(m.hist) != null) score += L(m.hist) > 0 ? 6 : -6;
  for (const p of patterns) score += (p.bias === BULL ? 1 : p.bias === BEAR ? -1 : 0) * p.confidence * 14;
  if (adxNow != null && adxNow > 25) score *= 1.1;
  score = Math.round(clamp(score, -100, 100));
  const bias = score >= 20 ? BULL : score <= -20 ? BEAR : NEUTRAL;

  // Projection: drift from the 20-day regression, spread from realized volatility.
  const horizon = 5;
  const dailySigma = (rv ?? atrPct * Math.sqrt(252) * 0.8) / Math.sqrt(252);
  const drift = clamp(slopePct, -0.02, 0.02) * horizon * 0.5; // damped: trends decay
  const base = price * (1 + drift);
  const band = price * dailySigma * Math.sqrt(horizon);
  const bullTarget = patterns.find((p) => p.bias === BULL && p.target)?.target ?? lv.resistance[0]?.price ?? round(price + 2 * atrNow, 2);
  const bearTarget = patterns.find((p) => p.bias === BEAR && p.target)?.target ?? lv.support[0]?.price ?? round(price - 2 * atrNow, 2);
  const projection = {
    horizonDays: horizon,
    base: round(base, 2),
    low1: round(base - band, 2),
    high1: round(base + band, 2),
    low2: round(base - 2 * band, 2),
    high2: round(base + 2 * band, 2),
    bullTarget: round(bullTarget, 2),
    bearTarget: round(bearTarget, 2),
    note: 'Base path follows the recent trend (dampened). The inner band covers about 68% of outcomes, the outer about 95%, based on recent volatility.',
  };

  const indicators = {
    rsi: round(rNow, 1),
    macd: round(L(m.line), 3),
    macdSignal: round(L(m.signal), 3),
    macdHist: round(L(m.hist), 3),
    sma20: round(L(s20), 2),
    sma50: round(L(s50), 2),
    sma200: round(L(s200), 2),
    ema9: round(L(e9), 2),
    ema21: round(L(e21), 2),
    bbUpper: round(L(bb.upper), 2),
    bbLower: round(L(bb.lower), 2),
    bbWidthRank: round(bbWidthRank, 0),
    atr: round(atrNow, 2),
    atrPct: round(atrPct * 100, 2),
    adx: round(adxNow, 1),
    stochK: round(L(st.k), 1),
    volRatio: round(volRatio, 2),
    realizedVol: round((rv ?? 0) * 100, 1),
  };

  const result = {
    symbol,
    price: round(price, 4),
    changePct: round(((price - prev) / prev) * 100, 2),
    high52: round(hi52, 2),
    low52: round(lo52, 2),
    trend: { direction, strength, above50, above200, slopePctPerDay: round(slopePct * 100, 3) },
    indicators,
    levels: { support: lv.support.map((l) => l.price), resistance: lv.resistance.map((l) => l.price), detail: lv },
    patterns,
    score,
    bias,
    projection,
  };
  if (intraday?.length) result.intraday = analyzeIntraday(intraday);
  result.summary = describe(result);
  return result;
}

/** Intraday read: VWAP, opening range, and today's trend. Expects today's 5-minute bars. */
export function analyzeIntraday(bars) {
  if (!bars?.length) return null;
  const vw = vwap(bars);
  const day = new Date(bars[bars.length - 1].t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = bars.filter((b) => new Date(b.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) === day);
  if (!today.length) return null;
  const orBars = today.slice(0, 6); // first 30 minutes
  const orHigh = Math.max(...orBars.map((b) => b.h));
  const orLow = Math.min(...orBars.map((b) => b.l));
  const lastB = today[today.length - 1];
  const vwNow = vw[vw.length - 1];
  const reg = linreg(today.map((b) => b.c));
  return {
    vwap: round(vwNow, 2),
    aboveVwap: lastB.c > vwNow,
    openingRange: { high: round(orHigh, 2), low: round(orLow, 2) },
    orBreak: today.length > 6 ? (lastB.c > orHigh ? 'up' : lastB.c < orLow ? 'down' : 'inside') : 'forming',
    dayHigh: round(Math.max(...today.map((b) => b.h)), 2),
    dayLow: round(Math.min(...today.map((b) => b.l)), 2),
    trend: reg.slope > 0 && reg.r2 > 0.3 ? 'up' : reg.slope < 0 && reg.r2 > 0.3 ? 'down' : 'choppy',
  };
}

const fmt = (v) => (Number.isFinite(v) ? `$${v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(2) : v.toFixed(4)}` : '—');

/** Plain-English read of an analysis, written for someone learning. */
export function describe(a) {
  if (a.insufficient) return a.summary;
  const parts = [];
  const t = a.trend;
  const trendWord = t.direction === 'up' ? 'an uptrend' : t.direction === 'down' ? 'a downtrend' : 'a sideways range';
  const maBits = [];
  if (t.above50 != null) maBits.push(`${t.above50 ? 'above' : 'below'} its 50-day average`);
  if (t.above200 != null) maBits.push(`${t.above200 ? 'above' : 'below'} its 200-day`);
  parts.push(`${a.symbol || 'It'} is in ${trendWord}${maBits.length ? ` (${maBits.join(', ')})` : ''}${a.indicators.adx ? `, trend strength ${a.indicators.adx >= 25 ? 'strong' : a.indicators.adx >= 18 ? 'moderate' : 'weak'} (ADX ${Math.round(a.indicators.adx)})` : ''}.`);
  if (a.indicators.rsi != null) {
    const rv = a.indicators.rsi;
    parts.push(`RSI ${Math.round(rv)} = ${rv >= 70 ? 'overbought' : rv <= 30 ? 'oversold' : rv >= 55 ? 'healthy buying momentum' : rv <= 45 ? 'soft momentum' : 'neutral momentum'}.`);
  }
  const top = a.patterns.filter((p) => p.confidence >= 0.45).slice(0, 3);
  if (top.length) parts.push(`Patterns: ${top.map((p) => `${p.name} (${p.bias})`).join(', ')}.`);
  const s = a.levels.support[0];
  const r = a.levels.resistance[0];
  if (s || r) parts.push(`${s ? `Support ${fmt(s)}` : ''}${s && r ? ', ' : ''}${r ? `resistance ${fmt(r)}` : ''}.`);
  parts.push(`Likely 1-week range ${fmt(a.projection.low1)}–${fmt(a.projection.high1)}.`);
  parts.push(`Overall technical score ${a.score > 0 ? '+' : ''}${a.score} (${a.bias}).`);
  return parts.join(' ');
}

/** Compact view of an analysis for prompts. */
export function brief(a) {
  if (!a || a.insufficient) return { symbol: a?.symbol, note: 'insufficient history' };
  return {
    symbol: a.symbol,
    price: a.price,
    chg: a.changePct,
    score: a.score,
    bias: a.bias,
    trend: `${a.trend.direction}/${a.trend.strength}`,
    rsi: a.indicators.rsi,
    adx: a.indicators.adx,
    atrPct: a.indicators.atrPct,
    macdHist: a.indicators.macdHist,
    sma50: a.indicators.sma50,
    sma200: a.indicators.sma200,
    volRatio: a.indicators.volRatio,
    sup: a.levels.support.slice(0, 2),
    res: a.levels.resistance.slice(0, 2),
    patterns: a.patterns.slice(0, 4).map((p) => `${p.name}|${p.bias}|${Math.round(p.confidence * 100)}${p.level ? `|lvl ${p.level}` : ''}${p.target ? `|tgt ${p.target}` : ''}`),
    wk: [a.projection.low1, a.projection.high1],
    intraday: a.intraday || undefined,
  };
}
