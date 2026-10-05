// Windows ("viewports") cut into the walls. Each window writes 1 into the stencil buffer;
// the universe is only drawn where the stencil is 1, so you see space through your walls.
import * as THREE from 'three';
import { G, emit, std, glow, clamp } from './core.js';
import { S, layout, save } from './state.js';
import { room, walls } from './room.js';
import { raySurfaces } from './input.js';

export const windowsGroup = new THREE.Group();
const list = []; // { rec, group, stencil, shutter }

const stencilMat = new THREE.MeshBasicMaterial({
  colorWrite: false, depthWrite: false, side: THREE.DoubleSide,
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp,
});
const frameMat = std(0x8a96a3, { metalness: 0.8, roughness: 0.35 });
const trimMat = glow(0x2fd6ff);
const shutterMat = std(0x4a525b, { metalness: 0.7, roughness: 0.5, side: THREE.DoubleSide });
const glassMat = new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.025, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffaa22, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });

export const SHAPES = {
  rect: { name: 'Window', w: 1.2, h: 0.8 },
  round: { name: 'Porthole', w: 0.8, h: 0.8 },
  panorama: { name: 'Panorama', w: 2.4, h: 1.0 },
  hex: { name: 'Hex Port', w: 0.9, h: 0.9 },
};

function shapeGeo(shape, w, h) {
  if (shape === 'round') return new THREE.CircleGeometry(w / 2, 48);
  if (shape === 'hex') return new THREE.CircleGeometry(w / 2, 6);
  if (shape === 'panorama') {
    const s = new THREE.Shape();
    const r = h * 0.3;
    s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2);
    s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    return new THREE.ShapeGeometry(s, 8);
  }
  return new THREE.PlaneGeometry(w, h);
}

function frameGeo(shape, w, h, t = 0.07) {
  if (shape === 'round' || shape === 'hex') {
    const seg = shape === 'hex' ? 6 : 48;
    return new THREE.RingGeometry(w / 2, w / 2 + t, seg);
  }
  const s = new THREE.Shape();
  s.moveTo(-w / 2 - t, -h / 2 - t); s.lineTo(w / 2 + t, -h / 2 - t); s.lineTo(w / 2 + t, h / 2 + t); s.lineTo(-w / 2 - t, h / 2 + t);
  const hole = new THREE.Path();
  hole.moveTo(-w / 2, -h / 2); hole.lineTo(-w / 2, h / 2); hole.lineTo(w / 2, h / 2); hole.lineTo(w / 2, -h / 2);
  s.holes.push(hole);
  return new THREE.ShapeGeometry(s);
}

function buildWindow(rec) {
  const g = new THREE.Group();
  g.position.fromArray(rec.pos);
  g.quaternion.fromArray(rec.quat);
  const { w, h, shape } = rec;
  const stencil = new THREE.Mesh(shapeGeo(shape, w, h), stencilMat);
  stencil.renderOrder = -10;
  stencil.position.z = 0.004;
  g.add(stencil);
  const frame = new THREE.Mesh(frameGeo(shape, w, h), frameMat);
  frame.position.z = 0.01;
  g.add(frame);
  const trim = new THREE.Mesh(frameGeo(shape, w + 0.025, h + 0.025, 0.012), trimMat);
  trim.position.z = 0.012;
  g.add(trim);
  const glass = new THREE.Mesh(shapeGeo(shape, w, h), glassMat);
  glass.position.z = 0.006;
  g.add(glass);
  // blast shutter: two halves that slide shut
  const shutter = new THREE.Group();
  const halves = [];
  for (const sx of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w / 2, h), shutterMat);
    m.position.set(sx * w / 4, 0, 0.008);
    m.userData.sx = sx;
    shutter.add(m); halves.push(m);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.03, h * 0.9), glow(0xffaa00));
    stripe.position.set(-sx * (w / 4 - 0.03), 0, 0.001);
    m.add(stripe);
  }
  // shutters are clipped to the window by drawing them only where the stencil is 1
  shutterMat.stencilWrite = true; shutterMat.stencilRef = 1; shutterMat.stencilFunc = THREE.EqualStencilFunc;
  g.add(shutter);
  windowsGroup.add(g);
  const entry = { rec, group: g, stencil, shutter, halves, close: S.toggles.blast ? 1 : 0 };
  stencil.userData.windowEntry = entry;
  list.push(entry);
  return entry;
}

export function loadWindows() {
  for (const e of list) windowsGroup.remove(e.group);
  list.length = 0;
  const L = layout();
  // re-snap saved windows onto the scanned walls (the room origin may move between sessions)
  const kept = [];
  for (const rec of L.windows) {
    const pos = new THREE.Vector3().fromArray(rec.pos);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(rec.quat));
    const p = { origin: pos.clone().addScaledVector(n, 0.4), dir: n.clone().negate() };
    const hit = raySurfaces(p, walls());
    if (hit && hit.distance < 0.9) {
      const r = { ...rec, ...poseOnWall(hit) };
      r.pos[1] = rec.pos[1];
      kept.push(r);
    }
  }
  L.windows = kept;
  for (const rec of kept) buildWindow(rec);
}

