// The bridge: a flight console you can put in front of your couch, with a throttle lever,
// a flight joystick, toggle switches, push buttons, a keyboard, screens and ARIA the ship AI.
import * as THREE from 'three';
import { G, emit, on, std, glow, box, cyl, clamp, damp, textSprite } from './core.js';
import { S, stat, layout, save } from './state.js';
import { ship, bridgeFrame, engageWarp, system, galaxy } from './space.js';
import { enemies, firePhasers, fireTorpedo, cycleTarget, encounterActive } from './combat.js';
import { room, insideRoom, walls } from './room.js';
import { raySurfaces } from './input.js';
import { ops } from './ops.js';
import { screen as termScreen, keyboard } from './terminal.js';
import { CanvasPanel } from './ui-panel.js';
import { autoWindows } from './windows.js';
import { autoRack, rackOnWall, recallItems, Item } from './items.js';
import { setEngine } from './audio.js';

export const bridge = new THREE.Group();
const desk = new THREE.Group(); // tilted desk top; controls live here
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

// ---------- controls ----------
class Button {
  constructor({ parent, pos, color = 0xff3333, r = 0.028, label, onPress, onRelease, cover = false }) {
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    parent.add(this.group);
    const base = cyl(r + 0.008, r + 0.012, 0.012, std(0x222831), 20); base.position.y = 0.006; this.group.add(base);
    this.capMat = std(color, { emissive: color, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.4 });
    this.cap = cyl(r, r, 0.02, this.capMat, 20); this.cap.position.y = 0.02; this.group.add(this.cap);
    if (cover) { // hazard ring for important buttons
      const ring = new THREE.Mesh(new THREE.RingGeometry(r + 0.014, r + 0.028, 24), glow(0xffaa00)); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; this.group.add(ring);
    }
    if (label) { const s = textSprite(label, { size: 0.022, color: '#cfefff', bg: 'rgba(0,0,0,0.5)' }); s.position.set(0, 0.065, -0.02); s.material.depthTest = true; this.group.add(s); }
    this.cap.userData.control = this;
    this.anchor = this.cap;
    this.onPress = onPress; this.onRelease = onRelease;
    this.down = 0; this.poked = new Set(); this.r = r;
    G.interactables.push(this.cap);
    G.pokeables.push(this);
  }
  press() { this.down = 0.12; this.held = true; emit('sfx', 'click'); this.onPress?.(); }
  release() { this.held = false; this.onRelease?.(); }
  setHover(h) { this.capMat.emissiveIntensity = h ? 0.9 : 0.35; }
  poke(p, tip) {
    const c = this.cap.getWorldPosition(_v);
    const local = this.group.worldToLocal(_v2.copy(tip));
    const inside = Math.hypot(local.x, local.z) < this.r + 0.012 && local.y < 0.04 && local.y > -0.02;
    if (inside && !this.poked.has(p)) { this.poked.add(p); this.press(); p.haptic(0.6, 30); }
    else if (!inside && this.poked.has(p) && (local.y > 0.06 || Math.hypot(local.x, local.z) > this.r + 0.03)) { this.poked.delete(p); this.release(); }
    void c;
  }
  update(dt) { this.down = Math.max(0, this.down - dt); this.cap.position.y = this.held || this.down > 0 ? 0.012 : 0.02; }
}

