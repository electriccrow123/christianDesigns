// Room scanning and the room model. In mixed reality the headset's plane/mesh detection
// gives us walls, floor, ceiling, couches and tables; otherwise we build a room from the
// guardian boundary or a default layout. Walls are what windows get cut into.
import * as THREE from 'three';
import { G, emit, wallMat, view, textSprite, std } from './core.js';
import { S } from './state.js';

export const room = {
  group: new THREE.Group(),
  surfaces: [], // meshes with userData.surface
  furniture: [], // {label, box: Box3, center, size}
  source: 'none',
  ready: false,
  center: new THREE.Vector3(0, 0, 0),
  bounds: new THREE.Box3(new THREE.Vector3(-2.5, 0, -2.5), new THREE.Vector3(2.5, 2.6, 2.5)),
  floorY: 0,
  height: 2.6,
  floorPoly: null, // [[x,z],...]
};

const planes = new Map(); // XRPlane -> entry
const xrMeshes = new Map(); // XRMesh -> entry
const scan = { phase: 'idle', t: 0, fade: 0, tried: false };
room.scan = scan;

// ---------- materials ----------
const scanUniforms = { uTime: { value: 0 }, uOrigin: { value: new THREE.Vector3() }, uFade: { value: 1 }, uColor: { value: new THREE.Color(0x2fd6ff) } };
const scanMat = new THREE.ShaderMaterial({
  uniforms: scanUniforms,
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    varying vec3 vW; varying vec3 vN;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform vec3 uOrigin; uniform float uFade; uniform vec3 uColor;
    varying vec3 vW; varying vec3 vN;
    void main(){
      vec3 n = abs(normalize(vN));
      vec2 p = n.y > max(n.x, n.z) ? vW.xz : (n.x > n.z ? vW.zy : vW.xy);
      vec2 g = abs(fract(p * 4.0) - 0.5);
      float line = 1.0 - smoothstep(0.42, 0.48, max(g.x, g.y));
      float d = distance(vW, uOrigin);
      float r = mod(uTime * 2.2, 9.0);
      float wave = exp(-pow((d - r) * 3.0, 2.0));
      float a = (line * 0.55 + wave * 0.6 + 0.05) * uFade;
      gl_FragColor = vec4(uColor + wave * 0.6, a);
    }`,
});
scanMat.toneMapped = false;

function panelTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  if (kind === 'floor') {
    g.fillStyle = '#2a3038'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 512; i += 16) { g.fillStyle = i % 32 ? '#363e47' : '#20262d'; g.fillRect(0, i, 512, 7); }
    g.strokeStyle = '#0b0f13'; g.lineWidth = 6; g.strokeRect(3, 3, 506, 506);
    g.fillStyle = '#ffb000'; for (let x = 0; x < 512; x += 64) g.fillRect(x, 0, 32, 6);
  } else if (kind === 'ceiling') {
    g.fillStyle = '#20262c'; g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#cfefff'; g.fillRect(40, 236, 432, 40);
    g.strokeStyle = '#11161a'; g.lineWidth = 8; g.strokeRect(4, 4, 504, 504);
  } else {
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, '#56636f'); grd.addColorStop(1, '#414b56');
    g.fillStyle = grd; g.fillRect(0, 0, 512, 512);
    g.strokeStyle = '#161b20'; g.lineWidth = 6;
    g.strokeRect(10, 10, 492, 230); g.strokeRect(10, 260, 240, 242); g.strokeRect(262, 260, 240, 242);
    g.fillStyle = '#58656f';
    for (const [x, y] of [[24, 24], [488, 24], [24, 226], [488, 226], [24, 274], [236, 274], [276, 274], [488, 274]]) { g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
    g.fillStyle = '#2fd6ff'; g.fillRect(0, 246, 512, 6);
    g.fillStyle = '#ff9a2f'; g.fillRect(40, 420, 60, 10);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const skin = {
  wall: wallMat(std(0xffffff, { map: panelTexture('wall'), metalness: 0.5, roughness: 0.6, transparent: true, side: THREE.DoubleSide })),
  floor: wallMat(std(0xffffff, { map: panelTexture('floor'), metalness: 0.6, roughness: 0.5 })),
  ceiling: wallMat(std(0xffffff, { map: panelTexture('ceiling'), metalness: 0.3, roughness: 0.7, side: THREE.DoubleSide })),
  furniture: std(0x445566, { roughness: 0.8, metalness: 0.1 }),
};
const hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
// Invisible depth-only "occluder" for real walls in mixed reality, so virtual objects
// behind your real walls are hidden (but windows still show space through them).
const occluderMat = wallMat(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));

function classify(label, orientation, y) {
  label = (label || '').toLowerCase();
  if (label.includes('wall') || label === 'door frame' || label === 'window frame') return label.includes('frame') ? 'frame' : 'wall';
  if (label.includes('floor')) return 'floor';
  if (label.includes('ceiling')) return 'ceiling';
  if (label.includes('couch') || label.includes('sofa') || label.includes('bed')) return 'couch';
  if (label.includes('table') || label.includes('desk')) return 'table';
  if (label) return 'other';
  if (orientation === 'vertical') return 'wall';
  if (y < 0.15) return 'floor';
  if (y > 1.9) return 'ceiling';
  return 'table';
}

// Triangulated polygon (in local XZ) with UVs in metres.
function polyGeometry(pts) {
  const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
  if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const pos = [], uv = [], nrm = [];
  for (const v of contour) { pos.push(v.x, 0, v.y); uv.push(v.x / 1.2, v.y / 1.2); nrm.push(0, 1, 0); }
  const idx = [];
  for (const t of tris) idx.push(t[0], t[2], t[1]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

function materialFor(kind) {
  if (scan.phase === 'scanning' || scan.fade > 0.01 || G.buildMode) return scanMat;
  const virtualRoom = G.mode !== 'ar' || S.settings.skin;
  if (view.portal === 'open') return kind === 'floor' && G.mode !== 'ar' ? skin.floor : hiddenMat;
  if (kind === 'wall') return virtualRoom ? skin.wall : occluderMat;
  if (kind === 'floor') return virtualRoom ? skin.floor : hiddenMat;
  if (kind === 'ceiling') return virtualRoom ? skin.ceiling : occluderMat;
  if (kind === 'couch' || kind === 'table' || kind === 'other') return G.mode === 'ar' ? hiddenMat : skin.furniture;
  return hiddenMat;
}

export function refreshRoomVisuals() {
  skin.wall.opacity = G.mode === 'ar' ? 0.93 : 1;
  for (const m of room.surfaces) {
    const mat = materialFor(m.userData.surface.kind);
    m.material = m.userData.fixedMat && mat !== scanMat ? m.userData.fixedMat : mat;
  }
  for (const e of xrMeshes.values()) e.mesh.visible = scan.phase === 'scanning' || scan.fade > 0.01;
}

function addSurface(mesh, kind, label) {
  mesh.userData.surface = { kind, label, normal: new THREE.Vector3(0, 1, 0), center: new THREE.Vector3() };
  mesh.material = materialFor(kind);
  room.group.add(mesh);
  room.surfaces.push(mesh);
  return mesh;
}

function updateSurfaceInfo(mesh) {
  mesh.updateMatrixWorld(true);
  const s = mesh.userData.surface;
  s.normal.set(0, 1, 0).transformDirection(mesh.matrixWorld);
  mesh.geometry.computeBoundingBox();
  mesh.geometry.boundingBox.getCenter(s.center).applyMatrix4(mesh.matrixWorld);
  const sz = new THREE.Vector3(); mesh.geometry.boundingBox.getSize(sz);
  s.size = sz;
  if (s.kind === 'wall' || s.kind === 'frame') {
    // walls face into the room
    const toC = room.center.clone().sub(s.center); toC.y = 0;
    if (s.normal.dot(toC) < 0) s.normal.negate();
  }
}

// ---------- XR plane / mesh detection ----------
export function updateScan(frame, refSpace, dt) {
  scanUniforms.uTime.value += dt;
  scanUniforms.uOrigin.value.copy(G.head).setY(G.head.y - 1.0);
  if (scan.phase === 'scanning') {
    scan.t += dt;
    scanUniforms.uFade.value = Math.min(1, scan.t * 2);
  } else if (scan.fade > 0) {
    scan.fade = Math.max(0, scan.fade - dt * 0.4);
    scanUniforms.uFade.value = G.buildMode ? 0.5 : scan.fade;
    if (scan.fade === 0) refreshRoomVisuals();
  } else if (G.buildMode) scanUniforms.uFade.value = 0.45;

  if (frame && room.source !== 'fallback') {
    let changed = false;
    if (frame.detectedPlanes) {
      for (const plane of frame.detectedPlanes) {
        let e = planes.get(plane);
        const pose = frame.getPose(plane.planeSpace, refSpace);
        if (!pose) continue;
        if (!e || e.changed !== plane.lastChangedTime) {
          const pts = plane.polygon.map((p) => [p.x, p.z]);
          if (pts.length < 3) continue;
          const y = pose.transform.position.y;
          const kind = classify(plane.semanticLabel, plane.orientation, y);
          if (!e) {
            const mesh = new THREE.Mesh(polyGeometry(pts), scanMat);
            mesh.matrixAutoUpdate = false;
            addSurface(mesh, kind, plane.semanticLabel || kind);
            e = { mesh, kind };
            planes.set(plane, e);
          } else { e.mesh.geometry.dispose(); e.mesh.geometry = polyGeometry(pts); }
          e.changed = plane.lastChangedTime;
          changed = true;
        }
        e.mesh.matrix.fromArray(pose.transform.matrix);
        e.mesh.matrixWorldNeedsUpdate = true;
      }
      for (const [plane, e] of planes) {
        if (!frame.detectedPlanes.has(plane)) {
          room.group.remove(e.mesh);
          room.surfaces.splice(room.surfaces.indexOf(e.mesh), 1);
          planes.delete(plane);
          changed = true;
        }
      }
    }
    if (frame.detectedMeshes) {
      for (const xm of frame.detectedMeshes) {
        let e = xrMeshes.get(xm);
        const pose = frame.getPose(xm.meshSpace, refSpace);
        if (!pose) continue;
        if (!e || e.changed !== xm.lastChangedTime) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(xm.vertices), 3));
          geo.setIndex(new THREE.BufferAttribute(new Uint32Array(xm.indices), 1));
          geo.computeVertexNormals();
          if (!e) {
            const mesh = new THREE.Mesh(geo, scanMat);
            mesh.matrixAutoUpdate = false;
            room.group.add(mesh);
            e = { mesh, label: (xm.semanticLabel || '').toLowerCase() };
            xrMeshes.set(xm, e);
          } else { e.mesh.geometry.dispose(); e.mesh.geometry = geo; }
          e.changed = xm.lastChangedTime;
          changed = true;
        }
        e.mesh.matrix.fromArray(pose.transform.matrix);
        e.mesh.matrixWorldNeedsUpdate = true;
      }
    }
    if (changed) recomputeRoom();
  }

  if (scan.phase === 'scanning') {
    const wallCount = room.surfaces.filter((m) => m.userData.surface.kind === 'wall').length;
    if (scan.t > 3 && wallCount === 0 && !scan.tried && G.session?.initiateRoomCapture) {
      scan.tried = true;
      emit('toast', 'No saved room found — starting room setup...');
      G.session.initiateRoomCapture().catch(() => {});
    }
    const minT = G.mode === 'desktop' ? 3.5 : 4.5;
    if (scan.t > minT && wallCount > 0) finishScan();
    else if (scan.t > (G.mode === 'ar' ? 12 : 3) && wallCount === 0) {
      buildFallbackRoom();
      if (G.mode !== 'desktop') emit('toast', 'No room scan available: using your play boundary. Run Space Setup in your headset for a perfect fit.', 'warn');
      finishScan();
    }
  }
  for (const s of labelSprites) s.material.opacity = Math.min(1, scanUniforms.uFade.value * 1.5);
}

const labelSprites = [];
function finishScan() {
  scan.phase = 'done';
  scan.fade = 1;
  recomputeRoom();
  const counts = {};
  for (const m of room.surfaces) { const k = m.userData.surface.kind; counts[k] = (counts[k] || 0) + 1; }
  for (const f of room.furniture) if (!f.mesh) counts[f.label] = (counts[f.label] || 0) + 1;
  for (const m of room.surfaces) {
    const s = m.userData.surface;
    if (['couch', 'table'].includes(s.kind) || (s.kind === 'wall' && s.size.x * s.size.z > 1.5)) {
      const sp = textSprite(s.kind.toUpperCase(), { size: 0.09 });
      sp.position.copy(s.center).add(s.normal.clone().multiplyScalar(0.1));
      sp.material.transparent = true;
      room.group.add(sp); labelSprites.push(sp);
      setTimeout(() => { room.group.remove(sp); labelSprites.splice(labelSprites.indexOf(sp), 1); }, 6000);
    }
  }
  const plural = (k, n) => (n > 1 ? (k.endsWith('ch') ? k + 'es' : k + 's') : k);
  const parts = Object.entries(counts).filter(([k]) => k !== 'frame').map(([k, n]) => `${n} ${plural(k, n)}`);
  emit('toast', `Scan complete: ${parts.join(', ')}`);
  emit('say', 'Environment scan complete. Converting your room into the bridge.');
  emit('sfx', 'scanDone');
  room.ready = true;
  emit('roomReady');
}

function recomputeRoom() {
  const floor = room.surfaces.find((m) => m.userData.surface.kind === 'floor');
  const box = new THREE.Box3();
  let any = false;
  for (const m of room.surfaces) {
    const k = m.userData.surface.kind;
    if (k === 'wall' || k === 'floor') { m.updateMatrixWorld(true); m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); any = true; }
  }
  if (any) {
    room.bounds.copy(box);
    room.bounds.getCenter(room.center);
    room.floorY = floor ? new THREE.Vector3().setFromMatrixPosition(floor.matrixWorld).y : 0;
    room.center.y = room.floorY;
    room.height = Math.max(2.2, box.max.y - room.floorY);
  }
  for (const m of room.surfaces) updateSurfaceInfo(m);
  room.furniture = [];
  for (const m of room.surfaces) {
    const s = m.userData.surface;
    if (s.kind === 'couch' || s.kind === 'table') {
      const b = new THREE.Box3().setFromObject(m);
      room.furniture.push({ label: s.kind, box: b, center: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()), mesh: m });
    }
  }
  for (const e of xrMeshes.values()) {
    if (e.label === 'couch' || e.label === 'table') {
      const b = new THREE.Box3().setFromObject(e.mesh);
      if (!room.furniture.some((f) => f.label === e.label && f.center.distanceTo(b.getCenter(new THREE.Vector3())) < 0.5))
        room.furniture.push({ label: e.label, box: b, center: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()) });
    }
  }
  room.surfacesChanged = true;
}

// ---------- fallback room built from a floor polygon ----------
function wallQuad(a, b, h, y0) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const geo = new THREE.PlaneGeometry(len, h);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len / 1.2, uv.getY(i) * h / 1.2);
  geo.rotateX(-Math.PI / 2); // lay it in XZ so local +Y is the normal, like XR planes
  const m = new THREE.Mesh(geo, scanMat);
  const mid = new THREE.Vector3((a[0] + b[0]) / 2, y0 + h / 2, (a[1] + b[1]) / 2);
  // local X along the wall, local Y (normal) pointing to the room centre, local Z up/down
  const along = new THREE.Vector3(b[0] - a[0], 0, b[1] - a[1]).normalize();
  let normal = new THREE.Vector3(-along.z, 0, along.x);
  const toC = room.center.clone().sub(mid); toC.y = 0;
  if (normal.dot(toC) < 0) normal.negate();
  const zAxis = new THREE.Vector3().crossVectors(along, normal);
  m.matrix.makeBasis(along, normal, zAxis).setPosition(mid);
  m.matrixAutoUpdate = false;
  return m;
}

export function buildRoomFromPolygon(poly, height = 2.6, y0 = 0) {
  room.source = 'fallback';
  room.floorPoly = poly;
  const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
  room.center.set(c[0], y0, c[1]);
  for (let i = 0; i < poly.length; i++) {
    const m = wallQuad(poly[i], poly[(i + 1) % poly.length], height, y0);
    addSurface(m, 'wall', 'wall');
  }
  const floor = new THREE.Mesh(polyGeometry(poly), scanMat);
  floor.position.y = y0; floor.updateMatrix(); floor.matrixAutoUpdate = false;
  addSurface(floor, 'floor', 'floor');
  const ceil = new THREE.Mesh(polyGeometry(poly), scanMat);
  ceil.matrix.makeScale(1, -1, 1).setPosition(0, y0 + height, 0);
  ceil.matrixAutoUpdate = false;
  addSurface(ceil, 'ceiling', 'ceiling');
  recomputeRoom();
}

function buildFallbackRoom() {
  // drop whatever partial detection we had
  for (const e of planes.values()) room.group.remove(e.mesh);
  planes.clear();
  room.surfaces.length = 0;
  let poly = null;
  if (G.boundsPoly && G.boundsPoly.length >= 3) poly = G.boundsPoly;
  if (!poly) {
    if (G.mode === 'desktop') poly = [[-3, -3.5], [3, -3.5], [3, 3.5], [-3, 3.5]];
    else {
      const cx = G.head.x, cz = G.head.z;
      poly = [[cx - 2, cz - 2], [cx + 2, cz - 2], [cx + 2, cz + 2], [cx - 2, cz + 2]];
    }
  }
  buildRoomFromPolygon(poly, G.mode === 'desktop' ? 2.8 : 2.5);
  if (G.mode === 'desktop') addDesktopFurniture();
}

function addDesktopFurniture() {
  // a couch at the back of the room, facing the front wall, and a side table
  const couch = new THREE.Group();
  const fabric = std(0x3b4f6b, { roughness: 0.95, metalness: 0 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.42, 0.9), fabric); base.position.y = 0.21; couch.add(base);
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.5, 0.22), fabric); back.position.set(0, 0.62, 0.34); couch.add(back);
  for (const sx of [-1, 1]) { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.62, 0.9), fabric); arm.position.set(sx * 1.0, 0.31, 0); couch.add(arm); }
  couch.position.set(0, 0, 2.6);
  room.group.add(couch);
  const seat = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.8).rotateX(-Math.PI / 2), hiddenMat);
  seat.position.set(0, 0.43, 2.6); seat.updateMatrix(); seat.matrixAutoUpdate = false;
  addSurface(seat, 'couch', 'couch');
  seat.userData.fixedMat = hiddenMat;
  const table = new THREE.Group();
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.04, 24), std(0x6b4b33, { metalness: 0.1 })); top.position.y = 0.55; table.add(top);
  const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.55, 8), std(0x222222)); leg.position.y = 0.27; table.add(leg);
  table.position.set(1.5, 0, 2.6);
  room.group.add(table);
  recomputeRoom();
}

export function startScan() {
  scan.phase = 'scanning';
  scan.t = 0;
  scan.tried = false;
  room.ready = false;
  refreshRoomVisuals();
  emit('toast', G.mode === 'ar' ? 'Scanning your room... look around' : 'Mapping deck layout...');
  emit('sfx', 'teleport');
  if (G.mode === 'desktop') buildFallbackRoom();
}

export function rescan() {
  if (G.mode === 'ar' && G.session?.initiateRoomCapture) G.session.initiateRoomCapture().catch(() => emit('toast', 'Room setup is not available here', 'warn'));
  scan.phase = 'scanning'; scan.t = 0; scan.fade = 1;
  refreshRoomVisuals();
}

export function walls() { return room.surfaces.filter((m) => m.userData.surface.kind === 'wall'); }

// Random point on the floor, kept away from the walls.
export function randomFloorPoint(margin = 0.5) {
  const b = room.bounds;
  for (let i = 0; i < 30; i++) {
    const x = THREE.MathUtils.lerp(b.min.x + margin, b.max.x - margin, Math.random());
    const z = THREE.MathUtils.lerp(b.min.z + margin, b.max.z - margin, Math.random());
    if (insideRoom(x, z, margin)) return new THREE.Vector3(x, room.floorY, z);
  }
  return room.center.clone();
}

export function insideRoom(x, z, margin = 0) {
  const b = room.bounds;
  if (x < b.min.x + margin || x > b.max.x - margin || z < b.min.z + margin || z > b.max.z - margin) return false;
  if (room.floorPoly) {
    let inside = false;
    const p = room.floorPoly;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if ((p[i][1] > z) !== (p[j][1] > z) && x < ((p[j][0] - p[i][0]) * (z - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) inside = !inside;
    }
    return inside;
  }
  return true;
}

export function clampToRoom(v, margin = 0.3) {
  const b = room.bounds;
  v.x = THREE.MathUtils.clamp(v.x, b.min.x + margin, b.max.x - margin);
  v.z = THREE.MathUtils.clamp(v.z, b.min.z + margin, b.max.z - margin);
  return v;
}
