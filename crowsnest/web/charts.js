// Canvas and SVG charts drawn from the theme tokens so they read in light and dark.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

function setup(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, height);
  return { ctx, w, h: height };
}

const fmtPx = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(Math.abs(v) >= 1 ? 2 : 4));

function niceTicks(lo, hi, n = 4) {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/** Account value over time. points: [[ms, value]] */
export function equityChart(canvas, points, { height = 170, empty = 'Account value will chart here as the desk runs.' } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  ctx.font = '12px ' + css('--font-body');
  if (!points || points.length < 2) {
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'center';
    ctx.fillText(empty, w / 2, h / 2);
    return;
  }
  const padL = 8;
  const padR = 56;
  const padT = 10;
  const padB = 20;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (hi === lo) {
    hi += Math.max(1, hi * 0.01);
    lo -= Math.max(1, lo * 0.01);
  }
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const x = (t) => padL + ((t - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  ctx.strokeStyle = css('--line');
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  for (const t of niceTicks(lo, hi, 3)) {
    ctx.beginPath();
    ctx.moveTo(padL, y(t));
    ctx.lineTo(w - padR, y(t));
    ctx.stroke();
    ctx.fillText('$' + fmtPx(t), w - padR + 6, y(t) + 4);
  }
  const upTrend = ys[ys.length - 1] >= ys[0];
  const color = upTrend ? css('--up') : css('--down');
  const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
  ctx.lineTo(x(xs[xs.length - 1]), h - padB);
  ctx.lineTo(x(xs[0]), h - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p[0]), y(p[1])) : ctx.moveTo(x(p[0]), y(p[1]))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  const lx = x(xs[xs.length - 1]);
  const ly = y(ys[ys.length - 1]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css('--muted');
  ctx.textAlign = 'left';
  const d0 = new Date(xs[0]);
  ctx.fillText(d0.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), padL, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(new Date(xs[xs.length - 1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), w - padR, h - 4);
}

/**
 * Candles with moving averages, support/resistance and a projection cone.
 * bars: [{t,o,h,l,c,v}] (daily); analysis: patterns.analyze() result
 */
export function priceChart(canvas, bars, analysis, { height = 320, days = 130 } = {}) {
  const { ctx, w, h } = setup(canvas, height);
  ctx.font = '11px ' + css('--font-mono');
  if (!bars?.length) {
    ctx.fillStyle = css('--muted');
    ctx.textAlign = 'center';
    ctx.fillText('No price history', w / 2, h / 2);
    return;
  }
  const view = bars.slice(-days);
  const proj = analysis?.projection;
  const projDays = proj ? proj.horizonDays : 0;
  const padL = 6;
  const padR = 62;
  const padT = 12;
  const volH = 40;
  const padB = 18 + volH;
  const n = view.length + projDays + 1;
  const sup = (analysis?.levels?.support || []).slice(0, 2);
  const res = (analysis?.levels?.resistance || []).slice(0, 2);
  let lo = Math.min(...view.map((b) => b.l));
  let hi = Math.max(...view.map((b) => b.h));
  if (proj) {
    lo = Math.min(lo, proj.low2);
    hi = Math.max(hi, proj.high2);
  }
  for (const v of [...sup, ...res]) {
    if (v > lo * 0.85 && v < hi * 1.15) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  const pad = (hi - lo) * 0.05;
  lo -= pad;
  hi += pad;
  const cw = (w - padL - padR) / n;
  const x = (i) => padL + (i + 0.5) * cw;
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  // grid
  ctx.strokeStyle = css('--line');
  ctx.fillStyle = css('--muted');
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  for (const t of niceTicks(lo, hi, 5)) {
    ctx.beginPath();
    ctx.moveTo(padL, y(t));
    ctx.lineTo(w - padR, y(t));
    ctx.stroke();
    ctx.fillText(fmtPx(t), w - padR + 6, y(t) + 4);
  }
  // levels
  const level = (v, color, label) => {
    if (v < lo || v > hi) return;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(w - padR, y(v));
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = color;
    ctx.fillText(label, padL + 4, y(v) - 4);
  };
  sup.forEach((v, i) => level(v, css('--up'), i === 0 ? `support ${fmtPx(v)}` : ''));
  res.forEach((v, i) => level(v, css('--down'), i === 0 ? `resistance ${fmtPx(v)}` : ''));
  // volume
  const vmax = Math.max(...view.map((b) => b.v || 0)) || 1;
  const vBase = h - 18;
  view.forEach((b, i) => {
    const vh = ((b.v || 0) / vmax) * (volH - 6);
    ctx.fillStyle = (b.c >= b.o ? css('--up') : css('--down')) + '44';
    ctx.fillRect(x(i) - cw * 0.35, vBase - vh, cw * 0.7, vh);
  });
  // moving averages (computed from the full series so the left edge is correct)
  const closes = bars.map((b) => b.c);
  const offset = bars.length - view.length;
  const ma = (period, color) => {
    if (closes.length < period) return;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < view.length; i++) {
      const gi = offset + i;
      if (gi < period - 1) continue;
      let s = 0;
      for (let j = gi - period + 1; j <= gi; j++) s += closes[j];
      const v = s / period;
      if (!started) {
        ctx.moveTo(x(i), y(v));
        started = true;
      } else ctx.lineTo(x(i), y(v));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  };
  ma(20, css('--sheen'));
  ma(50, css('--accent'));
  ma(200, css('--warn'));
  // candles
  view.forEach((b, i) => {
    const color = b.c >= b.o ? css('--up') : css('--down');
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(i), y(b.h));
    ctx.lineTo(x(i), y(b.l));
    ctx.stroke();
    const top = y(Math.max(b.o, b.c));
    const bh = Math.max(1, Math.abs(y(b.o) - y(b.c)));
    ctx.fillRect(x(i) - Math.max(1, cw * 0.32), top, Math.max(2, cw * 0.64), bh);
  });
  // projection cone
  if (proj) {
    const i0 = view.length - 1;
    const i1 = view.length + projDays - 1;
    const last = view[view.length - 1].c;
    const cone = (loV, hiV, alpha) => {
      ctx.beginPath();
      ctx.moveTo(x(i0), y(last));
      ctx.lineTo(x(i1), y(hiV));
      ctx.lineTo(x(i1), y(loV));
      ctx.closePath();
      ctx.fillStyle = css('--accent') + alpha;
      ctx.fill();
    };
    cone(proj.low2, proj.high2, '1c');
    cone(proj.low1, proj.high1, '33');
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = css('--accent');
    ctx.beginPath();
    ctx.moveTo(x(i0), y(last));
    ctx.lineTo(x(i1), y(proj.base));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = css('--accent');
    ctx.fillText('1-wk', x(i1) - 14, y(proj.high2) - 4);
  }
  // legend
  ctx.textAlign = 'left';
  const legend = [['20d', '--sheen'], ['50d', '--accent'], ['200d', '--warn']];
  let lx = padL + 4;
  ctx.font = '11px ' + css('--font-body');
  for (const [label, c] of legend) {
    ctx.fillStyle = css(c);
    ctx.fillRect(lx, h - 11, 10, 2);
    ctx.fillStyle = css('--muted');
    ctx.fillText(label, lx + 13, h - 6);
    lx += 46;
  }
}

/** Half-circle gauge for the regime score (-100..100), as an SVG string. */
export function gaugeSVG(score = 0) {
  const s = Math.max(-100, Math.min(100, score || 0));
  const angle = Math.PI * (1 - (s + 100) / 200);
  const cx = 110;
  const cy = 104;
  const r = 84;
  const px = cx + r * Math.cos(angle);
  const py = cy - r * Math.sin(angle);
  const arc = (a0, a1, color) => {
    const x0 = cx + r * Math.cos(a0);
    const y0 = cy - r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy - r * Math.sin(a1);
    return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${color}" stroke-width="12" fill="none" stroke-linecap="butt"/>`;
  };
  return `<svg class="gauge" viewBox="0 0 220 124" role="img" aria-label="Market regime score ${s}">
    ${arc(Math.PI, Math.PI * 0.62, 'var(--down)')}
    ${arc(Math.PI * 0.62, Math.PI * 0.38, 'var(--surface-3)')}
    ${arc(Math.PI * 0.38, 0, 'var(--up)')}
    <line x1="${cx}" y1="${cy}" x2="${(cx + (px - cx) * 0.82).toFixed(1)}" y2="${(cy + (py - cy) * 0.82).toFixed(1)}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="6" fill="var(--text)"/>
    <text x="16" y="120" fill="var(--muted)" font-size="11" font-family="var(--font-body)">Bear</text>
    <text x="204" y="120" fill="var(--muted)" font-size="11" text-anchor="end" font-family="var(--font-body)">Bull</text>
  </svg>`;
}
