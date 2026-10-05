// Unified input: XR controllers, tracked hands and desktop mouse/keyboard all become
// "pointers" with a ray, a grip pose, a fingertip and trigger/squeeze buttons.
// This module also runs the interaction rules (hover, click, poke, grab, drag).
import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { G, emit, findOwner } from './core.js';

const _ray = new THREE.Raycaster();
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

export class Pointer {
  constructor(hand) {
    this.hand = hand; // 'left' | 'right' | 'desktop'
    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.rayQuat = new THREE.Quaternion();
    this.gripObj = new THREE.Object3D(); // world pose where held items attach
    this.tip = new THREE.Vector3();
    this.connected = hand === 'desktop';
    this.isHand = false;
    this.trigger = false; this.squeeze = false;
    this.prev = { trigger: false, squeeze: false, a: false, b: false, stick: false };
    this.btn = { a: false, b: false, stick: false };
    this.axes = [0, 0];
    this.held = null; this.drag = null; this.pressing = null;
    this.hover = null;
    this.touching = new Set();
    this.inputSource = null;
    this.velocity = new THREE.Vector3();
    this._last = new THREE.Vector3();
    this.virt = new THREE.Vector3(); // desktop: virtual hand offset while dragging
  }
  pressed(k) { return k === 'trigger' || k === 'squeeze' ? this[k] && !this.prev[k] : this.btn[k] && !this.prev[k]; }
  released(k) { return k === 'trigger' || k === 'squeeze' ? !this[k] && this.prev[k] : !this.btn[k] && this.prev[k]; }
  gripPos(out = new THREE.Vector3()) { return this.gripObj.getWorldPosition(out).add(this.virt); }
  haptic(intensity = 0.4, ms = 40) {
    const h = this.inputSource?.gamepad?.hapticActuators?.[0];
    try { h?.pulse?.(intensity, ms); } catch (e) { /* ignore */ }
  }
}

export const pointers = { left: new Pointer('left'), right: new Pointer('right'), desktop: new Pointer('desktop') };
G.pointers = pointers;
G.stick = { lx: 0, ly: 0, rx: 0, ry: 0, boost: false };

let renderer, scene, camera;
const xr = []; // {controller, grip, hand, pointer, line, reticle}

function makeRay() {
  const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x2fd6ff, transparent: true, opacity: 0.7, toneMapped: false }));
  line.renderOrder = 40;
  const reticle = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.011, 20), new THREE.MeshBasicMaterial({ color: 0x9ff, depthTest: false, transparent: true, toneMapped: false }));
  reticle.renderOrder = 60;
  return { line, reticle };
}

export function initInput(_renderer, _scene, _camera) {
  renderer = _renderer; scene = _scene; camera = _camera;
  const cmf = new XRControllerModelFactory();
  const hmf = new XRHandModelFactory();
  for (let i = 0; i < 2; i++) {
    const controller = renderer.xr.getController(i);
    const grip = renderer.xr.getControllerGrip(i);
    const hand = renderer.xr.getHand(i);
    grip.add(cmf.createControllerModel(grip));
    hand.add(hmf.createHandModel(hand, 'mesh'));
    scene.add(controller, grip, hand);
    const entry = { controller, grip, hand, pointer: null, ...makeRay() };
    scene.add(entry.line, entry.reticle);
    entry.line.visible = entry.reticle.visible = false;
    xr.push(entry);
    controller.addEventListener('connected', (e) => {
      const src = e.data;
      const p = pointers[src.handedness === 'left' ? 'left' : 'right'];
      p.connected = true; p.inputSource = src; p.isHand = !!src.hand;
      p.entry = entry; entry.pointer = p;
      grip.add(p.gripObj);
      // items are held slightly forward of the controller grip
      p.gripObj.position.set(0, 0, 0);
    });
    controller.addEventListener('disconnected', () => {
      if (entry.pointer) { entry.pointer.connected = false; entry.pointer.trigger = entry.pointer.squeeze = false; }
      entry.pointer = null;
    });
    controller.addEventListener('selectstart', () => { if (entry.pointer) entry.pointer.trigger = true; });
    controller.addEventListener('selectend', () => { if (entry.pointer) entry.pointer.trigger = false; });
    controller.addEventListener('squeezestart', () => { if (entry.pointer) entry.pointer.squeeze = true; });
    controller.addEventListener('squeezeend', () => { if (entry.pointer) entry.pointer.squeeze = false; });
  }
  // desktop pointer: a virtual hand attached to the camera
  const d = pointers.desktop;
  d.gripObj.position.set(0.22, -0.24, -0.42);
  camera.add(d.gripObj);
  d.entry = makeRay();
  d.entry.line.visible = false;
  scene.add(d.entry.reticle);
}

