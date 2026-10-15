// The five risk modes. Each mode sets what the desk may trade and how big; the AI may tune the
// "adjustable" parameters, but only inside the bounds listed for that mode. User hard limits
// (Settings) can only tighten these further.

export const PARAMS = {
  maxPositionPct: { label: 'Max size per stock position', unit: '% of account', ai: true, explain: 'The most of your account one stock position may use.' },
  maxOptionPositionPct: { label: 'Max size per option position', unit: '% of account', ai: true, explain: 'The most premium one option trade may risk.' },
  maxOptionsAllocPct: { label: 'Max total in options', unit: '% of account', ai: false, explain: 'All option positions together may not exceed this.' },
  maxInvestedPct: { label: 'Max invested', unit: '% of account', ai: true, explain: 'The rest stays in cash as a cushion.' },
  stopLossPct: { label: 'Stock stop-loss', unit: '% below entry', ai: true, explain: 'Where a losing stock trade is cut.' },
  takeProfitPct: { label: 'Stock profit target', unit: '% above entry', ai: true, explain: 'Where gains are taken (or a trailing stop starts).' },
  optionStopPct: { label: 'Option stop-loss', unit: '% of premium', ai: true, explain: 'Cut an option when it has lost this much of what was paid.' },
  optionTakeProfitPct: { label: 'Option profit target', unit: '% gain on premium', ai: true, explain: 'Take profits on an option at this gain.' },
  minDte: { label: 'Shortest expiration', unit: 'days', ai: true, explain: 'Options expiring sooner than this are off-limits.' },
  maxDte: { label: 'Longest expiration', unit: 'days', ai: true, explain: 'Options expiring later than this are off-limits.' },
  deltaMin: { label: 'Lowest delta', unit: 'Δ', ai: true, explain: 'Delta ≈ chance of finishing in the money. Low delta = cheap, long-shot contracts.' },
  deltaMax: { label: 'Highest delta', unit: 'Δ', ai: true, explain: 'High delta contracts behave more like the stock.' },
  maxSpreadPct: { label: 'Widest bid-ask spread', unit: '% of mid', ai: false, explain: 'Wide spreads cost you money on every fill.' },
  minOpenInterest: { label: 'Minimum open interest', unit: 'contracts', ai: false, explain: 'Liquidity floor so you can get out.' },
  dailyLossLimitPct: { label: 'Daily loss circuit breaker', unit: '% of account', ai: false, explain: 'New trades stop for the day after this loss.' },
  maxTradesPerDay: { label: 'Max new trades per day', unit: 'trades', ai: false, explain: 'Caps over-trading.' },
  maxPositions: { label: 'Max open positions', unit: 'positions', ai: true, explain: 'Keeps the book focused.' },
  minConviction: { label: 'Minimum conviction to trade', unit: '1–5', ai: true, explain: 'Ideas below this conviction are only watched.' },
  minPrice: { label: 'Lowest stock price', unit: '$', ai: false, explain: 'Avoids penny stocks.' },
  minMarketCapB: { label: 'Smallest company size', unit: '$ billions', ai: false, explain: 'Bigger companies tend to move less violently.' },
  avoidOpenMinutes: { label: 'Skip the first minutes after the open', unit: 'minutes', ai: false, explain: 'The opening minutes are the most erratic.' },
};

const M = (values, bounds) => ({ values, bounds });

