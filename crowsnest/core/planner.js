// The desk's calendar: the fixed rhythm of check-ins (week → day → hour), market events, and the
// AI's own plan layered on top.

import {
  marketStatus, todayNY, weekDays, isTradingDay, isHoliday, isEarlyClose, isMonthlyOpex, nextTradingDay,
  FOMC_DECISIONS, toMinutes, hhmm, weekdayOf, DAY_NAMES, addDays,
} from './market-clock.js';

/** The desk's standard check-ins on a trading day (New York time). */
export const CYCLE_SLOTS = [
  { time: '08:45', kind: 'premarket', name: 'Pre-market briefing', what: 'Read overnight moves, set today’s plan, levels and watchlist.' },
  { time: '09:50', kind: 'intraday', name: 'Opening read', what: 'Opening range is in. Act on planned entries that triggered.' },
  { time: '10:45', kind: 'intraday', name: 'Hourly check', what: 'Re-check trends and open positions; adjust stops.' },
  { time: '11:45', kind: 'intraday', name: 'Hourly check', what: 'Midday: momentum usually fades; look for pullback entries.' },
  { time: '12:45', kind: 'intraday', name: 'Hourly check', what: 'Lunch lull. Manage positions, avoid forcing trades.' },
  { time: '13:45', kind: 'intraday', name: 'Hourly check', what: 'Afternoon trend starts to show.' },
  { time: '14:45', kind: 'intraday', name: 'Hourly check', what: 'Set up for the close; trim weak positions.' },
  { time: '15:30', kind: 'power', name: 'Power hour', what: 'Close same-day options, tighten stops, decide what to hold overnight.' },
  { time: '16:15', kind: 'close', name: 'Close review', what: 'Grade the day, write the journal, prep tomorrow.' },
];

export const WEEKLY_SLOT = { day: 'Sun', time: '18:00', kind: 'weekly', name: 'Weekly game plan', what: 'Big picture, sector themes, earnings and events, focus list and targets for the week.' };

/** Slots for a given day, trimmed for early closes. */
export function slotsFor(iso) {
  if (!isTradingDay(iso)) return [];
  const close = isEarlyClose(iso) ? 780 : 960;
  return CYCLE_SLOTS.filter((s) => s.kind === 'premarket' || s.kind === 'close' || toMinutes(s.time) < close - 10).map((s) =>
    s.kind === 'power' && close === 780 ? { ...s, time: '12:30' } : s.kind === 'close' && close === 780 ? { ...s, time: '13:15' } : s,
  );
}

/** The next check-in after `now` (looks ahead up to 10 days). */
export function nextSlot(now = new Date()) {
  const st = marketStatus(now);
  for (let i = 0; i < 10; i++) {
    const iso = addDays(st.iso, i);
    const wd = weekdayOf(iso);
    if (wd === 0 && (i > 0 || st.minutes < toMinutes(WEEKLY_SLOT.time))) return { iso, ...WEEKLY_SLOT };
    for (const s of slotsFor(iso)) if (i > 0 || toMinutes(s.time) > st.minutes) return { iso, ...s };
  }
  return null;
}

/** The most recent check-in that has already started today (for "due" prompts). */
export function dueSlot(now = new Date(), lastRunAt = 0) {
  const st = marketStatus(now);
  const slots = slotsFor(st.iso).filter((s) => toMinutes(s.time) <= st.minutes);
  const latest = slots[slots.length - 1];
  if (!latest) return null;
  const lastRun = lastRunAt ? marketStatus(new Date(lastRunAt)) : null;
  const ranSince = lastRun && lastRun.iso === st.iso && lastRun.minutes >= toMinutes(latest.time);
  return ranSince ? null : { iso: st.iso, ...latest };
}

/**
 * Calendar events for a week: holidays, early closes, FOMC, monthly/quarterly option expiration,
 * and earnings for the symbols the desk cares about.
 */