function isVisible(o) {
  while (o) { if (!o.visible) return false; o = o.parent; }
  return true;
}

// Returns {object, point, distance, uv, kind, owner} for the closest interactable along the pointer ray.
export function castPointer(p, maxDist = 30) {
  _ray.set(p.origin, p.dir);
  _ray.camera = G.camera;
  _ray.far = maxDist;
  const hits = _ray.intersectObjects(G.interactables, true);
  for (const h of hits) {
    if (!isVisible(h.object)) continue;
    if (h.object.userData.noRay) continue;
    const panel = findOwner(h.object, 'panel');
    if (panel) return { ...h, kind: 'panel', owner: panel };
    const control = findOwner(h.object, 'control');
    if (control) return { ...h, kind: 'control', owner: control };
    const item = findOwner(h.object, 'item');
    if (item) { if (item.holder) continue; return { ...h, kind: 'item', owner: item }; }
  }
  return null;
}

function castTargets(p) {
  _ray.set(p.origin, p.dir);
  _ray.camera = G.camera;
  _ray.far = 20000;
  const hits = _ray.intersectObjects(G.spaceTargets, true);
  for (const h of hits) {
    if (!isVisible(h.object)) continue;
    const t = findOwner(h.object, 'target');
    if (t) return { ...h, kind: 'target', owner: t };
  }
  return null;
}

export function raySurfaces(p, objects) {
  _ray.set(p.origin, p.dir);
  _ray.camera = G.camera;
  _ray.far = 30;
  return _ray.intersectObjects(objects, false)[0] || null;
}

function readPose(entry, p, dt) {
  const c = entry.controller;
  c.updateMatrixWorld(true);
  p.origin.setFromMatrixPosition(c.matrixWorld);
  p.rayQuat.setFromRotationMatrix(_m.extractRotation(c.matrixWorld));
  p.dir.set(0, 0, -1).applyQuaternion(p.rayQuat).normalize();
  // fingertip: index tip for tracked hands, a point just ahead of the controller otherwise
  const tipJoint = entry.hand.joints?.['index-finger-tip'];
  if (p.isHand && tipJoint && tipJoint.visible) tipJoint.getWorldPosition(p.tip);
  else {
    entry.grip.updateMatrixWorld(true);
    p.tip.set(0, -0.01, -0.07).applyMatrix4(entry.grip.matrixWorld);
  }
  const gp = p.gripObj.getWorldPosition(_v);
  if (dt > 0) p.velocity.copy(gp).sub(p._last).divideScalar(dt);
  p._last.copy(gp);
  const gpad = p.inputSource?.gamepad;
  if (gpad) {
    const b = gpad.buttons;
    p.btn.a = !!b[4]?.pressed; p.btn.b = !!b[5]?.pressed; p.btn.stick = !!b[3]?.pressed;
    const ax = gpad.axes;
    p.axes[0] = ax.length >= 4 ? ax[2] : ax[0] || 0;
    p.axes[1] = ax.length >= 4 ? ax[3] : ax[1] || 0;
  }
}