export const MODES = [
  {
    id: 'fortress',
    level: 1,
    name: 'Fortress',
    tagline: 'Protect capital first',
    color: 'var(--mode-1)',
    description: 'Large, established companies and broad ETFs only. No options. Small positions, tight stops, lots of cash. Slow and steady.',
    goal: 'Beat a savings account without big drawdowns.',
    strategies: ['stock'],
    earningsPlays: false,
    extendedHours: false,
    allowZeroDte: false,
    ...M(
      { maxPositionPct: 10, maxOptionPositionPct: 0, maxOptionsAllocPct: 0, maxInvestedPct: 60, stopLossPct: 4, takeProfitPct: 8, optionStopPct: 0, optionTakeProfitPct: 0, minDte: 0, maxDte: 0, deltaMin: 0, deltaMax: 0, maxSpreadPct: 0, minOpenInterest: 0, dailyLossLimitPct: 1.5, maxTradesPerDay: 3, maxPositions: 6, minConviction: 4, minPrice: 10, minMarketCapB: 50, avoidOpenMinutes: 30 },
      { maxPositionPct: [5, 12], maxInvestedPct: [30, 70], stopLossPct: [2.5, 6], takeProfitPct: [5, 12], maxPositions: [3, 8], minConviction: [4, 5] },
    ),
  },
  {
    id: 'steady',
    level: 2,
    name: 'Steady',
    tagline: 'Conservative growth + income',
    color: 'var(--mode-2)',
    description: 'Quality stocks and ETFs, plus income options: covered calls and cash-secured puts on names you would happily own. No speculative contracts.',
    goal: 'Grow faster than the market’s average with modest swings.',
    strategies: ['stock', 'covered_call', 'cash_secured_put'],
    earningsPlays: false,
    extendedHours: false,
    allowZeroDte: false,
    ...M(
      { maxPositionPct: 15, maxOptionPositionPct: 15, maxOptionsAllocPct: 25, maxInvestedPct: 75, stopLossPct: 6, takeProfitPct: 12, optionStopPct: 100, optionTakeProfitPct: 60, minDte: 21, maxDte: 60, deltaMin: 0.15, deltaMax: 0.35, maxSpreadPct: 10, minOpenInterest: 200, dailyLossLimitPct: 2.5, maxTradesPerDay: 5, maxPositions: 8, minConviction: 3, minPrice: 5, minMarketCapB: 10, avoidOpenMinutes: 20 },
      { maxPositionPct: [8, 18], maxOptionPositionPct: [5, 18], maxInvestedPct: [50, 85], stopLossPct: [4, 9], takeProfitPct: [8, 20], optionStopPct: [60, 150], optionTakeProfitPct: [40, 80], minDte: [14, 30], maxDte: [30, 75], deltaMin: [0.1, 0.25], deltaMax: [0.25, 0.4], maxPositions: [4, 10], minConviction: [3, 5] },
    ),
  },
  {
    id: 'balanced',
    level: 3,
    name: 'Balanced',
    tagline: 'Growth with guardrails',
    color: 'var(--mode-3)',
    description: 'Stocks plus directional options with time to work: calls, puts and debit spreads with 3+ weeks to expiration, along with income trades.',
    goal: 'Meaningful growth; expect some losing weeks.',
    strategies: ['stock', 'long_call', 'long_put', 'call_debit_spread', 'put_debit_spread', 'covered_call', 'cash_secured_put', 'put_credit_spread', 'call_credit_spread'],
    earningsPlays: false,
    extendedHours: false,
    allowZeroDte: false,
    ...M(
      { maxPositionPct: 20, maxOptionPositionPct: 5, maxOptionsAllocPct: 30, maxInvestedPct: 85, stopLossPct: 8, takeProfitPct: 20, optionStopPct: 40, optionTakeProfitPct: 60, minDte: 21, maxDte: 90, deltaMin: 0.4, deltaMax: 0.7, maxSpreadPct: 10, minOpenInterest: 100, dailyLossLimitPct: 4, maxTradesPerDay: 8, maxPositions: 10, minConviction: 3, minPrice: 5, minMarketCapB: 2, avoidOpenMinutes: 15 },
      { maxPositionPct: [10, 25], maxOptionPositionPct: [2, 8], maxInvestedPct: [60, 95], stopLossPct: [5, 12], takeProfitPct: [12, 35], optionStopPct: [30, 55], optionTakeProfitPct: [40, 100], minDte: [14, 30], maxDte: [45, 120], deltaMin: [0.3, 0.5], deltaMax: [0.55, 0.8], maxPositions: [5, 12], minConviction: [2, 4] },
    ),
  },
  {
    id: 'aggressive',
    level: 4,
    name: 'Aggressive',
    tagline: 'High growth, high swings',
    color: 'var(--mode-4)',
    description: 'Momentum stocks, small caps above $2, and shorter-dated options (1+ week). Earnings plays allowed. Bigger positions and wider stops. Expect sharp drawdowns.',
    goal: 'Outsized growth; accepts losing a large chunk in bad stretches.',
    strategies: ['stock', 'long_call', 'long_put', 'call_debit_spread', 'put_debit_spread', 'covered_call', 'cash_secured_put', 'put_credit_spread', 'call_credit_spread'],
    earningsPlays: true,
    extendedHours: true,
    allowZeroDte: false,
    ...M(
      { maxPositionPct: 30, maxOptionPositionPct: 10, maxOptionsAllocPct: 50, maxInvestedPct: 95, stopLossPct: 10, takeProfitPct: 30, optionStopPct: 50, optionTakeProfitPct: 100, minDte: 7, maxDte: 60, deltaMin: 0.25, deltaMax: 0.65, maxSpreadPct: 15, minOpenInterest: 50, dailyLossLimitPct: 6, maxTradesPerDay: 15, maxPositions: 12, minConviction: 3, minPrice: 2, minMarketCapB: 0.3, avoidOpenMinutes: 5 },
      { maxPositionPct: [15, 35], maxOptionPositionPct: [5, 12], maxInvestedPct: [70, 100], stopLossPct: [6, 15], takeProfitPct: [15, 60], optionStopPct: [35, 65], optionTakeProfitPct: [60, 200], minDte: [5, 14], maxDte: [21, 90], deltaMin: [0.2, 0.4], deltaMax: [0.5, 0.75], maxPositions: [6, 15], minConviction: [2, 4] },
    ),
  },
  {
    id: 'moonshot',
    level: 5,
    name: 'Moonshot',
    tagline: 'Maximum risk, maximum upside',
    color: 'var(--mode-5)',
    description: 'Everything in Aggressive plus same-week and same-day (0DTE) options, cheap out-of-the-money contracts and extended-hours trading. Many trades will go to zero. Only use money you can afford to lose entirely.',
    goal: 'Swing for home runs. Large losses are likely along the way.',
    strategies: ['stock', 'long_call', 'long_put', 'call_debit_spread', 'put_debit_spread', 'covered_call', 'cash_secured_put', 'put_credit_spread', 'call_credit_spread'],
    earningsPlays: true,
    extendedHours: true,
    allowZeroDte: true,
    ...M(
      { maxPositionPct: 40, maxOptionPositionPct: 15, maxOptionsAllocPct: 80, maxInvestedPct: 100, stopLossPct: 15, takeProfitPct: 50, optionStopPct: 60, optionTakeProfitPct: 150, minDte: 0, maxDte: 45, deltaMin: 0.15, deltaMax: 0.6, maxSpreadPct: 20, minOpenInterest: 25, dailyLossLimitPct: 10, maxTradesPerDay: 25, maxPositions: 15, minConviction: 2, minPrice: 1, minMarketCapB: 0.1, avoidOpenMinutes: 0 },
      { maxPositionPct: [20, 50], maxOptionPositionPct: [8, 20], maxInvestedPct: [80, 100], stopLossPct: [8, 25], takeProfitPct: [25, 150], optionStopPct: [40, 80], optionTakeProfitPct: [80, 400], minDte: [0, 7], maxDte: [7, 60], deltaMin: [0.1, 0.3], deltaMax: [0.4, 0.7], maxPositions: [8, 20], minConviction: [2, 4] },
    ),
  },
];