class Switch {
  constructor({ parent, pos, key, label }) {
    this.key = key;
    this.group = new THREE.Group(); this.group.position.copy(pos); parent.add(this.group);
    const plate = box(0.05, 0.006, 0.07, std(0x1a1f26)); plate.position.y = 0.003; this.group.add(plate);
    this.led = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), glow(0x330000)); this.led.position.set(0, 0.008, -0.028); this.group.add(this.led);
    this.pivot = new THREE.Group(); this.pivot.position.y = 0.008; this.group.add(this.pivot);
    this.lever = box(0.012, 0.045, 0.012, std(0xd8dde3, { metalness: 0.9, roughness: 0.2 })); this.lever.position.y = 0.022; this.pivot.add(this.lever);
    const tipM = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), std(0xff4433)); tipM.position.y = 0.046; this.pivot.add(tipM);
    const hit = box(0.05, 0.06, 0.07, new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = 0.03; this.group.add(hit);
    hit.userData.control = this;
    this.anchor = hit;
    const s = textSprite(label, { size: 0.016, color: '#cfefff', bg: 'rgba(0,0,0,0.6)' }); s.position.set(0, 0.012, 0.05); s.material.depthTest = true; this.group.add(s);
    G.interactables.push(hit); G.pokeables.push(this);
    this.poked = new Set();
    this.angle = 0;
  }
  press() { S.toggles[this.key] = !S.toggles[this.key]; emit('sfx', 'switch'); emit('toggles'); }
  setHover() {}
  poke(p, tip) {
    const local = this.group.worldToLocal(_v2.copy(tip));
    const inside = Math.abs(local.x) < 0.025 && Math.abs(local.z) < 0.035 && local.y < 0.055 && local.y > 0;
    if (inside && !this.poked.has(p)) { this.poked.add(p); this.press(); p.haptic(0.7, 30); }
    else if (!inside && this.poked.has(p) && (local.y > 0.08 || Math.abs(local.x) > 0.04 || Math.abs(local.z) > 0.05)) this.poked.delete(p);
  }
  update(dt) {
    const on = !!S.toggles[this.key];
    this.angle = damp(this.angle, on ? -0.5 : 0.5, 20, dt);
    this.pivot.rotation.x = this.angle;
    this.led.material.color.setHex(on ? 0x33ff66 : 0x401010);
  }
}

class Lever { // throttle: slides along the desk's depth axis
  constructor({ parent, pos, onChange }) {
    this.group = new THREE.Group(); this.group.position.copy(pos); parent.add(this.group);
    const slot = box(0.03, 0.01, 0.26, std(0x111418)); slot.position.y = 0.005; this.group.add(slot);
    for (let i = 0; i <= 4; i++) { const t = box(0.05, 0.002, 0.003, glow(i === 0 ? 0xff5533 : 0x2fd6ff)); t.position.set(0.035, 0.011, 0.12 - i * 0.06); this.group.add(t); }
    this.handle = new THREE.Group(); this.group.add(this.handle);
    const stem = box(0.012, 0.08, 0.012, std(0x999fa6, { metalness: 0.9 })); stem.position.y = 0.04; this.handle.add(stem);
    this.knob = box(0.07, 0.04, 0.04, std(0x2fd6ff, { emissive: 0x115566 })); this.knob.position.y = 0.09; this.handle.add(this.knob);
    this.knob.userData.control = this;
    this.anchor = this.knob;
    this.draggable = true;
    this.value = 0;
    this.onChange = onChange;
    G.interactables.push(this.knob); G.pokeables.push(this);
    const s = textSprite('THROTTLE', { size: 0.02, color: '#cfefff', bg: 'rgba(0,0,0,0.6)' }); s.position.set(0, 0.03, 0.17); s.material.depthTest = true; this.group.add(s);
  }
  press(p) { this.start = this.value; this.startPos = p.gripPos(new THREE.Vector3()); emit('sfx', 'grab'); }
  drag(p) {
    const fwd = _v.set(0, 0, -1).transformDirection(this.group.matrixWorld);
    const d = p.gripPos(_v2).sub(this.startPos).dot(fwd);
    this.set(clamp(this.start + d / 0.22, 0, 1));
  }
  release() { emit('sfx', 'drop'); }
  setHover(h) { this.knob.material.emissiveIntensity = h ? 2 : 1; }
  set(v) { if (Math.abs(v - this.value) > 0.001) { this.value = v; this.onChange?.(v); } }
  update() { this.handle.position.z = 0.12 - this.value * 0.24; }
}

