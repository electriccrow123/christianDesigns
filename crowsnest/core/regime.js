// Market regime: is the tape bullish, bearish, choppy or volatile, and what posture fits it?
// Built from the index ETFs' analyses plus breadth across the watchlist.

import { clamp, round, mean } from './util.js';

export const INDEX_ETFS = ['SPY', 'QQQ', 'IWM', 'DIA'];
export const FEAR_GAUGE = 'VIXY'; // VIX futures ETF, a tradable fear proxy

/**
 * @param {Object<string, object>} analyses symbol -> analyze() result (must include SPY; QQQ/IWM help)
 * @param {object} [opts]
 * @param {object} [opts.fear] quote for the fear gauge ETF ({ changePct })
 */
export function marketRegime(analyses, { fear } = {}) {
  const idx = INDEX_ETFS.map((s) => analyses[s]).filter((a) => a && !a.insufficient);
  const spy = analyses.SPY && !analyses.SPY.insufficient ? analyses.SPY : idx[0];
  if (!spy) return { label: 'Unknown', score: 0, volatility: 'unknown', breadth: null, posture: 'Not enough data to read the market yet.', notes: [], tone: 'neutral' };

  const idxScore = mean(idx.map((a) => a.score));
  const universe = Object.values(analyses).filter((a) => a && !a.insufficient);
  const above50 = universe.filter((a) => a.trend.above50 != null);
  const breadth50 = above50.length ? (100 * above50.filter((a) => a.trend.above50).length) / above50.length : null;
  const upToday = universe.length ? (100 * universe.filter((a) => a.changePct > 0).length) / universe.length : null;

  const rv = spy.indicators.realizedVol;
  let volatility = rv == null ? 'normal' : rv < 11 ? 'low' : rv < 20 ? 'normal' : rv < 32 ? 'high' : 'extreme';
  if (fear?.changePct > 8 && volatility === 'normal') volatility = 'high';

  let score = idxScore * 0.7;
  if (breadth50 != null) score += (breadth50 - 50) * 0.5;
  if (upToday != null) score += (upToday - 50) * 0.15;
  if (fear?.changePct != null) score -= clamp(fear.changePct, -10, 15) * 0.8;
  score = Math.round(clamp(score, -100, 100));

  let label;
  if (score >= 35) label = volatility === 'high' || volatility === 'extreme' ? 'Volatile bull' : 'Bull';
  else if (score >= 12) label = 'Leaning bullish';
  else if (score <= -35) label = volatility === 'high' || volatility === 'extreme' ? 'Volatile bear' : 'Bear';
  else if (score <= -12) label = 'Leaning bearish';
  else label = volatility === 'high' || volatility === 'extreme' ? 'Choppy & volatile' : 'Neutral / range-bound';
  const tone = score >= 12 ? 'bullish' : score <= -12 ? 'bearish' : 'neutral';

  const notes = [];
  notes.push(`S&P 500 (SPY) ${spy.trend.direction === 'up' ? 'is trending up' : spy.trend.direction === 'down' ? 'is trending down' : 'is going sideways'}${spy.trend.above200 != null ? `, ${spy.trend.above200 ? 'above' : 'below'} its 200-day average` : ''}.`);
  const qqq = analyses.QQQ;
  const iwm = analyses.IWM;
  if (qqq && !qqq.insufficient && iwm && !iwm.insufficient) {
    if (qqq.score - iwm.score > 30) notes.push('Big tech (QQQ) is leading small caps (IWM): a narrow, mega-cap-driven market.');
    else if (iwm.score - qqq.score > 30) notes.push('Small caps (IWM) are leading: risk appetite is broad.');
  }
  if (breadth50 != null) notes.push(`${Math.round(breadth50)}% of tracked stocks are above their 50-day average (${breadth50 >= 60 ? 'healthy' : breadth50 <= 40 ? 'weak' : 'mixed'} breadth).`);
  if (rv != null) notes.push(`S&P realized volatility ${round(rv, 1)}% (${volatility}).`);
  if (fear?.changePct != null && Math.abs(fear.changePct) > 3) notes.push(`Fear gauge (${FEAR_GAUGE}) ${fear.changePct > 0 ? 'up' : 'down'} ${round(Math.abs(fear.changePct), 1)}% today.`);

  const posture = {
    Bull: 'Favor long stock and calls on pullbacks to support. Let winners run; keep stops under swing lows.',
    'Volatile bull': 'Up-trend with big swings: favor longs but size smaller and use wider stops or defined-risk spreads.',
    'Leaning bullish': 'Selective longs in the strongest names. Take partial profits into resistance.',
    'Neutral / range-bound': 'Range trading: buy support, sell resistance, avoid breakout chasing. Premium-selling (covered calls, cash-secured puts) fits here.',
    'Choppy & volatile': 'Hardest tape to trade. Cut size, trade less, prefer defined-risk spreads, keep more cash.',
    'Leaning bearish': 'Defensive: tighten stops on longs, raise cash, consider small put positions on weak names.',
    Bear: 'Trend is down: avoid buying dips, favor puts or cash, and only short-term longs at strong support.',
    'Volatile bear': 'Fast, scary market: protect capital first. Small size, defined risk, cash is a position.',
  }[label];

  return {
    label,
    score,
    tone,
    volatility,
    breadth: breadth50 == null ? null : Math.round(breadth50),
    upToday: upToday == null ? null : Math.round(upToday),
    indexes: Object.fromEntries(idx.map((a) => [a.symbol, { score: a.score, trend: a.trend.direction, changePct: a.changePct }])),
    posture,
    notes,
  };
}