function poseOnWall(hit) {
  const n = hit.object.userData.surface.normal.clone();
  n.y = 0; n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const p = hit.point.clone().addScaledVector(n, 0.005);
  return { pos: p.toArray(), quat: q.toArray() };
}

export function addWindow(hit, shape, w, h) {
  const pose = poseOnWall(hit);
  const minY = room.floorY + h / 2 + 0.15;
  pose.pos[1] = clamp(pose.pos[1], minY, room.floorY + room.height - h / 2 - 0.1);
  const rec = { ...pose, w, h, shape };
  layout().windows.push(rec);
  buildWindow(rec);
  save();
  emit('sfx', 'teleport');
  return rec;
}

export function removeWindow(entry) {
  windowsGroup.remove(entry.group);
  list.splice(list.indexOf(entry), 1);
  const L = layout();
  L.windows.splice(L.windows.indexOf(entry.rec), 1);
  save();
  emit('sfx', 'drop');
}

export function windowCount() { return list.length; }

// Default windows: a big panorama in front of the bridge and portholes on the side walls.
export function autoWindows(bridgeObj) {
  if (layout().windows.length) return;
  const origin = bridgeObj.getWorldPosition(new THREE.Vector3()).setY(room.floorY + 1.2);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(bridgeObj.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(bridgeObj.quaternion);
  const tries = [
    [fwd, 'panorama', 2.4, 1.1],
    [right, 'round', 0.9, 0.9],
    [right.clone().negate(), 'round', 0.9, 0.9],
  ];
  for (const [dir, shape, w, h] of tries) {
    const hit = raySurfaces({ origin, dir }, walls());
    if (!hit) continue;
    const sz = hit.object.userData.surface.size;
    const wallW = Math.max(sz.x, sz.z);
    addWindow(hit, shape, Math.min(w, wallW * 0.8), Math.min(h, room.height * 0.5));
  }
}

export function updateWindows(dt) {
  const target = S.toggles.blast ? 1 : 0;
  for (const e of list) {
    e.close += clamp(target - e.close, -dt * 1.5, dt * 1.5);
    e.shutter.visible = e.close > 0.001;
    for (const m of e.halves) {
      const sx = m.userData.sx;
      m.position.x = sx * (e.rec.w / 4 + (1 - e.close) * e.rec.w / 2);
    }
  }
}

// ---------- build tools ----------
const ghost = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ghostMat);
ghost.visible = false;
ghost.renderOrder = 45;
windowsGroup.add(ghost);

export function windowTool(pointer, shape) {
  const def = SHAPES[shape];
  let w = def.w, h = def.h, hit = null;
  return {
    pointer, name: `Place ${def.name}`,
    aim(p) {
      hit = raySurfaces(p, walls());
      ghost.visible = !!hit;
      const ax = p.axes[1] || 0;
      if (Math.abs(ax) > 0.2) { const k = 1 - ax * 0.02; w = clamp(w * k, 0.3, 4); h = clamp(h * k, 0.3, 2.2); }
      if (G.wheel) { const k = 1 - G.wheel * 0.001; w = clamp(w * k, 0.3, 4); h = clamp(h * k, 0.3, 2.2); G.wheel = 0; }
      if (hit) {
        const pose = poseOnWall(hit);
        ghost.position.fromArray(pose.pos);
        ghost.quaternion.fromArray(pose.quat);
        ghost.position.addScaledVector(new THREE.Vector3(0, 0, 1).applyQuaternion(ghost.quaternion), 0.02);
        ghost.geometry.dispose();
        ghost.geometry = shapeGeo(shape, w, h);
      }
    },
    trigger() {
      if (!hit) { emit('toast', 'Point at a wall to place a window'); emit('sfx', 'deny'); return; }
      addWindow(hit, shape, w, h);
      emit('toast', `${def.name} installed (${list.length} total)`);
    },
    cancel() { ghost.visible = false; G.activeTool = null; emit('toolEnd'); },
    end() { ghost.visible = false; },
  };
}

const _ray = new THREE.Raycaster();
export function removeTool(pointer) {
  let target = null;
  return {
    pointer, name: 'Remove Window',
    aim(p) {
      _ray.set(p.origin, p.dir);
  _ray.camera = G.camera;
      const hits = _ray.intersectObjects(list.map((e) => e.stencil), false);
      const t = hits[0]?.object.userData.windowEntry || null;
      if (target && target !== t) target.group.children[2].material = trimMat;
      target = t;
      if (target) target.group.children[2].material = ghostMat;
    },
    trigger() { if (target) { removeWindow(target); target = null; } },
    cancel() { if (target) target.group.children[2].material = trimMat; G.activeTool = null; emit('toolEnd'); },
    end() { if (target) target.group.children[2].material = trimMat; },
  };
}
