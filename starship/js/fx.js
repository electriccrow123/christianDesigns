// Visual effects: particle bursts, flashes, beams, the damage vignette and the in-world toast.
import * as THREE from 'three';
import { G, on, spaceMat, glowTexture } from './core.js';
import { CanvasPanel, wrap } from './ui-panel.js';

const live = [];
let scene;

export function initFx(_scene) { scene = _scene; }

function mat(color, space, additive = true) {
  const m = new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false });
  return space ? spaceMat(m) : m;
}

export function flash(pos, { color = 0xffaa55, scale = 1, life = 0.4, parent = scene, space = false } = {}) {
  const s = new THREE.Sprite(mat(color, space));
  s.position.copy(pos);
  s.scale.setScalar(scale * 0.2);
  parent.add(s);
  live.push({ o: s, t: 0, life, update(e, k) { s.scale.setScalar(scale * (0.3 + k * 0.9)); s.material.opacity = 1 - k; } });
  return s;
}

export function burst(pos, { color = 0xffaa55, count = 24, speed = 3, size = 0.05, life = 0.8, parent = scene, space = false, gravity = 0 } = {}) {
  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3), v = [];
  for (let i = 0; i < count; i++) {
    p.set([pos.x, pos.y, pos.z], i * 3);
    v.push(new THREE.Vector3().randomDirection().multiplyScalar(speed * (0.3 + Math.random() * 0.7)));
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  let m = new THREE.PointsMaterial({ color, size, map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  if (space) m = spaceMat(m);
  const pts = new THREE.Points(geo, m);
  pts.frustumCulled = false;
  parent.add(pts);
  live.push({
    o: pts, t: 0, life,
    update(e, k, dt) {
      const a = geo.attributes.position;
      for (let i = 0; i < count; i++) {
        v[i].y -= gravity * dt;
        a.setXYZ(i, a.getX(i) + v[i].x * dt, a.getY(i) + v[i].y * dt, a.getZ(i) + v[i].z * dt);
      }
      a.needsUpdate = true;
      m.opacity = 1 - k;
    },
  });
}

const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
export function beam(a, b, { color = 0xff4422, width = 0.5, life = 0.3, parent = scene, space = false } = {}) {
  let m = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  if (space) m = spaceMat(m);
  const mesh = new THREE.Mesh(beamGeo, m);
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
  mesh.scale.set(width, width, a.distanceTo(b));
  parent.add(mesh);
  live.push({ o: mesh, t: 0, life, update(e, k) { m.opacity = 1 - k; mesh.scale.x = mesh.scale.y = width * (1 - k * 0.5); } });
  return mesh;
}

export function updateFx(dt) {
  for (let i = live.length - 1; i >= 0; i--) {
    const e = live[i];
    e.t += dt;
    const k = Math.min(1, e.t / e.life);
    e.update(e, k, dt);
    if (k >= 1) {
      e.o.parent?.remove(e.o);
      if (e.o.geometry !== beamGeo) e.o.geometry?.dispose?.();
      e.o.material?.dispose?.();
      live.splice(i, 1);
    }
  }
  updateVignette(dt);
  updateToast(dt);
}

// ---------- damage vignette (sphere around the head) ----------
let vignette, vigLevel = 0, vigColor = new THREE.Color(1, 0, 0);
export function initVignette(camera) {
  vignette = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }));
  vignette.renderOrder = 100;
  vignette.visible = false;
  camera.add(vignette);
}
export function hurtFlash(amount = 0.5, color = 0xff0000) {
  vigLevel = Math.min(0.6, vigLevel + amount);
  vigColor.setHex(color);
}
function updateVignette(dt) {
  if (!vignette) return;
  vigLevel = Math.max(0, vigLevel - dt * 1.2);
  vignette.visible = vigLevel > 0.01;
  vignette.material.opacity = vigLevel;
  vignette.material.color.copy(vigColor);
}

// ---------- in-world toast: a panel that floats in front of you ----------
const toastQueue = [];
let toastCur = null, toastT = 0, toastMesh;
const toastPanel = new CanvasPanel({
  width: 1024, height: 150, interval: 0,
  draw(g, P) {
    g.clearRect(0, 0, P.w, P.h);
    if (!toastCur) return;
    const warn = toastCur.kind === 'warn' || toastCur.kind === 'alert';
    g.fillStyle = warn ? 'rgba(60,8,8,0.88)' : 'rgba(2,20,32,0.88)';
    g.beginPath(); g.roundRect?.(4, 4, P.w - 8, P.h - 8, 20); g.fill();
    g.strokeStyle = warn ? '#ff5544' : '#2fd6ff'; g.lineWidth = 4; g.stroke();
    g.font = 'bold 38px system-ui, sans-serif';
    const lines = wrap(g, toastCur.text, P.w - 60).slice(0, 2);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, P.w / 2, P.h / 2 + (i - (lines.length - 1) / 2) * 46));
  },
});
export function initToast(scene) {
  toastMesh = toastPanel.createMesh(0.7);
  toastMesh.userData.noRay = true;
  G.interactables.splice(G.interactables.indexOf(toastMesh), 1);
  toastMesh.material.depthTest = false;
  toastMesh.renderOrder = 90;
  toastMesh.visible = false;
  scene.add(toastMesh);
}
const _f = new THREE.Vector3(), _t = new THREE.Vector3();
function updateToast(dt) {
  if (!toastMesh) return;
  if (!toastCur && toastQueue.length) {
    toastCur = toastQueue.shift(); toastT = 0; toastPanel.dirty = true;
    const dom = document.getElementById('toast');
    if (dom && G.mode === 'desktop') { dom.textContent = toastCur.text; dom.className = 'show ' + (toastCur.kind || ''); }
  }
  if (toastCur) {
    toastT += dt;
    if (toastT > (toastQueue.length ? 2.2 : 3.8)) {
      toastCur = null; toastPanel.dirty = true;
      const dom = document.getElementById('toast'); if (dom) dom.className = '';
    }
  }
  toastMesh.visible = !!toastCur && G.mode !== 'desktop';
  if (toastMesh.visible) {
    _f.set(0, 0, -1).applyQuaternion(G.headQuat); _f.y = 0; _f.normalize();
    _t.copy(G.head).addScaledVector(_f, 1.1); _t.y = G.head.y - 0.32;
    if (toastT < dt * 1.5) toastMesh.position.copy(_t); else toastMesh.position.lerp(_t, 1 - Math.exp(-3 * dt));
    toastMesh.lookAt(G.head);
  }
}
on('toast', (text, kind) => {
  if (toastQueue.length > 4) toastQueue.shift();
  if (toastCur && toastCur.text === text) return;
  toastQueue.push({ text, kind });
});