export const modeById = (id) => MODES.find((m) => m.id === id) || MODES[2];
export const modeByLevel = (lvl) => MODES.find((m) => m.level === lvl) || MODES[2];

/** Default user hard limits. These only ever tighten a mode. */
export const DEFAULT_LIMITS = {
  maxOrderDollars: 0, // 0 = no extra cap
  dailyLossLimitPct: 0, // 0 = use the mode's
  maxTradesPerDay: 0,
  pdtGuard: true,
  blocklist: [],
  allowExtendedHours: true,
  requireExitPlan: true,
  autoDowngradeOnDrawdownPct: 0, // e.g. 15 = drop one mode level after a 15% drawdown from the peak
};

/**
 * Effective parameters for a mode: defaults, then the AI's adjustments clamped to the mode's
 * bounds, then the user's hard limits (tighten only).
 * @returns {object} params plus `adjusted` (which keys the AI changed) and `mode`
 */
export function resolveParams(modeId, aiOverrides = {}, limits = {}) {
  const mode = modeById(modeId);
  const params = { ...mode.values };
  const adjusted = {};
  for (const [k, v] of Object.entries(aiOverrides || {})) {
    const b = mode.bounds[k];
    if (!b || !PARAMS[k]?.ai || !Number.isFinite(Number(v))) continue;
    const val = Math.min(b[1], Math.max(b[0], Number(v)));
    if (val !== params[k]) {
      adjusted[k] = { from: params[k], to: val };
      params[k] = val;
    }
  }
  if (params.deltaMin > params.deltaMax) params.deltaMin = params.deltaMax;
  if (params.minDte > params.maxDte) params.minDte = params.maxDte;
  const L = { ...DEFAULT_LIMITS, ...limits };
  if (L.dailyLossLimitPct > 0) params.dailyLossLimitPct = Math.min(params.dailyLossLimitPct, L.dailyLossLimitPct);
  if (L.maxTradesPerDay > 0) params.maxTradesPerDay = Math.min(params.maxTradesPerDay, L.maxTradesPerDay);
  return { ...params, mode, adjusted, limits: L, strategies: mode.strategies, earningsPlays: mode.earningsPlays, extendedHours: mode.extendedHours && L.allowExtendedHours, allowZeroDte: mode.allowZeroDte };
}