class Stick { // flight joystick: tilt to pitch/yaw, springs back to centre
  constructor({ parent, pos }) {
    this.group = new THREE.Group(); this.group.position.copy(pos); parent.add(this.group);
    const base = cyl(0.045, 0.055, 0.025, std(0x1a1f26), 20); base.position.y = 0.012; this.group.add(base);
    const boot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), std(0x111111, { roughness: 1 })); boot.position.y = 0.024; this.group.add(boot);
    this.pivot = new THREE.Group(); this.pivot.position.y = 0.03; this.group.add(this.pivot);
    const shaft = cyl(0.01, 0.012, 0.11, std(0x888f96, { metalness: 0.9 }), 10); shaft.position.y = 0.055; this.pivot.add(shaft);
    this.grip = cyl(0.022, 0.018, 0.1, std(0x23272d, { roughness: 0.9 }), 14); this.grip.position.y = 0.14; this.pivot.add(this.grip);
    const trig = box(0.016, 0.02, 0.012, std(0xff3333, { emissive: 0x551111 })); trig.position.set(0, 0.16, -0.022); this.pivot.add(trig);
    this.grip.userData.control = this;
    this.anchor = this.grip;
    this.draggable = true;
    this.x = 0; this.y = 0;
    G.interactables.push(this.grip); G.pokeables.push(this);
    const s = textSprite('FLIGHT', { size: 0.02, color: '#cfefff', bg: 'rgba(0,0,0,0.6)' }); s.position.set(0, 0.012, 0.075); s.material.depthTest = true; this.group.add(s);
  }
  press(p) { this.startPos = p.gripPos(new THREE.Vector3()); this.held = true; emit('sfx', 'grab'); }
  drag(p) {
    this.group.updateMatrixWorld();
    const right = _v.set(1, 0, 0).transformDirection(this.group.matrixWorld);
    const fwd = new THREE.Vector3(0, 0, -1).transformDirection(this.group.matrixWorld);
    const d = p.gripPos(_v2).sub(this.startPos);
    this.x = clamp(d.dot(right) / 0.07, -1, 1);
    this.y = clamp(d.dot(fwd) / 0.07, -1, 1);
  }
  release() { this.held = false; }
  setHover() {}
  update(dt) {
    if (!this.held) { this.x = damp(this.x, 0, 10, dt); this.y = damp(this.y, 0, 10, dt); }
    this.pivot.rotation.set(-this.y * 0.4, 0, -this.x * 0.4);
  }
}

// ---------- screens ----------
const radar = new CanvasPanel({
  width: 400, height: 400, interval: 0.1,
  draw(g, P) {
    g.fillStyle = '#00100a'; g.fillRect(0, 0, 400, 400);
    const cx = 200, cy = 210, R = 170, range = stat.radarRange;
    g.strokeStyle = 'rgba(64,255,144,0.35)'; g.lineWidth = 1.5;
    for (const f of [0.33, 0.66, 1]) { g.beginPath(); g.arc(cx, cy, R * f, 0, 7); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    const sweep = (G.time * 2) % (Math.PI * 2);
    g.fillStyle = 'rgba(64,255,144,0.12)'; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, sweep - 0.5, sweep); g.fill();
    const inv = ship.quat.clone().invert();
    const plot = (pos, color, size, label) => {
      const rel = _v.copy(pos).sub(ship.pos).applyQuaternion(inv);
      let x = rel.x / range, y = rel.z / range;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      const px = cx + x * R, py = cy + y * R;
      g.fillStyle = color;
      if (rel.y > 50) { g.beginPath(); g.moveTo(px, py - size - 2); g.lineTo(px - size, py + size); g.lineTo(px + size, py + size); g.fill(); }
      else if (rel.y < -50) { g.beginPath(); g.moveTo(px, py + size + 2); g.lineTo(px - size, py - size); g.lineTo(px + size, py - size); g.fill(); }
      else { g.beginPath(); g.arc(px, py, size, 0, 7); g.fill(); }
      if (label) { g.font = '14px system-ui'; g.fillText(label, px + size + 3, py + 4); }
      return [px, py];
    };
    if (system) {
      for (const p of system.planets) plot(p.position, '#4a90ff', 7, null);
      plot(system.station.position, '#40ff90', 6, 'STN');
      for (const a of system.asteroids) plot(a.position, '#8a7a6a', 2.5);
    }
    for (const e of enemies) plot(e.obj.position, e.type === 'shuttle' ? '#cc55ff' : '#ff4433', 5);
    if (G.target?.obj?.parent) {
      const [px, py] = plot(G.target.obj.position, '#ffd23f', 3);
      g.strokeStyle = '#ffd23f'; g.lineWidth = 2; g.strokeRect(px - 9, py - 9, 18, 18);
    }
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, cy - 9); g.lineTo(cx - 6, cy + 7); g.lineTo(cx + 6, cy + 7); g.fill();
    g.fillStyle = '#4f9'; g.font = 'bold 18px system-ui';
    g.fillText('TACTICAL', 12, 24);
    g.textAlign = 'right'; g.fillText(`${Math.round(ship.speed)} m/s`, 388, 24); g.textAlign = 'left';
    g.font = '14px system-ui'; g.fillText(`range ${(range / 1000).toFixed(1)} km`, 12, 392);
    void P;
  },
});

