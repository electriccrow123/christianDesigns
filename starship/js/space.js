// The universe outside your windows: a procedural galaxy of star systems with planets,
// rings, moons, asteroid belts, space stations and nebula skies. The room never moves;
// instead the universe is transformed by the inverse of the ship's pose.
import * as THREE from 'three';
import { G, emit, spaceMat, spaceMats, glow, glowTexture, mulberry32, clamp, damp } from './core.js';
import { S, stat, save, addCredits } from './state.js';

export const universe = new THREE.Group(); // objects in system coordinates
universe.matrixAutoUpdate = false;
export const sky = new THREE.Group(); // infinitely far things: rotate only
sky.matrixAutoUpdate = false;
export const ship = {
  pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(),
  speed: 0, throttle: 0, input: { pitch: 0, yaw: 0, roll: 0 }, boost: false,
  radius: 14, warping: 0, autopilot: null,
};
G.ship = ship;

export const galaxy = [];
export let system = null; // current system description + objects
const sysGroup = new THREE.Group();
universe.add(sysGroup);

// ---------- galaxy ----------
const SYL = ['ka', 'ri', 'on', 'ze', 'tha', 'mor', 'vex', 'lu', 'qua', 'dra', 'sol', 'nyx', 'or', 'bel', 'tor', 'ix', 'an', 'cy', 'pha', 'rho', 'xi', 'ven', 'gal', 'ul'];
function name(rng, n = 2 + Math.floor(rng() * 2)) {
  let s = '';
  for (let i = 0; i < n; i++) s += SYL[Math.floor(rng() * SYL.length)];
  return s[0].toUpperCase() + s.slice(1);
}
const STAR_TYPES = [
  { cls: 'G', color: 0xfff1c0, glow: '#ffd27a', r: 500 },
  { cls: 'M', color: 0xff8a5a, glow: '#ff6a3a', r: 380 },
  { cls: 'B', color: 0xaaccff, glow: '#7aa8ff', r: 750 },
  { cls: 'K', color: 0xffc070, glow: '#ffa040', r: 450 },
  { cls: 'W', color: 0xf4f8ff, glow: '#c8e4ff', r: 300 },
];
export function buildGalaxy() {
  const rng = mulberry32(1337);
  galaxy.length = 0;
  for (let i = 0; i < 48; i++) {
    const a = rng() * Math.PI * 2, r = i === 0 ? 0 : 1 + rng() * 9;
    galaxy.push({
      id: i, name: i === 0 ? 'Solace' : name(rng),
      x: Math.cos(a) * r + (rng() - 0.5) * 2, y: Math.sin(a) * r + (rng() - 0.5) * 2,
      seed: Math.floor(rng() * 1e9), star: STAR_TYPES[Math.floor(rng() * STAR_TYPES.length)],
      danger: i === 0 ? 1 : 1 + Math.floor(rng() * 4 + r / 4),
      economy: ['Mining', 'Trade', 'Science', 'Industrial', 'Frontier'][Math.floor(rng() * 5)],
    });
  }
  if (galaxy[0]) galaxy[0].x = galaxy[0].y = 0;
}
export const systemDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------- noise & textures ----------
function makeNoise(seed) {
  const rng = mulberry32(seed);
  const perm = new Uint8Array(512);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const val = new Float32Array(256).map(() => rng());
  const h = (x, y, z) => val[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  const sm = (t) => t * t * (3 - 2 * t);
  function n3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = sm(x - xi), yf = sm(y - yi), zf = sm(z - zi);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(h(xi, yi, zi), h(xi + 1, yi, zi), xf), l(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf),
      l(l(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), l(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf), zf);
  }
  return (x, y, z, oct = 4) => { let s = 0, a = 0.5, f = 1; for (let i = 0; i < oct; i++) { s += a * n3(x * f, y * f, z * f); a *= 0.5; f *= 2; } return s / (1 - Math.pow(0.5, oct)); };
}