function updateDesktopPose(p, dt) {
  camera.updateMatrixWorld(true);
  p.origin.setFromMatrixPosition(camera.matrixWorld);
  camera.getWorldDirection(p.dir);
  camera.getWorldQuaternion(p.rayQuat);
  const gp = p.gripPos(_v);
  if (dt > 0) p.velocity.copy(gp).sub(p._last).divideScalar(dt);
  p._last.copy(gp);
  p.tip.copy(gp);
}

function setRayVisual(entry, p, len, color, show) {
  if (!entry.line) return;
  entry.line.visible = show;
  if (show) {
    entry.line.position.copy(p.origin);
    entry.line.quaternion.setFromUnitVectors(_v.set(0, 0, -1), p.dir);
    entry.line.scale.set(1, 1, len);
    entry.line.material.color.setHex(color);
  }
}

function handlePointer(p, dt) {
  const entry = p.entry;
  const isDesk = p.hand === 'desktop';

  // ---- dragging a lever/joystick ----
  if (p.drag) {
    p.drag.drag(p, dt);
    const stillHeld = p.dragBy === 'squeeze' ? p.squeeze : p.trigger;
    if (!stillHeld) { p.drag.release(p); p.drag = null; p.virt.set(0, 0, 0); }
    if (entry.reticle) entry.reticle.visible = false;
    setRayVisual(entry, p, 0, 0, false);
    return;
  }

  // ---- holding an item ----
  if (p.held) {
    p.held.use(p, dt);
    if (p.pressed('squeeze')) { p.held.drop(p); p.held = null; }
    if (entry.reticle) entry.reticle.visible = false;
    setRayVisual(entry, p, 0, 0, false);
    return;
  }

  // ---- build tool (placing windows, moving the bridge...) ----
  if (G.activeTool && G.activeTool.pointer === p) {
    const hitUI = castPointer(p);
    if (!hitUI || hitUI.kind !== 'panel') {
      for (const m of G.panels || []) if (m.hoverPointer === p) m.hover(null);
      G.activeTool.aim(p, dt);
      if (entry.reticle) entry.reticle.visible = false;
      setRayVisual(entry, p, 6, 0xffaa22, !isDesk);
      if (p.pressed('trigger')) G.activeTool.trigger(p);
      if (p.pressed('squeeze') || p.pressed('b')) G.activeTool.cancel?.(p);
      return;
    }
  }

  // ---- pointing ----
  const hit = castPointer(p);
  const tgt = hit ? null : castTargets(p);
  const h = hit || tgt;
  if (p.hover && p.hover.kind === 'panel' && (!h || h.owner !== p.hover.owner)) p.hover.owner.hover(null);
  if (p.hover && p.hover.kind === 'control' && (!h || h.owner !== p.hover.owner)) p.hover.owner.setHover?.(false);
  p.hover = h;
  if (h?.kind === 'panel') { h.owner.hover(h.uv); h.owner.hoverPointer = p; }
  if (h?.kind === 'control') h.owner.setHover?.(true);

  const len = h ? Math.min(h.distance, 8) : 5;
  const color = h ? (h.kind === 'target' ? 0xff5040 : 0x9fffb0) : 0x2fd6ff;
  setRayVisual(entry, p, len, color, !isDesk && p.connected && !(p.isHand && G.mode === 'ar' && !h));
  if (entry.reticle) {
    entry.reticle.visible = !!h && h.kind !== 'target' && h.distance < 8;
    if (entry.reticle.visible) {
      entry.reticle.position.copy(h.point);
      entry.reticle.quaternion.copy(G.headQuat);
      entry.reticle.material.color.setHex(color);
    }
  }

  if (p.pressed('trigger')) {
    if (h?.kind === 'panel') { G.clickPointer = p; h.owner.click(h.uv); p.haptic(0.3, 20); }
    else if (h?.kind === 'control') {
      h.owner.press(p, h);
      p.haptic(0.5, 30);
      if (h.owner.draggable) { p.drag = h.owner; p.dragBy = 'trigger'; }
      else p.pressing = h.owner;
    } else if (h?.kind === 'item') grab(p, h.owner);
    else if (h?.kind === 'target') { emit('target', h.owner); p.haptic(0.3, 30); }
  }
  if (p.released('trigger') && p.pressing) { p.pressing.release?.(p); p.pressing = null; }

  if (p.pressed('squeeze')) {
    // nearest item or lever within reach, else whatever the ray points at
    const gp = p.gripPos(new THREE.Vector3());
    let best = null, bd = isDesk ? 0 : 0.2;
    for (const it of G.items || []) {
      if (it.holder || !isVisible(it.root)) continue;
      const d = it.root.getWorldPosition(_v).distanceTo(gp);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) grab(p, best);
    else {
      let ctl = null;
      for (const c of G.pokeables) if (c.draggable && c.anchor && c.anchor.getWorldPosition(_v).distanceTo(gp) < 0.12) ctl = c;
      if (!ctl && h?.kind === 'control' && h.owner.draggable) ctl = h.owner;
      if (ctl) { ctl.press(p, h); p.drag = ctl; p.dragBy = 'squeeze'; p.haptic(0.5, 30); }
      else if (h?.kind === 'item' && h.distance < 8) grab(p, h.owner);
    }
  }

  // ---- poking with fingertip / controller tip ----
  if (!isDesk && p.connected) poke(p);
}