// ---------- console construction ----------
const controls = [];
let throttle, stick, boostBtn;
export let deskY = 0.68;

function buildConsole() {
  const bodyM = std(0x2a313a, { metalness: 0.7, roughness: 0.35 });
  const panelM = std(0x161b21, { metalness: 0.5, roughness: 0.6 });
  const trimM = glow(0x2fd6ff);
  // pedestal
  const ped = box(1.25, 1, 0.42, bodyM); ped.name = 'pedestal'; bridge.add(ped);
  const kick = box(1.3, 0.06, 0.46, trimM); kick.position.y = 0.03; bridge.add(kick);
  // desk top (tilted toward the player, who sits on the +Z side)
  bridge.add(desk);
  const top = box(1.55, 0.04, 0.56, panelM); top.position.y = -0.02; desk.add(top);
  const lip = box(1.55, 0.015, 0.02, trimM); lip.position.set(0, 0, 0.28); desk.add(lip);
  // wings, angled inward
  for (const sx of [-1, 1]) {
    const wing = new THREE.Group();
    wing.position.set(sx * 0.98, 0, -0.05);
    wing.rotation.y = -sx * 0.55;
    desk.add(wing);
    const wt = box(0.46, 0.04, 0.5, panelM); wt.position.y = -0.02; wing.add(wt);
    const wl = box(0.46, 0.015, 0.02, trimM); wl.position.set(0, 0, 0.25); wing.add(wl);
    const wped = box(0.4, 1, 0.36, bodyM); wped.name = 'pedestal'; wing.add(wped);
    // a screen on each wing
    const scr = (sx < 0 ? radar : termScreen).createMesh(sx < 0 ? 0.34 : 0.42);
    scr.position.set(0, 0.2, -0.16); scr.rotation.x = -0.35;
    wing.add(scr);
    const frame = box(sx < 0 ? 0.37 : 0.45, sx < 0 ? 0.37 : 0.29, 0.02, bodyM); frame.position.set(0, 0.2, -0.172); frame.rotation.x = -0.35; wing.add(frame);
    if (sx < 0) { G.trayAnchor = new THREE.Object3D(); G.trayAnchor.position.set(0.05, 0.02, 0.1); wing.add(G.trayAnchor); }
    else { G.ariaAnchor = new THREE.Object3D(); G.ariaAnchor.position.set(0.15, 0.0, 0.1); wing.add(G.ariaAnchor); }
  }
  // main screen on a stand
  const stand = box(0.08, 0.4, 0.05, bodyM); stand.position.set(0, 0.2, -0.39); desk.add(stand);
  const main = ops.createMesh(1.12);
  main.position.set(0, 0.52, -0.33); main.rotation.x = -0.12;
  desk.add(main);
  const bezel = box(1.16, 0.7, 0.03, bodyM); bezel.position.set(0, 0.52, -0.35); bezel.rotation.x = -0.12; desk.add(bezel);
  // keyboard
  const kb = keyboard.createMesh(0.5);
  kb.rotation.x = -Math.PI / 2;
  kb.position.set(0, 0.004, 0.135);
  desk.add(kb);
  // switches
  const sw = [['shields', 'SHIELDS'], ['weapons', 'WEAPONS'], ['blast', 'SHUTTERS'], ['redAlert', 'ALERT'], ['tractor', 'TRACTOR'], ['cloak', 'CLOAK'], ['lights', 'LIGHTS']];
  sw.forEach(([key, label], i) => controls.push(new Switch({ parent: desk, pos: new THREE.Vector3(-0.3 + i * 0.1, 0, -0.1), key, label })));
  // throttle + boost on the left
  throttle = new Lever({ parent: desk, pos: new THREE.Vector3(-0.57, 0, 0), onChange: (v) => { ship.throttle = v; if (ship.autopilot) { ship.autopilot = null; S.toggles.autopilot = false; } } });
  controls.push(throttle);
  boostBtn = new Button({ parent: desk, pos: new THREE.Vector3(-0.42, 0, 0.17), color: 0x33aaff, r: 0.024, label: 'BOOST' });
  controls.push(boostBtn);
  controls.push(new Button({ parent: desk, pos: new THREE.Vector3(-0.42, 0, 0.05), color: 0x40ff90, r: 0.02, label: 'STOP', onPress: () => { throttle.set(0); ship.autopilot = null; } }));
  // joystick + weapons on the right
  stick = new Stick({ parent: desk, pos: new THREE.Vector3(0.6, 0, 0.06) });
  controls.push(stick);
  controls.push(new Button({ parent: desk, pos: new THREE.Vector3(0.4, 0, 0.17), color: 0xff3322, label: 'PHASERS', onPress: firePhasers }));
  controls.push(new Button({ parent: desk, pos: new THREE.Vector3(0.4, 0, 0.06), color: 0xff2266, r: 0.024, label: 'TORPEDO', onPress: fireTorpedo }));
  controls.push(new Button({ parent: desk, pos: new THREE.Vector3(0.4, 0, -0.05), color: 0xffd23f, r: 0.02, label: 'TARGET', onPress: cycleTarget }));
  controls.push(new Button({ parent: desk, pos: new THREE.Vector3(0.6, 0, -0.17), color: 0xffffff, r: 0.034, label: 'WARP', cover: true, onPress: () => {
    if (G.selectedWarp != null) engageWarp(G.selectedWarp);
    else { emit('toast', 'Pick a destination on the NAV MAP tab first'); emit('say', 'Please select a destination on the navigation map.'); ops.dirty = true; }
  } }));
  setDeskHeight(layout().deskY || deskY);
  // seat marker on the floor where the captain sits
  const seat = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.32, 40), new THREE.MeshBasicMaterial({ color: 0x2fd6ff, transparent: true, opacity: 0.5, toneMapped: false }));
  seat.rotation.x = -Math.PI / 2; seat.position.set(0, 0.005, 0.85); seat.name = 'seatMarker';
  bridge.add(seat);
}

