// Minimal canvas charts (no external libraries): price line, equity curve, option payoff.

const COLORS = { up: '#22c55e', down: '#ef4444', grid: '#243049', text: '#8b97ad', accent: '#4f8cff', zero: '#475569' };

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = Number(canvas.getAttribute('height')) || 200;
  canvas.style.height = h + 'px';
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
  return ticks;
}

const fmtNum = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2));

/**
 * points: [[unixSecondsOrMs, value], ...]
 * opts: { baseline, timeFmt: (t)=>string, valueFmt }
 */
export function lineChart(canvas, points, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  canvas._chart = { points, opts };
  if (!points || points.length < 2) return;
  const pad = { l: 8, r: 62, t: 10, b: 22 };
  const vals = points.map((p) => p[1]);
  let min = Math.min(...vals, opts.baseline ?? Infinity);
  let max = Math.max(...vals, opts.baseline ?? -Infinity);
  const m = (max - min) * 0.08 || max * 0.01 || 1;
  min -= m;
  max += m;
  const x = (i) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
  const first = opts.baseline ?? points[0][1];
  const last = points[points.length - 1][1];
  const color = last >= first ? COLORS.up : COLORS.down;

  ctx.font = '11px system-ui';
  ctx.fillStyle = COLORS.text;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (const t of niceTicks(min, max)) {
    ctx.beginPath();
    ctx.moveTo(pad.l, y(t) + 0.5);
    ctx.lineTo(w - pad.r, y(t) + 0.5);
    ctx.stroke();
    ctx.fillText((opts.valueFmt || fmtNum)(t), w - pad.r + 6, y(t) + 4);
  }
  if (opts.timeFmt) {
    const n = Math.min(5, points.length);
    for (let k = 0; k < n; k++) {
      const i = Math.round((k / (n - 1 || 1)) * (points.length - 1));
      const label = opts.timeFmt(points[i][0]);
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(Math.max(pad.l, x(i) - tw / 2), w - pad.r - tw), h - 6);
    }
  }
  if (opts.baseline != null) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLORS.zero;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(opts.baseline));
    ctx.lineTo(w - pad.r, y(opts.baseline));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // area
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, color + '40');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))));
  ctx.lineTo(x(points.length - 1), h - pad.b);
  ctx.lineTo(x(0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // line
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  // hover
  const hi = canvas._hover;
  if (hi != null && hi >= 0 && hi < points.length) {
    const px = x(hi);
    const py = y(points[hi][1]);
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, pad.t);
    ctx.lineTo(px, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    const label = `${(opts.valueFmt || fmtNum)(points[hi][1])}${opts.timeFmt ? '  ·  ' + opts.timeFmt(points[hi][0], true) : ''}`;
    ctx.font = '12px system-ui';
    const tw = ctx.measureText(label).width + 12;
    const bx = Math.min(Math.max(px - tw / 2, pad.l), w - pad.r - tw);
    ctx.fillStyle = '#182033';
    ctx.fillRect(bx, pad.t, tw, 20);
    ctx.fillStyle = '#e6ebf5';
    ctx.fillText(label, bx + 6, pad.t + 14);
  }

  if (!canvas._hoverBound) {
    canvas._hoverBound = true;
    canvas.addEventListener('mousemove', (e) => {
      const c = canvas._chart;
      if (!c?.points?.length) return;
      const r = canvas.getBoundingClientRect();
      const frac = (e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r);
      canvas._hover = Math.max(0, Math.min(c.points.length - 1, Math.round(frac * (c.points.length - 1))));
      lineChart(canvas, c.points, c.opts);
    });
    canvas.addEventListener('mouseleave', () => {
      canvas._hover = null;
      const c = canvas._chart;
      if (c) lineChart(canvas, c.points, c.opts);
    });
  }
}

/**
 * Payoff-at-expiration diagram.
 * fn: (S) => P/L dollars. spot: current underlying price. breakevens: [prices]
 */
export function payoffChart(canvas, fn, { spot, lo, hi, breakevens = [] }) {
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 6, r: 6, t: 14, b: 18 };
  const N = 120;
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const ys = xs.map(fn);
  let min = Math.min(...ys, 0);
  let max = Math.max(...ys, 0);
  const m = (max - min) * 0.1 || 1;
  min -= m;
  max += m;
  const X = (s) => pad.l + ((s - lo) / (hi - lo)) * (w - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

  // zero line
  ctx.strokeStyle = COLORS.zero;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, Y(0));
  ctx.lineTo(w - pad.r, Y(0));
  ctx.stroke();

  // fill profit / loss areas
  for (let i = 0; i < N; i++) {
    const avg = (ys[i] + ys[i + 1]) / 2;
    ctx.fillStyle = avg >= 0 ? 'rgba(34,197,94,.22)' : 'rgba(239,68,68,.22)';
    ctx.beginPath();
    ctx.moveTo(X(xs[i]), Y(0));
    ctx.lineTo(X(xs[i]), Y(ys[i]));
    ctx.lineTo(X(xs[i + 1]), Y(ys[i + 1]));
    ctx.lineTo(X(xs[i + 1]), Y(0));
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  xs.forEach((s, i) => (i ? ctx.lineTo(X(s), Y(ys[i])) : ctx.moveTo(X(s), Y(ys[i]))));
  ctx.strokeStyle = '#e6ebf5';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.font = '10px system-ui';
  if (spot >= lo && spot <= hi) {
    ctx.strokeStyle = COLORS.accent;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(spot), pad.t);
    ctx.lineTo(X(spot), h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(`now ${spot.toFixed(2)}`, Math.min(X(spot) + 3, w - 60), pad.t - 3);
  }
  ctx.fillStyle = COLORS.text;
  for (const b of breakevens) {
    if (b < lo || b > hi) continue;
    ctx.beginPath();
    ctx.arc(X(b), Y(0), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`BE ${b.toFixed(2)}`, Math.min(X(b) + 4, w - 50), Y(0) + 12);
  }
  ctx.fillText(lo.toFixed(0), pad.l, h - 4);
  const hiLabel = hi.toFixed(0);
  ctx.fillText(hiLabel, w - pad.r - ctx.measureText(hiLabel).width, h - 4);
}