const PLANET_TYPES = {
  rocky: { stops: [[0, '#3b3029'], [0.45, '#6e5a48'], [0.6, '#8f7a63'], [1, '#c9b79c']], atm: 0x99aabb },
  ocean: { stops: [[0, '#0a2a66'], [0.52, '#1f5fa8'], [0.55, '#d8c78f'], [0.62, '#3f8a3a'], [0.8, '#2d5e2a'], [1, '#f0f0f0']], atm: 0x66aaff },
  jungle: { stops: [[0, '#0f3a1a'], [0.5, '#2f7a2a'], [0.7, '#77b03a'], [1, '#d9e08a']], atm: 0x88ffaa },
  lava: { stops: [[0, '#ff7a00'], [0.35, '#a02000'], [0.45, '#2a0e0a'], [1, '#120808']], atm: 0xff6633 },
  ice: { stops: [[0, '#7aa6c8'], [0.5, '#cfe6f5'], [1, '#ffffff']], atm: 0xbbe6ff },
  desert: { stops: [[0, '#8a4f22'], [0.5, '#c98a45'], [1, '#f2d39a']], atm: 0xffcc88 },
  toxic: { stops: [[0, '#3a4a00'], [0.5, '#9acd32'], [0.7, '#d8ff5a'], [1, '#4a3a6a']], atm: 0xccff44 },
  gas: { stops: [[0, '#6a4a2a'], [0.3, '#d8a868'], [0.5, '#f2e0c0'], [0.7, '#b07040'], [1, '#e8c8a0']], atm: 0xffddaa, bands: true },
  gasblue: { stops: [[0, '#1a2a6a'], [0.4, '#4a7ad8'], [0.6, '#a8d0ff'], [1, '#e0f0ff']], atm: 0x99ccff, bands: true },
};

function lerpColor(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0 || 1);
      const a = new THREE.Color(c0), b = new THREE.Color(c1);
      return a.lerp(b, k);
    }
  }
  return new THREE.Color(stops[stops.length - 1][1]);
}

function planetTexture(type, seed, W = 256, H = 128) {
  const def = PLANET_TYPES[type];
  const noise = makeNoise(seed);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const lut = []; for (let i = 0; i < 64; i++) lut.push(lerpColor(def.stops, i / 63));
  for (let y = 0; y < H; y++) {
    const lat = (y / H - 0.5) * Math.PI;
    for (let x = 0; x < W; x++) {
      const lon = (x / W) * Math.PI * 2;
      const px = Math.cos(lat) * Math.cos(lon), py = Math.sin(lat), pz = Math.cos(lat) * Math.sin(lon);
      let v;
      if (def.bands) v = clamp(0.5 + 0.5 * Math.sin(py * 14 + noise(px * 2, py * 6, pz * 2, 3) * 5), 0, 1);
      else {
        v = noise(px * 2.2 + 10, py * 2.2, pz * 2.2, 5);
        v = clamp((v - 0.25) * 1.9, 0, 1);
        if (type === 'ice' || type === 'ocean' || type === 'jungle') { if (Math.abs(py) > 0.85) v = 1; }
      }
      const col = lut[Math.floor(v * 63)];
      const i = (y * W + x) * 4;
      img.data[i] = col.r * 255; img.data[i + 1] = col.g * 255; img.data[i + 2] = col.b * 255; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function skyTexture(rng, hue) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#01020a'; g.fillRect(0, 0, W, H);
  // galactic band
  const band = g.createLinearGradient(0, H * 0.3, 0, H * 0.7);
  band.addColorStop(0, 'rgba(0,0,0,0)'); band.addColorStop(0.5, `hsla(${hue + 30},40%,30%,0.35)`); band.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = band; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  // nebula puffs
  for (let i = 0; i < 140; i++) {
    const x = rng() * W, y = H * 0.2 + rng() * H * 0.6, r = 30 + rng() * 140;
    const h = hue + (rng() - 0.5) * 80;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `hsla(${h},80%,55%,${0.05 + rng() * 0.08})`);
    grd.addColorStop(1, 'hsla(0,0%,0%,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    if (x < r) { g.beginPath(); g.arc(x + W, y, r, 0, 7); g.fill(); }
    if (x > W - r) { g.beginPath(); g.arc(x - W, y, r, 0, 7); g.fill(); }
  }
  // stars
  for (let i = 0; i < 2600; i++) {
    const x = rng() * W, y = rng() * H, b = rng();
    g.fillStyle = `rgba(${200 + b * 55},${200 + b * 55},255,${0.3 + b * 0.7})`;
    g.fillRect(x, y, b > 0.97 ? 2 : 1, b > 0.97 ? 2 : 1);
  }
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
}

// ---------- star field (always present) ----------
let skySphere, starPoints;
function buildSky() {
  skySphere = new THREE.Mesh(new THREE.SphereGeometry(15000, 48, 24), spaceMat(new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false })));
  skySphere.renderOrder = -8;
  sky.add(skySphere);
  const n = 2500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(14000);
    pos.set([v.x, v.y, v.z], i * 3);
    const t = Math.random();
    const c = new THREE.Color().setHSL(0.55 + t * 0.15, 0.4, 0.7 + Math.random() * 0.3);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  starPoints = new THREE.Points(geo, spaceMat(new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, depthWrite: false, toneMapped: false })));
  starPoints.renderOrder = -7;
  sky.add(starPoints);
}