function setDeskHeight(y) {
  deskY = clamp(y, 0.5, 1.15);
  desk.position.set(0, deskY, 0);
  desk.rotation.x = 0.18; // the far edge sits higher, like a cockpit dash
  for (const c of bridge.children) if (c.name === 'pedestal') { c.scale.y = deskY - 0.02; c.position.y = (deskY - 0.02) / 2; }
  desk.traverse((c) => { if (c.name === 'pedestal') { c.scale.y = deskY; c.position.y = -deskY / 2 - 0.02; } });
  layout().deskY = deskY;
  updateSupports();
}

function updateSupports() {
  bridge.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(desk.children[0]);
  G.supports = G.supports.filter((s) => !s.bridge);
  b.bridge = true;
  G.supports.push(b);
}

// ---------- ARIA, the holographic ship AI ----------
let aria, ariaPulse = 0;
function buildAria() {
  aria = new THREE.Group();
  const m = new THREE.MeshBasicMaterial({ color: 0x55d6ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), m); head.position.y = 0.2; aria.add(head);
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.15, 16, 1, true), m); body.position.y = 0.11; body.rotation.x = Math.PI; aria.add(body);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.003, 6, 32), m); ring.rotation.x = Math.PI / 2; ring.position.y = 0.03; aria.add(ring);
  const base = cyl(0.05, 0.06, 0.015, std(0x1a1f26), 20); aria.add(base);
  const beamM = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.06, 0.2, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0x2fd6ff, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  beamM.position.y = 0.11; aria.add(beamM);
  aria.userData.mat = m;
  G.ariaAnchor.add(aria);
  const tag = textSprite('ARIA', { size: 0.02, color: '#8ff' }); tag.position.y = 0.26; aria.add(tag);
  on('say', () => (ariaPulse = 2.5));
}

// ---------- placement ----------
export function placeBridge(pos, yaw) {
  bridge.position.set(pos.x, room.floorY, pos.z);
  bridge.rotation.set(0, yaw, 0);
  bridge.updateMatrixWorld(true);
  bridgeFrame.position.set(pos.x, room.floorY + 1.2, pos.z);
  bridgeFrame.rotation.set(0, yaw, 0);
  bridgeFrame.updateMatrixWorld(true);
  layout().bridge = { x: pos.x, z: pos.z, yaw };
  updateSupports();
  save();
}