export function weekEvents(anyIsoInWeek, { earnings = [], focusSymbols = [] } = {}) {
  const days = weekDays(anyIsoInWeek);
  const focus = new Set(focusSymbols.map((s) => s.toUpperCase()));
  return days.map((iso) => {
    const ev = [];
    if (isHoliday(iso)) ev.push({ type: 'holiday', text: 'Market closed (holiday)', severity: 'high' });
    if (isEarlyClose(iso)) ev.push({ type: 'early_close', text: 'Early close at 1:00 pm ET', severity: 'medium' });
    if (FOMC_DECISIONS.includes(iso)) ev.push({ type: 'fomc', text: 'Fed rate decision 2:00 pm ET (expect volatility)', severity: 'high' });
    if (isMonthlyOpex(iso)) {
      const m = Number(iso.slice(5, 7));
      ev.push({ type: 'opex', text: [3, 6, 9, 12].includes(m) ? 'Quarterly options expiration (“triple witching”)' : 'Monthly options expiration', severity: 'medium' });
    } else if (weekdayOf(iso) === 5) ev.push({ type: 'opex', text: 'Weekly options expire', severity: 'low' });
    for (const e of earnings) {
      if (e.date !== iso) continue;
      const mine = focus.has(e.symbol);
      if (!mine && e.big !== true) continue;
      ev.push({ type: 'earnings', symbol: e.symbol, text: `${e.symbol} earnings ${e.timing === 'am' ? 'before open' : e.timing === 'pm' ? 'after close' : ''}`.trim(), severity: mine ? 'high' : 'low' });
    }
    return { iso, day: DAY_NAMES[weekdayOf(iso)], trading: isTradingDay(iso), events: ev };
  });
}

/** Today's hour-by-hour timeline: fixed slots merged with the AI's scheduled tasks. */
export function todayTimeline({ now = new Date(), aiSchedule = [], cycles = [] } = {}) {
  const st = marketStatus(now);
  const iso = st.trading ? st.iso : nextTradingDay(st.iso);
  const base = slotsFor(iso).map((s) => ({ ...s, source: 'desk', tasks: [] }));
  for (const item of aiSchedule || []) {
    if (!item?.time) continue;
    const m = toMinutes(item.time);
    if (!Number.isFinite(m)) continue;
    // Attach to the slot at or just before the item's time; otherwise make its own row.
    let host = null;
    for (const s of base) if (toMinutes(s.time) <= m) host = s;
    if (host && m - toMinutes(host.time) < 60) host.tasks.push(item);
    else base.push({ time: hhmm(m), kind: 'task', name: item.task || 'Planned task', what: '', source: 'ai', tasks: [item] });
  }
  base.sort((a, b) => toMinutes(a.time) - toMinutes(b.time));
  const doneTimes = new Set(
    (cycles || [])
      .filter((c) => c.at && todayNY(new Date(c.at)) === iso)
      .map((c) => {
        const t = marketStatus(new Date(c.at)).minutes;
        let host = null;
        for (const s of base) if (toMinutes(s.time) <= t) host = s.time;
        return host;
      }),
  );
  return {
    iso,
    isToday: iso === st.iso,
    rows: base.map((s) => ({
      ...s,
      status: doneTimes.has(s.time) ? 'done' : iso !== st.iso ? 'upcoming' : toMinutes(s.time) <= st.minutes ? 'missed' : 'upcoming',
    })),
  };
}

/** Empty plan shapes, so the UI always has something to render. */
export function emptyWeekPlan(iso = todayNY()) {
  const days = weekDays(iso);
  return {
    weekOf: days[0],
    thesis: '',
    regime: '',
    focus: [],
    days: days.map((d) => ({ date: d, day: DAY_NAMES[weekdayOf(d)], theme: '', plan: '' })),
    scenarios: [],
    riskBudget: '',
    createdAt: null,
  };
}

export function emptyDayPlan(iso = todayNY()) {
  return { date: iso, briefing: '', keyLevels: [], schedule: [], watch: [], createdAt: null };
}