// ---------- system objects ----------
function glowSprite(color, scale, opacity = 1) {
  const m = spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity, toneMapped: false }));
  const s = new THREE.Sprite(m);
  s.scale.setScalar(scale);
  return s;
}

function buildStation(rng) {
  const st = new THREE.Group();
  const hullM = spaceMat(new THREE.MeshStandardMaterial({ color: 0xb8c4d0, metalness: 0.7, roughness: 0.4 }));
  const darkM = spaceMat(new THREE.MeshStandardMaterial({ color: 0x45505c, metalness: 0.6, roughness: 0.5 }));
  const lightM = spaceMat(glow(0x88e0ff));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(60, 7, 12, 48), hullM);
  st.add(ring);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 70, 16), darkM);
  hub.rotation.x = Math.PI / 2; st.add(hub);
  for (let i = 0; i < 4; i++) {
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 2.5, 60, 8), darkM);
    sp.rotation.z = (i * Math.PI) / 2; sp.position.set(Math.cos(i * Math.PI / 2) * 30, Math.sin(i * Math.PI / 2) * 30, 0);
    sp.rotation.z = i * Math.PI / 2 + Math.PI / 2;
    st.add(sp);
  }
  for (let i = 0; i < 24; i++) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(3, 1.5, 1.5), lightM);
    const a = (i / 24) * Math.PI * 2;
    l.position.set(Math.cos(a) * 60, Math.sin(a) * 60, 7.2);
    l.rotation.z = a;
    st.add(l);
  }
  const dock = new THREE.Mesh(new THREE.TorusGeometry(14, 1.5, 8, 24), spaceMat(glow(0x40ff90)));
  dock.position.z = 36; st.add(dock);
  const beacon = glowSprite(0x40ff90, 60, 0.8); beacon.position.z = 40; st.add(beacon);
  st.userData.spin = 0.05 + rng() * 0.05;
  return st;
}

export function asteroidGeo(rng, r = 1) {
  const geo = new THREE.IcosahedronGeometry(r, 1);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 0.75 + rng() * 0.45;
    p.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

function clearSystem() {
  // escort drones survive warp jumps; everything else in the system is disposed
  const keep = sysGroup.children.filter((o) => o.userData.persistent);
  for (const o of keep) sysGroup.remove(o);
  sysGroup.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { for (const m of [].concat(o.material)) { if (m.map && m.map !== glowTexture()) m.map.dispose(); spaceMats.delete(m); m.dispose(); } }
  });
  sysGroup.clear();
  for (const o of keep) sysGroup.add(o);
  G.spaceTargets = G.spaceTargets.filter((t) => !t.userData.systemObject);
}