function grab(p, item) {
  if (item.holder) item.holder.held = null;
  p.held = item;
  item.grab(p);
  emit('sfx', 'grab');
  p.haptic(0.6, 40);
}

const _local = new THREE.Vector3();
function poke(p) {
  for (const c of G.pokeables) if (c.poke) c.poke(p, p.tip);
  for (const panel of G.panels || []) {
    if (!panel.pokeable) continue;
    for (const mesh of panel.meshes) {
      if (!isVisible(mesh)) continue;
      mesh.updateMatrixWorld();
      _local.copy(p.tip).applyMatrix4(_m.copy(mesh.matrixWorld).invert());
      const W = mesh.userData.worldW / 2, H = mesh.userData.worldH / 2;
      const inside = Math.abs(_local.x) <= W && Math.abs(_local.y) <= H;
      const touching = p.touching.has(mesh);
      if (!touching && inside && _local.z < 0.012 && _local.z > -0.04) {
        p.touching.add(mesh);
        const uv = { x: (_local.x + W) / (2 * W), y: (_local.y + H) / (2 * H) };
        G.clickPointer = p;
        if (panel.click(uv)) p.haptic(0.4, 25);
      } else if (touching && (!inside || _local.z > 0.03 || _local.z < -0.08)) p.touching.delete(mesh);
    }
  }
}

export function updateInput(dt) {
  if (G.mode !== 'desktop') {
    for (const e of xr) if (e.pointer) readPose(e, e.pointer, dt);
    const L = pointers.left, R = pointers.right;
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    G.stick.lx = dz(L.axes[0]); G.stick.ly = dz(L.axes[1]);
    G.stick.rx = dz(R.axes[0]); G.stick.ry = dz(R.axes[1]);
    G.stick.boost = R.btn.stick || L.btn.stick;
    if (L.pressed('b')) emit('tablet');
    if (L.pressed('a')) emit('nextTarget');
    if (R.pressed('a') && !R.held && !(G.activeTool && G.activeTool.pointer === R)) emit('firePhasers');
    if (R.pressed('b') && !R.held && !(G.activeTool && G.activeTool.pointer === R)) emit('fireTorpedo');
    for (const p of [L, R]) if (p.connected) handlePointer(p, dt);
  } else {
    const p = pointers.desktop;
    updateDesktopPose(p, dt);
    handlePointer(p, dt);
  }
  for (const p of Object.values(pointers)) {
    p.prev.trigger = p.trigger; p.prev.squeeze = p.squeeze;
    p.prev.a = p.btn.a; p.prev.b = p.btn.b; p.prev.stick = p.btn.stick;
  }
}

export function hideXRPointers() {
  for (const e of xr) { e.line.visible = false; e.reticle.visible = false; }
}
