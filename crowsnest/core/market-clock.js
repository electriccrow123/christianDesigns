// US equity market clock in New York time: sessions, holidays, early closes and option expirations.

const TZ = 'America/New_York';

// NYSE full-day closures.
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);

// 1:00 pm ET closes.
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

// Scheduled FOMC rate decisions (2:00 pm ET on the second day of each meeting).
export const FOMC_DECISIONS = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** Break a moment into New York wall-clock parts. */
export function nyParts(date = new Date()) {
  const p = {};
  for (const { type, value } of fmtParts.formatToParts(date)) p[type] = value;
  const iso = `${p.year}-${p.month}-${p.day}`;
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    iso,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: DAY_NAMES.indexOf(p.weekday),
    weekdayName: p.weekday,
  };
}

export const todayNY = (date = new Date()) => nyParts(date).iso;

/** Add days to an ISO date (YYYY-MM-DD) using UTC math so DST never shifts the date. */
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T12:00:00Z') - Date.parse(fromIso + 'T12:00:00Z')) / 86400000);
}

export function isTradingDay(iso) {
  const wd = weekdayOf(iso);
  return wd !== 0 && wd !== 6 && !HOLIDAYS.has(iso);
}

export const isHoliday = (iso) => HOLIDAYS.has(iso);
export const isEarlyClose = (iso) => EARLY_CLOSE.has(iso);

/** Regular-session bounds in minutes after midnight NY time. */
export function sessionBounds(iso) {
  return { open: 570, close: EARLY_CLOSE.has(iso) ? 780 : 960 };
}

export function nextTradingDay(iso, { includeToday = false } = {}) {
  let d = includeToday ? iso : addDays(iso, 1);
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(iso) {
  let d = addDays(iso, -1);
  for (let i = 0; i < 15 && !isTradingDay(d); i++) d = addDays(d, -1);
  return d;
}

/** Trading days strictly between two dates, counting the end date (for DTE-style counting). */
export function tradingDaysUntil(fromIso, toIso) {
  let n = 0;
  for (let d = addDays(fromIso, 1); d <= toIso; d = addDays(d, 1)) if (isTradingDay(d)) n++;
  return n;
}

/** Monday of the week containing iso. */
export function weekStart(iso) {
  const wd = weekdayOf(iso);
  return addDays(iso, wd === 0 ? 1 : 1 - wd);
}

/** The five weekdays of the trading week that iso belongs to (Sat/Sun roll forward to next week). */
export function weekDays(iso) {
  const wd = weekdayOf(iso);
  const mon = wd === 6 ? addDays(iso, 2) : weekStart(iso);
  return [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
}

/** Third Friday of a month: standard monthly option expiration. */
export function thirdFriday(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  const d = 1 + offset + 14;
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isMonthlyOpex(iso) {
  const [y, m] = iso.split('-').map(Number);
  return thirdFriday(y, m) === iso;
}

/**
 * Where the market stands right now.
 * session: 'pre' | 'regular' | 'post' | 'overnight' | 'closed'
 */
export function marketStatus(date = new Date()) {
  const p = nyParts(date);
  const trading = isTradingDay(p.iso);
  const { open, close } = sessionBounds(p.iso);
  let session = 'closed';
  if (trading) {
    if (p.minutes >= open && p.minutes < close) session = 'regular';
    else if (p.minutes >= 240 && p.minutes < open) session = 'pre';
    else if (p.minutes >= close && p.minutes < 1200) session = 'post';
    else session = 'overnight';
  }
  const nextOpenDay = trading && p.minutes < open ? p.iso : nextTradingDay(p.iso);
  return {
    ...p,
    trading,
    session,
    isOpen: session === 'regular',
    open,
    close,
    minutesSinceOpen: session === 'regular' ? p.minutes - open : null,
    minutesToClose: session === 'regular' ? close - p.minutes : null,
    nextOpenDay,
    earlyClose: EARLY_CLOSE.has(p.iso),
    label: {
      regular: 'Market open',
      pre: 'Pre-market',
      post: 'After hours',
      overnight: 'Overnight',
      closed: trading ? 'Closed' : isHoliday(p.iso) ? 'Holiday — closed' : 'Weekend — closed',
    }[session],
  };
}

/** Convert an NY wall-clock time on a date to a real Date. */
export function nyTimeToDate(iso, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  // Start from the UTC guess and correct by the observed NY offset (handles DST).
  const guess = new Date(`${iso}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const p = nyParts(guess);
  const diff = (p.hour * 60 + p.minute - (h * 60 + m) + (p.iso === iso ? 0 : p.iso < iso ? -1440 : 1440)) * 60000;
  return new Date(guess.getTime() - diff);
}

export function fmtTimeNY(date) {
  return new Date(date).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
}

export function fmtDateNY(date, opts = { month: 'short', day: 'numeric' }) {
  return new Date(date).toLocaleDateString('en-US', { timeZone: TZ, ...opts });
}

export const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const toMinutes = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

/** 12-hour label for an HH:MM string. */
export function label12(t) {
  const m = toMinutes(t);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  return `${((h + 11) % 12) + 1}:${mm} ${h < 12 ? 'am' : 'pm'}`;
}