export function loadSystem(id) {
  clearSystem();
  const sys = galaxy[id];
  const rng = mulberry32(sys.seed);
  const hue = Math.floor(rng() * 360);
  const old = skySphere.material.map;
  skySphere.material.map = skyTexture(rng, hue);
  skySphere.material.needsUpdate = true;
  old?.dispose();

  const objs = { sys, planets: [], station: null, asteroids: [], star: null, scanables: [] };
  // star
  const st = sys.star;
  const star = new THREE.Mesh(new THREE.SphereGeometry(st.r, 32, 16), spaceMat(glow(st.color)));
  star.add(glowSprite(new THREE.Color(st.glow), st.r * 6, 0.9));
  star.add(glowSprite(0xffffff, st.r * 2.6, 0.8));
  sysGroup.add(star);
  objs.star = star;
  sunLight.color.set(st.color);

  // planets
  const nP = 2 + Math.floor(rng() * 5);
  const types = Object.keys(PLANET_TYPES);
  for (let i = 0; i < nP; i++) {
    const type = types[Math.floor(rng() * types.length)];
    const isGas = type.startsWith('gas');
    const r = isGas ? 280 + rng() * 260 : 70 + rng() * 170;
    const orbit = 3200 + i * 2300 + rng() * 800;
    const a = rng() * Math.PI * 2;
    const pos = new THREE.Vector3(Math.cos(a) * orbit, (rng() - 0.5) * 600, Math.sin(a) * orbit);
    const tex = planetTexture(type, sys.seed + i * 77, isGas ? 256 : 384, isGas ? 128 : 192);
    const mat = spaceMat(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }));
    const planet = new THREE.Mesh(new THREE.SphereGeometry(r, 48, 24), mat);
    planet.position.copy(pos);
    planet.rotation.z = (rng() - 0.5) * 0.6;
    const atm = new THREE.Mesh(new THREE.SphereGeometry(r * 1.04, 48, 24), spaceMat(new THREE.MeshBasicMaterial({ color: PLANET_TYPES[type].atm, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
    planet.add(atm);
    if (isGas && rng() < 0.7) {
      const rc = document.createElement('canvas'); rc.width = 256; rc.height = 4;
      const rg = rc.getContext('2d');
      for (let x = 0; x < 256; x++) { const b = 0.4 + 0.6 * Math.abs(Math.sin(x * 0.3 + rng() * 2)); rg.fillStyle = `rgba(${200 + rng() * 55},${180 + rng() * 50},${150 + rng() * 60},${b * (x > 20 && x < 245 ? 0.75 : 0.1)})`; rg.fillRect(x, 0, 1, 4); }
      const rt = new THREE.CanvasTexture(rc); rt.colorSpace = THREE.SRGBColorSpace;
      const rgeo = new THREE.RingGeometry(r * 1.4, r * 2.4, 96, 1);
      const uv = rgeo.attributes.uv, p = rgeo.attributes.position;
      for (let k = 0; k < uv.count; k++) { const d = Math.hypot(p.getX(k), p.getY(k)); uv.setXY(k, (d - r * 1.4) / (r * 1.0), 0.5); }
      const ring = new THREE.Mesh(rgeo, spaceMat(new THREE.MeshBasicMaterial({ map: rt, side: THREE.DoubleSide, transparent: true, depthWrite: false, toneMapped: false })));
      ring.rotation.x = Math.PI / 2 + (rng() - 0.5) * 0.5;
      planet.add(ring);
    }
    const moons = isGas ? Math.floor(rng() * 3) : Math.floor(rng() * 2);
    for (let m = 0; m < moons; m++) {
      const mr = 20 + rng() * 40;
      const moon = new THREE.Mesh(new THREE.SphereGeometry(mr, 24, 12), spaceMat(new THREE.MeshStandardMaterial({ map: planetTexture('rocky', sys.seed + i * 13 + m, 128, 64), roughness: 1 })));
      const ma = rng() * Math.PI * 2, md = r * 2 + 120 + rng() * 300;
      moon.position.set(Math.cos(ma) * md, (rng() - 0.5) * 100, Math.sin(ma) * md);
      planet.add(moon);
    }
    const pname = `${sys.name} ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][i]}`;
    planet.userData.target = { kind: 'planet', name: pname, type, radius: r, obj: planet, scanKey: `${id}:p${i}`, value: Math.round((isGas ? 150 : 250) + rng() * 300) };
    planet.userData.systemObject = true;
    sysGroup.add(planet);
    G.spaceTargets.push(planet);
    objs.planets.push(planet);
  }
  // station near an inner planet
  const host = objs.planets[0];
  const station = buildStation(rng);
  station.position.copy(host.position).add(new THREE.Vector3(host.userData.target.radius * 2.5 + 400, 80, 0));
  station.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(host.position, station.position, new THREE.Vector3(0, 1, 0)));
  station.userData.target = { kind: 'station', name: `${sys.name} Station`, obj: station, radius: 70 };
  station.userData.systemObject = true;
  sysGroup.add(station);
  G.spaceTargets.push(station);
  objs.station = station;

  // asteroid belt (decorative instanced) + a field of mineable rocks near the station
  const beltR = 3200 + rng() * 5000;
  const belt = new THREE.InstancedMesh(asteroidGeo(rng, 1), spaceMat(new THREE.MeshStandardMaterial({ color: 0x7a6e64, roughness: 1, flatShading: true })), 400);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  for (let i = 0; i < 400; i++) {
    const a = rng() * Math.PI * 2, d = beltR + (rng() - 0.5) * 900;
    q.setFromEuler(new THREE.Euler(rng() * 6, rng() * 6, rng() * 6));
    const s = 4 + rng() * 30;
    mtx.compose(new THREE.Vector3(Math.cos(a) * d, (rng() - 0.5) * 200, Math.sin(a) * d), q, sc.set(s, s * (0.6 + rng() * 0.6), s));
    belt.setMatrixAt(i, mtx);
  }
  sysGroup.add(belt);
  const field = station.position.clone().add(new THREE.Vector3(-700, -100, 600));
  for (let i = 0; i < 18; i++) spawnAsteroid(field.clone().add(new THREE.Vector3((rng() - 0.5) * 900, (rng() - 0.5) * 300, (rng() - 0.5) * 900)), 6 + rng() * 14, rng, objs);

  system = objs;
  emit('system', sys);
  return objs;
}

const rockMat = () => spaceMat(new THREE.MeshStandardMaterial({ color: 0x8a7a6a, roughness: 1, flatShading: true }));
export function spawnAsteroid(pos, r, rng = Math.random, objs = system) {
  const a = new THREE.Mesh(asteroidGeo(rng, r), rockMat());
  a.position.copy(pos);
  a.rotation.set(rng() * 6, rng() * 6, rng() * 6);
  a.userData.spin = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.3);
  a.userData.target = { kind: 'asteroid', name: 'Asteroid', obj: a, radius: r, hp: r * 8, ore: Math.round(r * 6), hostile: false };
  a.userData.systemObject = true;
  sysGroup.add(a);
  G.spaceTargets.push(a);
  objs.asteroids.push(a);
  return a;
}
export function removeAsteroid(a) {
  sysGroup.remove(a);
  const i = system.asteroids.indexOf(a); if (i >= 0) system.asteroids.splice(i, 1);
  const j = G.spaceTargets.indexOf(a); if (j >= 0) G.spaceTargets.splice(j, 1);
}
export function addToSystem(obj) { sysGroup.add(obj); }
export function removeFromSystem(obj) { sysGroup.remove(obj); }