function findCouch() {
  const couches = room.furniture.filter((f) => f.label === 'couch');
  couches.sort((a, b) => b.size.x * b.size.z - a.size.x * a.size.z);
  return couches[0] || null;
}

export function linkToCouch(announce = true) {
  const c = findCouch();
  if (!c) { if (announce) emit('toast', 'No couch found in the room scan. Use Move Bridge Console instead.', 'warn'); return false; }
  // the couch faces the room centre; use the couch's own axes if we have its plane
  const toCenter = room.center.clone().sub(c.center); toCenter.y = 0;
  if (toCenter.lengthSq() < 0.01) toCenter.set(0, 0, -1);
  toCenter.normalize();
  let front = toCenter.clone(), depth = Math.min(c.size.x, c.size.z);
  if (c.mesh) {
    const ax = new THREE.Vector3(1, 0, 0).transformDirection(c.mesh.matrixWorld); ax.y = 0; ax.normalize();
    const az = new THREE.Vector3(0, 0, 1).transformDirection(c.mesh.matrixWorld); az.y = 0; az.normalize();
    const pickAx = Math.abs(ax.dot(toCenter)) > Math.abs(az.dot(toCenter)) ? ax : az;
    front = pickAx.clone().multiplyScalar(Math.sign(pickAx.dot(toCenter)) || 1);
    const bb = c.mesh.geometry.boundingBox || (c.mesh.geometry.computeBoundingBox(), c.mesh.geometry.boundingBox);
    depth = pickAx === ax ? bb.max.x - bb.min.x : bb.max.z - bb.min.z;
  }
  const pos = c.center.clone().addScaledVector(front, depth / 2 + 0.62);
  const yaw = Math.atan2(-front.x, -front.z); // bridge -Z (forward) points away from the couch
  placeBridge(pos, yaw);
  if (announce) { emit('toast', 'Bridge console linked to your couch. Have a seat, captain.'); emit('say', 'Console linked to your couch.'); }
  return true;
}

export function autoPlaceBridge() {
  const b = layout().bridge;
  if (b && insideRoom(b.x, b.z, 0.2)) { placeBridge(new THREE.Vector3(b.x, 0, b.z), b.yaw); return; }
  if (linkToCouch(false)) return;
  // otherwise put it in front of where the player is looking
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(G.headQuat); f.y = 0;
  if (f.lengthSq() < 0.01) f.set(0, 0, -1);
  f.normalize();
  const pos = G.head.clone().addScaledVector(f, 0.85);
  placeBridge(pos, Math.atan2(-f.x, -f.z));
}

// build tools
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffaa22, transparent: true, opacity: 0.3, depthWrite: false, toneMapped: false });
const ghost = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.7, 0.5).translate(0, 0.35, 0), ghostMat);
const ghostArrow = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 12).rotateX(-Math.PI / 2).translate(0, 0.72, -0.4), ghostMat);
ghost.add(ghostArrow);
ghost.visible = false;

function bridgeTool(pointer) {
  let pos = null, yaw = bridge.rotation.y;
  return {
    pointer, name: 'Move Bridge Console',
    aim(p) {
      const hit = raySurfaces(p, room.surfaces.filter((m) => ['floor', 'couch', 'table'].includes(m.userData.surface.kind)));
      ghost.visible = !!hit;
      if (Math.abs(p.axes[0]) > 0.3) yaw -= p.axes[0] * 0.04;
      if (G.wheel) { yaw -= G.wheel * 0.002; G.wheel = 0; }
      if (hit) {
        pos = hit.point.clone();
        // by default face away from the player so they stand/sit behind it
        if (!this.rotated && Math.abs(p.axes[0]) < 0.3) { const d = pos.clone().sub(G.head); yaw = Math.atan2(-d.x, -d.z); }
        if (Math.abs(p.axes[0]) > 0.3) this.rotated = true;
        ghost.position.set(pos.x, room.floorY, pos.z); ghost.rotation.set(0, yaw, 0);
      }
    },
    trigger() {
      if (!pos) return;
      placeBridge(pos, yaw);
      emit('sfx', 'teleport');
      emit('toast', 'Bridge console moved');
      G.activeTool = null; ghost.visible = false; emit('toolEnd');
    },
    cancel() { ghost.visible = false; G.activeTool = null; emit('toolEnd'); },
    end() { ghost.visible = false; },
  };
}

