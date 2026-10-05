// Canvas-drawn UI panels that live in 3D. Any pointer ray or fingertip that hits
// the panel is turned into canvas pixels and dispatched to the buttons drawn last frame.
import * as THREE from 'three';
import { G, emit } from './core.js';

export class CanvasPanel {
  constructor({ width = 1024, height = 600, draw, interval = 0.25 }) {
    this.w = width; this.h = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, transparent: true, side: THREE.DoubleSide });
    this.drawFn = draw;
    this.buttons = [];
    this.hoverId = null;
    this.interval = interval;
    this.timer = 0;
    this.dirty = true;
    this.meshes = [];
    G.panels ||= [];
    G.panels.push(this);
  }

  // Creates a mesh that shows this panel (several meshes may share one panel).
  createMesh(worldWidth) {
    const geo = new THREE.PlaneGeometry(worldWidth, worldWidth * this.h / this.w);
    const m = new THREE.Mesh(geo, this.material);
    m.userData.panel = this;
    m.userData.worldW = worldWidth;
    m.userData.worldH = worldWidth * this.h / this.w;
    this.meshes.push(m);
    G.interactables.push(m);
    return m;
  }

  update(dt) {
    this.timer += dt;
    if (this.dirty || (this.interval && this.timer >= this.interval)) {
      this.timer = 0;
      this.dirty = false;
      this.redraw();
    }
  }

  redraw() {
    this.buttons.length = 0;
    this.drawFn(this.ctx, this);
    this.texture.needsUpdate = true;
  }

  // ---- drawing helpers usable by draw functions ----
  button(x, y, w, h, label, fn, opts = {}) {
    const g = this.ctx;
    const id = opts.id || label + '@' + x + ',' + y;
    const hover = this.hoverId === id && !opts.disabled;
    const active = !!opts.active;
    const color = opts.disabled ? '#3a4a55' : opts.color || '#2fd6ff';
    g.save();
    g.fillStyle = active ? color : hover ? 'rgba(47,214,255,0.28)' : opts.fill || 'rgba(10,40,60,0.85)';
    roundRect(g, x, y, w, h, opts.radius ?? 10);
    g.fill();
    g.lineWidth = hover ? 4 : 2;
    g.strokeStyle = color;
    g.stroke();
    g.fillStyle = active ? '#001018' : opts.disabled ? '#6a7a85' : opts.textColor || '#dff8ff';
    g.font = `${opts.bold === false ? '' : 'bold '}${opts.size || 24}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const lines = String(label).split('\n');
    lines.forEach((ln, i) => g.fillText(ln, x + w / 2, y + h / 2 + (i - (lines.length - 1) / 2) * ((opts.size || 24) + 4)));
    g.restore();
    if (!opts.disabled) this.buttons.push({ id, x, y, w, h, fn });
  }

  text(str, x, y, { size = 22, color = '#cfefff', align = 'left', bold = false, font = 'system-ui, sans-serif', maxW } = {}) {
    const g = this.ctx;
    g.font = `${bold ? 'bold ' : ''}${size}px ${font}`;
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    if (maxW) g.fillText(str, x, y, maxW); else g.fillText(str, x, y);
  }

  bar(x, y, w, h, frac, color, label) {
    const g = this.ctx;
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x, y, w, h);
    g.fillStyle = color; g.fillRect(x, y, w * Math.max(0, Math.min(1, frac)), h);
    g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.strokeRect(x, y, w, h);
    if (label) this.text(label, x + 8, y + h - 6, { size: Math.min(20, h - 4), color: '#fff', bold: true });
  }

  frame(title) {
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = 'rgba(2,12,22,0.92)';
    roundRect(g, 0, 0, this.w, this.h, 18); g.fill();
    g.strokeStyle = '#2fd6ff'; g.lineWidth = 4; g.stroke();
    // scanlines
    g.fillStyle = 'rgba(47,214,255,0.035)';
    for (let y = 0; y < this.h; y += 4) g.fillRect(0, y, this.w, 1);
    if (title) this.text(title, 20, 38, { size: 26, bold: true, color: '#2fd6ff' });
  }

  // uv in [0,1]² (three.js plane UVs: v=0 at the bottom)
  toPx(uv) { return { x: uv.x * this.w, y: (1 - uv.y) * this.h }; }

  hit(uv) {
    const p = this.toPx(uv);
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return b;
    }
    return null;
  }

  hover(uv) {
    const b = uv ? this.hit(uv) : null;
    const id = b ? b.id : null;
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.dirty = true;
      if (id) emit('sfx', 'hover');
    }
  }

  click(uv) {
    const b = this.hit(uv);
    if (b) {
      emit('sfx', 'click');
      b.fn(this.toPx(uv));
      this.dirty = true;
      return true;
    }
    return false;
  }
}

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Wraps text into lines that fit `maxW` pixels.
export function wrap(g, text, maxW) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (g.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