// ---------- lights ----------
export const sunLight = new THREE.DirectionalLight(0xffffff, 1.6);

// ---------- warp streaks ----------
let streaks;
function buildStreaks() {
  const n = 400, pos = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 60, z = -Math.random() * 400;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    pos.set([x, y, z, x, y, z - 30], i * 6);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  streaks = new THREE.LineSegments(geo, spaceMat(new THREE.LineBasicMaterial({ color: 0xaaddff, transparent: true, opacity: 0, toneMapped: false, depthWrite: false })));
  streaks.renderOrder = -4;
  streaks.frustumCulled = false;
}

// ---------- init / update ----------
export const bridgeFrame = new THREE.Object3D(); // where the ship's centre sits in the room
const _S = new THREE.Matrix4(), _B = new THREE.Matrix4(), _U = new THREE.Matrix4(), _q = new THREE.Quaternion();

export function initSpace(scene) {
  buildGalaxy();
  buildSky();
  buildStreaks();
  scene.add(sky, universe, sunLight, sunLight.target, bridgeFrame);
  bridgeFrame.add(streaks);
  ship.pos.fromArray(S.shipPos);
  ship.quat.fromArray(S.shipQuat);
  loadSystem(S.system);
  if (!S.placed) placeNearStation();
}

export function placeNearStation() {
  const st = system.station;
  ship.pos.copy(st.position).add(new THREE.Vector3(0, 40, 520));
  ship.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(ship.pos, st.position, new THREE.Vector3(0, 1, 0)));
  ship.speed = 0; ship.throttle = 0;
  S.shipPos = ship.pos.toArray();
  S.shipQuat = ship.quat.toArray();
  S.placed = true;
}