const rackGhost = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.05, 0.05), ghostMat);
rackGhost.visible = false;
function rackTool(pointer) {
  let hit = null;
  return {
    pointer, name: 'Move Armory',
    aim(p) {
      hit = raySurfaces(p, walls());
      rackGhost.visible = !!hit;
      if (hit) {
        const n = hit.object.userData.surface.normal.clone(); n.y = 0; n.normalize();
        rackGhost.position.copy(hit.point).addScaledVector(n, 0.04); rackGhost.position.y = room.floorY + 1.3;
        rackGhost.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      }
    },
    trigger() {
      if (!hit) return;
      rackOnWall(hit, 0); save();
      emit('sfx', 'teleport'); emit('toast', 'Armory moved');
      G.activeTool = null; rackGhost.visible = false; emit('toolEnd');
    },
    cancel() { rackGhost.visible = false; G.activeTool = null; emit('toolEnd'); },
    end() { rackGhost.visible = false; },
  };
}

export function initBridge(scene) {
  buildConsole();
  buildAria();
  scene.add(bridge, ghost, rackGhost);
  bridge.visible = false;
  G.actions = {
    bridgeTool, rackTool, recallItems,
    linkCouch: () => { if (linkToCouch()) { autoRack(bridge); } },
    deskHeight: (d) => setDeskHeight(deskY + d),
  };
  on('throttle', (v) => throttle.set(v));
  on('arrived', () => throttle.set(0.15));
  on('warpStart', () => throttle.set(0));
}

// After the room scan: place the console, windows, armory and starting items.
export function setupDeck() {
  autoPlaceBridge();
  bridge.visible = true;
  autoWindows(bridge);
  autoRack(bridge);
  emit('deckReady');
  if (!G.mugGiven) {
    G.mugGiven = true;
    const mug = new Item('mug');
    G.trayAnchor.getWorldPosition(mug.root.position);
    mug.root.position.x += 0.12;
    mug.resting = false;
  }
}

export function updateBridge(dt) {
  for (const c of controls) c.update(dt);
  // flight inputs: console joystick + controller thumbsticks + keyboard
  const k = G.keys || {};
  const kb = (a, b) => (k[a] ? 1 : 0) - (k[b] ? 1 : 0);
  const st = G.stick;
  ship.input.pitch = clamp(-stick.y + st.ry + kb('ArrowDown', 'ArrowUp'), -1, 1);
  ship.input.yaw = clamp(-stick.x - st.rx + kb('ArrowLeft', 'ArrowRight'), -1, 1);
  ship.input.roll = clamp(-st.lx + kb('KeyZ', 'KeyX'), -1, 1);
  const thr = -st.ly + kb('KeyR', 'KeyF');
  if (Math.abs(thr) > 0.01) { throttle.set(clamp(throttle.value + thr * dt * 0.5, 0, 1)); }
  if (ship.autopilot) throttle.value = ship.throttle; else ship.throttle = throttle.value;
  ship.boost = !ship.autopilot ? boostBtn.held || st.boost || !!k.ShiftLeft || !!k.ShiftRight : ship.boost;
  setEngine(ship.throttle, ship.boost);
  // ARIA idle animation
  if (aria) {
    aria.rotation.y += dt * 0.6;
    aria.position.y = 0.02 + Math.sin(G.time * 2) * 0.005;
    ariaPulse = Math.max(0, ariaPulse - dt);
    aria.userData.mat.opacity = 0.45 + (ariaPulse > 0 ? 0.3 * Math.abs(Math.sin(G.time * 18)) : 0.05 * Math.sin(G.time * 3));
    aria.userData.mat.color.setHex(S.toggles.redAlert ? 0xff6655 : 0x55d6ff);
  }
  // panels
  ops.update(dt); radar.update(dt); termScreen.update(dt); keyboard.update(dt);
  void galaxy; void encounterActive;
}
