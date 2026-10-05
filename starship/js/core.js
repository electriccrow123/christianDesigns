// Shared game context, event bus, math helpers and the stencil "portal" registries.
import * as THREE from 'three';

export const G = {
  scene: null,
  camera: null,
  renderer: null,
  mode: 'desktop', // 'desktop' | 'vr' | 'ar'
  time: 0,
  dt: 0,
  frame: null, // current XRFrame
  refSpace: null,
  interactables: [], // meshes the pointers can hit (panels, controls, items)
  pokeables: [], // controls that respond to a fingertip / controller tip
  spaceTargets: [], // objects in space that can be targeted by pointing
  activeTool: null, // build-mode tool that intercepts the trigger
  head: new THREE.Vector3(0, 1.6, 0),
  headQuat: new THREE.Quaternion(),
};

// ---------- event bus ----------
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); }

// ---------- math ----------
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Walks up the parent chain to find the first object carrying userData[key].
export function findOwner(obj, key) {
  while (obj) {
    if (obj.userData && obj.userData[key]) return obj.userData[key];
    obj = obj.parent;
  }
  return null;
}

export function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

// ---------- stencil portals ----------
// Windows write stencil=1. Space only draws where stencil==1 (unless the hull is
// in "observation" mode), and virtual walls only draw where stencil!=1.
export const spaceMats = new Set();
export const wallMats = new Set();
export const view = { portal: 'windows' }; // 'windows' | 'open'

function applySpace(m) {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = view.portal === 'open' ? THREE.AlwaysStencilFunc : THREE.EqualStencilFunc;
  m.stencilFail = m.stencilZFail = m.stencilZPass = THREE.KeepStencilOp;
}
export function spaceMat(m) { applySpace(m); spaceMats.add(m); return m; }
export function wallMat(m) {
  m.stencilWrite = true;
  m.stencilRef = 1;
  m.stencilFunc = THREE.NotEqualStencilFunc;
  m.stencilFail = m.stencilZFail = m.stencilZPass = THREE.KeepStencilOp;
  wallMats.add(m);
  return m;
}
export function setPortalMode(mode) {
  view.portal = mode;
  for (const m of spaceMats) applySpace(m);
  emit('portal', mode);
}

// ---------- shared tiny helpers for building meshes ----------
export function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.4, ...opts });
}
export function glow(color, opts = {}) {
  return new THREE.MeshBasicMaterial({ color, toneMapped: false, ...opts });
}
export function box(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
export function cyl(rt, rb, h, mat, seg = 16) { return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat); }
export function sphere(r, mat, ws = 16, hs = 12) { return new THREE.Mesh(new THREE.SphereGeometry(r, ws, hs), mat); }

// A radial gradient sprite texture, shared by glows / particles.
let _glowTex = null;
export function glowTexture() {
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

// Floating text label as a sprite.
export function textSprite(text, { color = '#8ff', size = 0.08, bg = 'rgba(0,20,30,0.6)' } = {}) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = 'bold 48px system-ui, sans-serif';
  const w = Math.ceil(g.measureText(text).width) + 40;
  c.width = w; c.height = 72;
  g.font = 'bold 48px system-ui, sans-serif';
  g.fillStyle = bg;
  g.fillRect(0, 0, w, 72);
  g.strokeStyle = color; g.lineWidth = 3; g.strokeRect(2, 2, w - 4, 68);
  g.fillStyle = color; g.textBaseline = 'middle';
  g.fillText(text, 20, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false }));
  s.scale.set(size * w / 72, size, 1);
  s.renderOrder = 50;
  return s;
}