export function shipForward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(ship.quat); }
export function toRoom(p, out = new THREE.Vector3()) { return out.copy(p).applyMatrix4(universe.matrixWorld); }

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _e = new THREE.Euler();
export function updateSpace(dt) {
  // flight input: sticks / joystick / keys
  const comfort = S.settings.turnSpeed;
  const inp = ship.input;
  if (ship.autopilot && !ship.warping) autopilot(dt);
  const pitch = inp.pitch * 0.5 * comfort, yaw = inp.yaw * 0.5 * comfort, roll = inp.roll * 0.7 * comfort;
  _q.setFromEuler(_e.set(pitch * dt, yaw * dt, roll * dt));
  ship.quat.multiply(_q).normalize();

  let boost = ship.boost && stat.boost > 1 && S.energy > 2 && !ship.warping;
  if (boost) S.energy -= 8 * dt;
  const target = ship.throttle * stat.maxSpeed * (boost ? stat.boost : 1);
  ship.speed = damp(ship.speed, target, boost ? 1.2 : 0.8, dt);
  shipForward(_v);
  ship.pos.addScaledVector(_v, ship.speed * dt);

  // don't fly into planets/the star
  if (system) {
    for (const p of [...system.planets, system.star]) {
      const r = (p.userData.target?.radius || p.geometry.parameters.radius) + 40;
      const d = ship.pos.distanceTo(p.position);
      if (d < r) {
        const out = _v2.copy(ship.pos).sub(p.position).normalize().multiplyScalar(r);
        ship.pos.copy(p.position).add(out);
        if (ship.speed > 20) { emit('toast', 'Proximity alert! Pulling up.', 'warn'); emit('say', 'Proximity alert.'); }
        ship.speed *= 0.3;
      }
    }
    system.station.rotateZ(system.station.userData.spin * dt);
    for (const a of system.asteroids) { a.rotation.x += a.userData.spin.x * dt; a.rotation.y += a.userData.spin.y * dt; }
  }

  // universe matrix = bridge * inverse(ship)
  bridgeFrame.updateMatrixWorld(true);
  _B.copy(bridgeFrame.matrixWorld);
  _S.compose(ship.pos, ship.quat, _v.set(1, 1, 1)).invert();
  _U.multiplyMatrices(_B, _S);
  universe.matrix.copy(_U);
  universe.matrixWorldNeedsUpdate = true;
  _U.setPosition(0, 0, 0);
  sky.matrix.copy(_U);
  sky.matrixWorldNeedsUpdate = true;
  universe.updateMatrixWorld(true);

  // sunlight comes from the star
  if (system) {
    toRoom(system.star.position, sunLight.position);
    sunLight.position.sub(bridgeFrame.position).setLength(50).add(bridgeFrame.position);
    sunLight.target.position.copy(bridgeFrame.position);
  }

  // warp
  if (ship.warping > 0) updateWarp(dt);
  S.shipPos = ship.pos.toArray();
  S.shipQuat = ship.quat.toArray();
}