/** Plain-English rules for a mode, for prompts and the Settings page. */
export function modeRules(p) {
  const m = p.mode;
  const lines = [
    `Mode ${m.level}/5 "${m.name}": ${m.description}`,
    `Allowed strategies: ${p.strategies.join(', ')}.`,
    `Stocks: price ≥ $${p.minPrice}, market cap ≥ $${p.minMarketCapB}B; max ${p.maxPositionPct}% of account per position; stop ${p.stopLossPct}% / target ${p.takeProfitPct}%.`,
    `Keep at least ${100 - p.maxInvestedPct}% in cash. Max ${p.maxPositions} open positions, ${p.maxTradesPerDay} new trades per day. Minimum conviction ${p.minConviction}/5.`,
  ];
  if (p.strategies.some((s) => s !== 'stock')) {
    lines.push(`Options: ${p.minDte}–${p.maxDte} days to expiration${p.allowZeroDte ? ' (0DTE allowed)' : ''}, |delta| ${p.deltaMin}–${p.deltaMax} for long contracts, max ${p.maxOptionPositionPct}% of account per option trade and ${p.maxOptionsAllocPct}% in options overall; bid-ask spread ≤ ${p.maxSpreadPct}% of mid; open interest ≥ ${p.minOpenInterest}. Option stop ${p.optionStopPct}% of premium, target +${p.optionTakeProfitPct}%.`);
  }
  lines.push(`Daily loss circuit breaker: −${p.dailyLossLimitPct}%. Earnings plays ${p.earningsPlays ? 'allowed' : 'not allowed (no new option buys within 3 days before a report)'}. Extended hours ${p.extendedHours ? 'allowed (limit orders only)' : 'not allowed'}. Skip the first ${p.avoidOpenMinutes} minutes after the open for new entries.`);
  return lines.join('\n');
}

/** What the AI may change, with bounds, for prompts. */
export function adjustableSpec(modeId) {
  const mode = modeById(modeId);
  return Object.fromEntries(Object.entries(mode.bounds).map(([k, b]) => [k, { now: mode.values[k], min: b[0], max: b[1], unit: PARAMS[k].unit }]));
}