function autopilot(dt) {
  const t = ship.autopilot;
  const tp = t.obj.getWorldPosition ? t.obj.position : t.obj;
  const to = _v.copy(tp).sub(ship.pos);
  const dist = to.length();
  const stopAt = (t.radius || 50) * 2.2 + 200;
  const desired = _q.setFromRotationMatrix(new THREE.Matrix4().lookAt(ship.pos, tp, _v2.set(0, 1, 0).applyQuaternion(ship.quat)));
  ship.quat.rotateTowards(desired, 0.5 * dt);
  const ang = ship.quat.angleTo(desired);
  ship.throttle = ang < 0.3 ? clamp((dist - stopAt) / 600, 0, 1) : 0.1;
  ship.boost = dist - stopAt > 2500 && ang < 0.1;
  if (dist < stopAt + 30) {
    ship.autopilot = null; ship.throttle = 0; ship.boost = false;
    S.toggles.autopilot = false;
    emit('toast', `Arrived at ${t.name}`);
    emit('say', `We have arrived at ${t.name}.`);
    emit('toggles');
  }
}

export function setAutopilot(target) {
  if (!target) { ship.autopilot = null; S.toggles.autopilot = false; emit('toggles'); return; }
  ship.autopilot = { obj: target.obj, name: target.name, radius: target.radius };
  S.toggles.autopilot = true;
  emit('toast', `Autopilot engaged: ${target.name}`);
  emit('say', `Course laid in for ${target.name}.`);
  emit('toggles');
}

// ---------- warp ----------
let warpDest = null;
export function canWarp(id) {
  const cur = galaxy[S.system], dst = galaxy[id];
  if (!dst || id === S.system) return 'Select another star system';
  if (systemDist(cur, dst) > stat.warpRange) return 'Out of warp range: upgrade the Warp Core';
  if (S.warpCells <= 0) return 'No warp cells: buy one in the shop';
  if (S.energy < 40) return 'Need 40 energy to charge the warp drive';
  if (ship.warping) return 'Already in warp';
  return null;
}
export function engageWarp(id) {
  const err = canWarp(id);
  if (err) { emit('toast', err, 'warn'); emit('say', err); emit('sfx', 'deny'); return false; }
  S.warpCells--; S.energy -= 40;
  warpDest = id;
  ship.warping = 0.0001;
  ship.autopilot = null;
  emit('sfx', 'warp');
  emit('say', `Engaging warp drive. Destination: ${galaxy[id].name}.`, true);
  emit('warpStart', galaxy[id]);
  return true;
}
function updateWarp(dt) {
  ship.warping += dt;
  const t = ship.warping;
  const mat = streaks.material;
  mat.opacity = clamp(t < 3.5 ? t / 1.5 : (5 - t) / 1.5, 0, 1);
  const pos = streaks.geometry.attributes.position;
  const sp = 300 + t * 300;
  for (let i = 0; i < pos.count; i += 2) {
    let z = pos.getZ(i) + sp * dt;
    if (z > 0) z -= 400;
    pos.setZ(i, z); pos.setZ(i + 1, z - 10 - t * 25);
  }
  pos.needsUpdate = true;
  ship.speed = t < 3 ? ship.speed + 2000 * dt : ship.speed;
  sky.visible = universe.visible = t < 2.6 || t > 3.4;
  if (t >= 3 && warpDest !== null) {
    S.system = warpDest;
    if (!S.discovered.includes(warpDest)) { S.discovered.push(warpDest); addCredits(150, 'discovery'); emit('toast', `New system discovered: ${galaxy[warpDest].name} (+150 cr)`); }
    S.stats.jumps++;
    warpDest = null;
    loadSystem(S.system);
    placeNearStation();
    ship.speed = 400;
    emit('sfx', 'warpExit');
    emit('arrived', galaxy[S.system]);
    save();
  }
  if (t > 5) { ship.warping = 0; mat.opacity = 0; ship.speed = 30; }
}

export function nearStation() {
  return system && system.station && ship.pos.distanceTo(system.station.position) < 900;
}
