// Combat: pirate ships outside, ship weapons (phasers, auto-turrets, torpedoes, point defense),
// shields and hull, boarding parties that teleport into your room, hull breaches and scrap.
import * as THREE from 'three';
import { G, emit, on, spaceMat, std, glow, glowTexture, rand, pick, clamp } from './core.js';
import { S, stat, addCredits, save } from './state.js';
import { universe, ship, system, addToSystem, removeFromSystem, shipForward, removeAsteroid, spawnAsteroid, bridgeFrame, placeNearStation, nearStation } from './space.js';
import { flash, burst, beam, hurtFlash } from './fx.js';
import { room, randomFloorPoint, walls } from './room.js';

export const enemies = [];
const spaceBolts = [];
const torpedoes = [];
const crates = [];
export const boarders = [];
export const roomBolts = [];
export const breaches = [];
export const scrap = [];
G.target = null;
G.blockers = []; // riot shields etc.

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

// ---------- enemy ships ----------
const ENEMY = {
  raider: { name: 'Pirate Raider', hp: 60, speed: 150, turn: 1.4, dmg: 6, rate: 1.1, reward: 120, color: 0xff3322, scale: 1 },
  gunship: { name: 'Pirate Gunship', hp: 240, speed: 85, turn: 0.7, dmg: 14, rate: 2.0, reward: 320, color: 0xff8800, scale: 2.2 },
  shuttle: { name: 'Boarding Shuttle', hp: 130, speed: 110, turn: 0.9, dmg: 0, rate: 99, reward: 220, color: 0xcc33ff, scale: 1.6 },
};

function buildEnemyMesh(type) {
  const d = ENEMY[type];
  const g = new THREE.Group();
  const hullM = spaceMat(new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.8, roughness: 0.35 }));
  const accent = spaceMat(new THREE.MeshStandardMaterial({ color: d.color, emissive: d.color, emissiveIntensity: 0.6 }));
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.4, 8, 6).rotateX(-Math.PI / 2), hullM);
  g.add(body);
  if (type === 'shuttle') {
    const pod = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 7), hullM); g.add(pod);
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2, 0.3), accent); door.position.z = -3.6; g.add(door);
  } else {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(type === 'gunship' ? 9 : 11, 0.3, 2.6), hullM); wing.position.z = 1.5; g.add(wing);
    for (const sx of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.4, 2.2), accent); fin.position.set(sx * 5.2, 0.8, 2); g.add(fin);
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 3).rotateX(Math.PI / 2), hullM); gun.position.set(sx * 3, -0.3, -1.5); g.add(gun);
    }
  }
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 8), spaceMat(glow(d.color))); cockpit.position.set(0, 0.7, -1.5); g.add(cockpit);
  const eng = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff7744, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
  eng.scale.setScalar(5); eng.position.z = 4.5; g.add(eng);
  const beacon = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color: d.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6, toneMapped: false })));
  beacon.scale.setScalar(26); g.add(beacon);
  g.scale.setScalar(d.scale);
  return g;
}

export function spawnEnemy(type, pos) {
  const d = ENEMY[type];
  const obj = buildEnemyMesh(type);
  obj.position.copy(pos);
  obj.quaternion.setFromRotationMatrix(_m.lookAt(pos, ship.pos, _v.set(0, 1, 0)));
  addToSystem(obj);
  const e = { type, d, obj, hp: d.hp, maxHp: d.hp, fireT: rand(1, 3), offset: new THREE.Vector3().randomDirection().multiplyScalar(rand(120, 320)), offT: rand(3, 6), docked: 0 };
  obj.userData.target = { kind: 'enemy', name: d.name, hostile: true, obj, radius: 8 * d.scale, enemy: e };
  obj.userData.systemObject = true;
  G.spaceTargets.push(obj);
  enemies.push(e);
  return e;
}

function killEnemy(e, reward = true) {
  const i = enemies.indexOf(e); if (i < 0) return;
  enemies.splice(i, 1);
  const j = G.spaceTargets.indexOf(e.obj); if (j >= 0) G.spaceTargets.splice(j, 1);
  removeFromSystem(e.obj);
  if (G.target?.enemy === e) G.target = null;
  if (!reward) return;
  flash(e.obj.position, { color: 0xffaa44, scale: 70 * e.d.scale, life: 0.9, parent: universe, space: true });
  burst(e.obj.position, { color: 0xff8844, count: 40, speed: 60, size: 3, life: 1.4, parent: universe, space: true });
  emit('sfx', 'explosion');
  addCredits(e.d.reward, 'kill');
  S.stats.kills++;
  emit('toast', `${e.d.name} destroyed  +${e.d.reward} cr`);
  if (Math.random() < 0.7) spawnCrate(e.obj.position);
  if (!enemies.length) endEncounter();
}

export function damageTarget(t, dmg, at) {
  if (t.kind === 'enemy') {
    const e = t.enemy;
    e.hp -= dmg;
    flash(at || e.obj.position, { color: 0xffcc66, scale: 18, life: 0.25, parent: universe, space: true });
    if (e.hp <= 0) killEnemy(e);
  } else if (t.kind === 'asteroid') {
    t.hp -= dmg;
    flash(at || t.obj.position, { color: 0xffddaa, scale: 14, life: 0.25, parent: universe, space: true });
    if (t.hp <= 0) {
      burst(t.obj.position, { color: 0xbba48a, count: 30, speed: 25, size: 2.5, life: 1.2, parent: universe, space: true });
      emit('sfx', 'smallExplosion');
      addCredits(t.ore, 'ore');
      emit('toast', `Asteroid mined: +${t.ore} cr of ore`);
      if (t.radius > 10) for (let k = 0; k < 2; k++) spawnAsteroid(t.obj.position.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(t.radius)), t.radius * 0.45);
      if (G.target === t) G.target = null;
      removeAsteroid(t.obj);
    }
  }
}

// ---------- salvage crates ----------
function spawnCrate(pos) {
  const c = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), spaceMat(new THREE.MeshStandardMaterial({ color: 0x8899aa, emissive: 0x2266ff, emissiveIntensity: 0.4, metalness: 0.7 })));
  c.position.copy(pos);
  const g = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x44aaff, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
  g.scale.setScalar(12); c.add(g);
  addToSystem(c);
  crates.push({ obj: c, value: Math.round(rand(40, 140)), t: 0 });
}

// ---------- ship weapons ----------
function hardpoint(side) {
  return _v2.set(side * 9, -3, -6).applyQuaternion(ship.quat).add(ship.pos).clone();
}
function validTarget(t) { return t && t.obj && t.obj.parent; }

function nearestHostile(range = 1e9) {
  let best = null, bd = range;
  for (const e of enemies) { const d = e.obj.position.distanceTo(ship.pos); if (d < bd) { bd = d; best = e; } }
  return best;
}

let phaserCd = 0, turretCd = 0, side = 1;
export function firePhasers() {
  if (ship.warping) return;
  if (!S.toggles.weapons) { emit('toast', 'Weapons are not armed (flip the WEAPONS switch)', 'warn'); emit('sfx', 'deny'); return; }
  if (phaserCd > 0) return;
  if (S.energy < 8) { emit('toast', 'Not enough energy for phasers', 'warn'); emit('sfx', 'deny'); return; }
  let t = validTarget(G.target) ? G.target : null;
  if (!t || (t.kind !== 'enemy' && t.kind !== 'asteroid')) { const e = nearestHostile(2500); t = e ? e.obj.userData.target : null; if (t) G.target = t; }
  if (!t) { emit('toast', 'No target in range. Point at a ship or asteroid and pull the trigger to lock on.'); emit('sfx', 'deny'); return; }
  const d = t.obj.position.distanceTo(ship.pos);
  if (d > 2500) { emit('toast', 'Target out of phaser range (2500)'); emit('sfx', 'deny'); return; }
  S.energy -= 8;
  phaserCd = stat.phaserCooldown;
  side = -side;
  beam(hardpoint(side), t.obj.position, { color: 0xff6a20, width: 0.9, life: 0.35, parent: universe, space: true });
  emit('sfx', 'phaser');
  damageTarget(t, stat.phaserDmg * 1.5);
}

function turretFire(e) {
  S.energy -= 3;
  side = -side;
  beam(hardpoint(side), e.obj.position, { color: 0x30c0ff, width: 0.5, life: 0.25, parent: universe, space: true });
  emit('sfx', 'rifle');
  damageTarget(e.obj.userData.target, stat.phaserDmg * 0.6);
}

export function fireTorpedo() {
  if (ship.warping) return;
  if (!S.toggles.weapons) { emit('toast', 'Weapons are not armed', 'warn'); emit('sfx', 'deny'); return; }
  if (S.missiles <= 0) { emit('toast', 'Torpedo bay empty: buy more in the shop', 'warn'); emit('sfx', 'deny'); return; }
  let t = validTarget(G.target) ? G.target : null;
  if (!t || (t.kind !== 'enemy' && t.kind !== 'asteroid')) { const e = nearestHostile(4000); t = e ? e.obj.userData.target : null; if (t) G.target = t; }
  if (!t) { emit('toast', 'No torpedo target'); emit('sfx', 'deny'); return; }
  S.missiles--;
  const m = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff3355, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
  m.scale.setScalar(8);
  m.position.copy(ship.pos).addScaledVector(shipForward(_v), 15);
  addToSystem(m);
  torpedoes.push({ obj: m, vel: shipForward(new THREE.Vector3()).multiplyScalar(ship.speed + 120), target: t, life: 12, trailT: 0 });
  emit('sfx', 'torpedo');
}

export function cycleTarget() {
  const list = [...enemies.map((e) => e.obj.userData.target)];
  if (!list.length && system) list.push(...system.asteroids.map((a) => a.userData.target), ...system.planets.map((p) => p.userData.target), system.station.userData.target);
  if (!list.length) return;
  list.sort((a, b) => a.obj.position.distanceTo(ship.pos) - b.obj.position.distanceTo(ship.pos));
  const i = list.indexOf(G.target);
  G.target = list[(i + 1) % list.length];
  emit('sfx', 'boop');
  emit('toast', `Target: ${G.target.name}`);
}
on('target', (t) => { G.target = t; emit('sfx', 'boop'); emit('toast', `Target locked: ${t.name}`); });
on('firePhasers', firePhasers);
on('fireTorpedo', fireTorpedo);
on('nextTarget', cycleTarget);

// target bracket shown around the current target
const bracket = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: bracketTexture(), color: 0xff5040, transparent: true, depthTest: false, depthWrite: false, toneMapped: false })));
bracket.renderOrder = 10;
function bracketTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 6;
  for (const [x, y, dx, dy] of [[8, 8, 1, 1], [120, 8, -1, 1], [8, 120, 1, -1], [120, 120, -1, -1]]) {
    g.beginPath(); g.moveTo(x, y + dy * 30); g.lineTo(x, y); g.lineTo(x + dx * 30, y); g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------- shields ----------
const shieldMat = spaceMat(new THREE.MeshBasicMaterial({ color: 0x40b0ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, wireframe: true }));
const shieldBubble = new THREE.Mesh(new THREE.IcosahedronGeometry(16, 3), shieldMat);
let shieldGlow = 0;

function hitShip(dmg, fromPos) {
  if (S.toggles.shields && S.shield > 0) {
    S.shield = Math.max(0, S.shield - dmg);
    shieldGlow = 0.6;
    const at = _v.copy(fromPos).sub(ship.pos).setLength(16).add(ship.pos);
    flash(at, { color: 0x66ccff, scale: 22, life: 0.4, parent: universe, space: true });
    emit('sfx', 'shieldHit');
    if (S.shield === 0) { emit('toast', 'Shields down!', 'alert'); emit('say', 'Warning. Shields are down.', true); }
  } else {
    S.hull = Math.max(0, S.hull - dmg);
    emit('sfx', 'hullHit');
    hurtFlash(0.25, 0xff6600);
    emit('hullHit', dmg);
    for (const p of [G.pointers.left, G.pointers.right]) p.haptic(0.8, 120);
    if (Math.random() < dmg / 25) spawnBreach();
    if (Math.random() < 0.12 && !boarders.length && G.time - lastBoarding > 40) startBoarding(1 + Math.floor(Math.random() * 2));
    if (S.hull <= 0) shipDestroyed();
    else if (S.hull < stat.hullMax * 0.3) emit('say', 'Hull integrity critical.');
  }
}

function shipDestroyed() {
  emit('sfx', 'explosion');
  hurtFlash(0.6, 0xffffff);
  for (const e of [...enemies]) killEnemy(e, false);
  for (const b of [...boarders]) removeBoarder(b);
  const lost = Math.round(S.credits * 0.2);
  S.credits -= lost;
  S.hull = stat.hullMax * 0.5; S.shield = 0;
  placeNearStation();
  encounter.active = false;
  S.toggles.redAlert = false;
  emit('toggles');
  emit('toast', `Hull failure! Emergency tow to the station. Repair costs: ${lost} cr`, 'alert');
  emit('say', 'Hull failure. Emergency beacon activated. We have been towed to the station.', true);
}

// ---------- encounters ----------
const encounter = { timer: 70, active: false, lastClear: 0 };
let lastBoarding = -999;
export function startEncounter(force = false) {
  if (ship.warping) return;
  const sys = system.sys;
  const danger = sys.danger + (S.settings.encounters === 'hard' ? 2 : 0);
  const nR = clamp(1 + Math.floor(Math.random() * (1 + danger / 1.5)), 1, 6);
  const dir = shipForward(new THREE.Vector3()).add(new THREE.Vector3().randomDirection().multiplyScalar(0.8)).normalize();
  const center = ship.pos.clone().addScaledVector(dir, rand(1100, 1500));
  for (let i = 0; i < nR; i++) spawnEnemy('raider', center.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(120)));
  if (danger >= 3 || (force && Math.random() < 0.5)) spawnEnemy('gunship', center.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(200)));
  if (Math.random() < (S.settings.encounters === 'hard' ? 0.6 : 0.4) || force === 'boarding') spawnEnemy('shuttle', center.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(150)));
  encounter.active = true;
  S.toggles.redAlert = true;
  emit('toggles');
  emit('sfx', 'alarm');
  emit('toast', `RED ALERT: ${enemies.length} hostile ship${enemies.length > 1 ? 's' : ''} inbound!`, 'alert');
  emit('say', 'Red alert. Hostile ships detected. All hands to battle stations.', true);
  if (!G.target || G.target.kind !== 'enemy') G.target = enemies[0].obj.userData.target;
}

function endEncounter() {
  encounter.active = false;
  encounter.timer = nextEncounterDelay();
  setTimeout(() => {
    if (!enemies.length && !boarders.length) { S.toggles.redAlert = false; emit('toggles'); }
  }, 3000);
  emit('say', 'All hostiles neutralized. Good work, captain.', true);
  emit('toast', 'Threat neutralized');
  save();
}
function nextEncounterDelay() {
  const m = S.settings.encounters === 'hard' ? 0.5 : 1;
  return rand(70, 140) * m;
}

// ---------- boarding ----------
const boarderMats = {
  armor: std(0x2d3138, { metalness: 0.7, roughness: 0.4 }),
  accent: std(0x8a1c1c, { metalness: 0.4, roughness: 0.5 }),
  visor: glow(0xff2a2a),
};
function buildBoarder() {
  const g = new THREE.Group();
  const M = boarderMats;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.58, 0.26), M.armor); torso.position.y = 1.2; g.add(torso);
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 0.28), M.accent); belt.position.y = 0.92; g.add(belt);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.26), M.armor); head.position.y = 1.65; g.add(head);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.02), M.visor); visor.position.set(0, 1.67, -0.135); g.add(visor);
  const legs = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.12, 0.9, 0);
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.88, 0.17), M.armor); l.position.y = -0.44; leg.add(l);
    g.add(leg); legs.push(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.13), M.accent); arm.position.set(sx * 0.3, 1.2, sx > 0 ? -0.12 : 0); if (sx > 0) arm.rotation.x = -1.2; g.add(arm);
  }
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.45), M.armor); gun.position.set(0.3, 1.1, -0.4); g.add(gun);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0.3, 1.12, -0.65); g.add(muzzle);
  g.userData.legs = legs; g.userData.muzzle = muzzle;
  return g;
}

export function startBoarding(n = 2) {
  if (!room.ready) return;
  lastBoarding = G.time;
  emit('sfx', 'alarm');
  emit('toast', 'INTRUDER ALERT! Boarders are teleporting aboard!', 'alert');
  emit('say', 'Intruder alert! Hostile boarding party detected on the bridge.', true);
  S.toggles.redAlert = true; emit('toggles');
  for (let i = 0; i < n; i++) setTimeout(() => spawnBoarder(), 600 + i * 900);
}

function spawnBoarder() {
  let p = null;
  for (let k = 0; k < 20; k++) {
    const c = randomFloorPoint(0.6);
    if (c.distanceTo(_v.set(G.head.x, room.floorY, G.head.z)) > 1.8) { p = c; break; }
  }
  p ||= randomFloorPoint(0.6);
  const obj = buildBoarder();
  obj.position.copy(p);
  G.scene.add(obj);
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2.4, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xff3344, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  col.position.copy(p).setY(p.y + 1.2);
  G.scene.add(col);
  const b = { obj, hp: 70, fireT: rand(1.5, 2.5), strafe: Math.random() < 0.5 ? 1 : -1, strafeT: 2, spawn: 1, col, walk: 0, meleeT: 0, hitCd: new Map() };
  obj.scale.setScalar(0.01);
  boarders.push(b);
  S.stats.boarders++;
  emit('sfx', 'teleport');
}

function removeBoarder(b) {
  const i = boarders.indexOf(b); if (i >= 0) boarders.splice(i, 1);
  G.scene.remove(b.obj);
  if (b.col) G.scene.remove(b.col);
}

export function damageBoarder(b, dmg, at) {
  if (b.hp <= 0) return;
  b.hp -= dmg;
  burst(at || b.obj.position.clone().setY(b.obj.position.y + 1.2), { color: 0xffaa33, count: 12, speed: 2, size: 0.04, life: 0.4 });
  if (b.hp <= 0) {
    burst(b.obj.position.clone().setY(b.obj.position.y + 1), { color: 0xff5522, count: 40, speed: 3, size: 0.06, life: 0.9, gravity: 4 });
    flash(b.obj.position.clone().setY(b.obj.position.y + 1), { color: 0xff7733, scale: 2.5, life: 0.5 });
    emit('sfx', 'smallExplosion');
    addCredits(80, 'boarder');
    emit('toast', 'Boarder neutralized  +80 cr');
    spawnScrap(b.obj.position);
    removeBoarder(b);
    if (!boarders.length) {
      emit('say', 'Bridge secure.');
      if (!enemies.length) setTimeout(() => { if (!enemies.length && !boarders.length) { S.toggles.redAlert = false; emit('toggles'); } }, 2500);
    }
  }
}

// Checks whether a point is inside a boarder's body; returns the boarder.
export function boarderAt(p, pad = 0) {
  for (const b of boarders) {
    const o = b.obj.position;
    const dy = p.y - o.y;
    if (dy < 0 || dy > 1.85) continue;
    const r = (dy > 1.5 ? 0.17 : 0.28) + pad;
    if (Math.hypot(p.x - o.x, p.z - o.z) < r) return b;
  }
  return null;
}

// segment (a→b) vs boarders, for sword swings
export function boardersOnSegment(a, b, pad = 0.05) {
  const out = [];
  for (let i = 0; i <= 6; i++) {
    const p = _v.copy(a).lerp(b, i / 6);
    const hit = boarderAt(p, pad);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

export function explode(pos, radius, dmg) {
  flash(pos, { color: 0x88ccff, scale: radius * 2.5, life: 0.5 });
  burst(pos, { color: 0x66bbff, count: 60, speed: 5, size: 0.07, life: 0.8 });
  emit('sfx', 'explosion');
  for (const b of [...boarders]) {
    const d = b.obj.position.clone().setY(b.obj.position.y + 1).distanceTo(pos);
    if (d < radius) damageBoarder(b, dmg * (1 - d / radius * 0.5));
  }
  if (G.head.distanceTo(pos) < radius * 0.7) damagePlayer(15);
}

// ---------- room bolts ----------
const boltGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.28, 6).rotateX(Math.PI / 2);
const boltMats = { player: glow(0x44ddff), enemy: glow(0xff3322), bot: glow(0x66ff88) };
export function fireRoomBolt(from, dir, { owner = 'player', dmg = 20, speed = 32, color } = {}) {
  const m = new THREE.Mesh(boltGeo, color ? glow(color) : boltMats[owner]);
  m.position.copy(from);
  m.quaternion.setFromUnitVectors(_v.set(0, 0, 1), dir);
  G.scene.add(m);
  const glowS = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: m.material.color, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  glowS.scale.setScalar(0.12); m.add(glowS);
  roomBolts.push({ m, vel: dir.clone().multiplyScalar(speed), owner, dmg, life: 2.5 });
}

function updateRoomBolts(dt) {
  const b = room.bounds;
  for (let i = roomBolts.length - 1; i >= 0; i--) {
    const r = roomBolts[i];
    r.life -= dt;
    const p = r.m.position;
    // sub-step so fast bolts can't tunnel through bodies
    let dead = false;
    for (let s = 0; s < 3 && !dead; s++) {
      p.addScaledVector(r.vel, dt / 3);
      if (r.owner !== 'enemy') {
        const hit = boarderAt(p);
        if (hit) { damageBoarder(hit, r.dmg, p.clone()); dead = true; }
      } else {
        for (const bl of G.blockers) if (bl.blocks(p)) { dead = true; burst(p, { color: 0x88ccff, count: 10, speed: 2, size: 0.03, life: 0.3 }); emit('sfx', 'shieldHit'); bl.onBlock?.(); }
        const head = G.head;
        const dy = head.y - p.y;
        if (!dead && dy > -0.15 && dy < 0.75 && Math.hypot(p.x - head.x, p.z - head.z) < (dy < 0.2 ? 0.16 : 0.24)) { damagePlayer(r.dmg); dead = true; }
      }
    }
    const out = p.x < b.min.x - 0.1 || p.x > b.max.x + 0.1 || p.z < b.min.z - 0.1 || p.z > b.max.z + 0.1 || p.y < room.floorY || p.y > room.floorY + room.height;
    if (out && !dead) { burst(p, { color: r.m.material.color.getHex(), count: 8, speed: 1.5, size: 0.03, life: 0.3 }); dead = true; }
    if (dead || r.life <= 0) { G.scene.remove(r.m); roomBolts.splice(i, 1); }
  }
}

// ---------- the player ----------
let lastHurt = -99, invuln = 0;
export function damagePlayer(dmg) {
  if (invuln > 0) return;
  S.hp -= dmg;
  lastHurt = G.time;
  hurtFlash(0.45);
  emit('sfx', 'hurt');
  for (const p of [G.pointers.left, G.pointers.right]) p.haptic(1, 80);
  if (S.hp <= 0) {
    const lost = Math.round(S.credits * 0.15);
    S.credits -= lost;
    S.hp = stat.hpMax * 0.6;
    invuln = 5;
    for (const b of [...boarders]) removeBoarder(b);
    hurtFlash(0.6, 0xffffff);
    emit('toast', `You were knocked out! The boarders looted ${lost} cr and fled.`, 'alert');
    emit('say', 'Captain down. Emergency medical teleport complete.', true);
  }
}
export function healPlayer(n) { S.hp = Math.min(stat.hpMax, S.hp + n); }

// ---------- breaches & scrap ----------
const breachTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffb040'; g.lineWidth = 5; g.shadowColor = '#ff6000'; g.shadowBlur = 12;
  for (let k = 0; k < 6; k++) {
    g.beginPath(); g.moveTo(64, 64);
    let x = 64, y = 64; const a = (k / 6) * Math.PI * 2 + Math.random();
    for (let s = 0; s < 5; s++) { x += Math.cos(a + (Math.random() - 0.5)) * 11; y += Math.sin(a + (Math.random() - 0.5)) * 11; g.lineTo(x, y); }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

export function spawnBreach() {
  const ws = walls();
  if (!ws.length || breaches.length >= 6) return;
  const w = pick(ws);
  w.geometry.computeBoundingBox();
  const bb = w.geometry.boundingBox;
  const local = new THREE.Vector3(THREE.MathUtils.lerp(bb.min.x, bb.max.x, rand(0.2, 0.8)), 0, THREE.MathUtils.lerp(bb.min.z, bb.max.z, rand(0.2, 0.8)));
  const p = local.applyMatrix4(w.matrixWorld);
  p.y = THREE.MathUtils.clamp(p.y, room.floorY + 0.5, room.floorY + 1.9);
  const n = w.userData.surface.normal;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: breachTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  m.position.copy(p).addScaledVector(n, 0.02);
  m.quaternion.setFromUnitVectors(_v.set(0, 0, 1), n);
  G.scene.add(m);
  const br = { m, hp: 100, sparkT: 0, normal: n.clone() };
  m.userData.breach = br;
  breaches.push(br);
  emit('toast', 'Hull breach detected! Use the Fusion Welder to repair it.', 'warn');
}
export function repairBreach(br, amount) {
  br.hp -= amount;
  if (Math.random() < 0.3) burst(br.m.position, { color: 0xaaddff, count: 4, speed: 1.2, size: 0.025, life: 0.25 });
  if (br.hp <= 0) {
    G.scene.remove(br.m);
    breaches.splice(breaches.indexOf(br), 1);
    S.hull = Math.min(stat.hullMax, S.hull + 8);
    emit('toast', 'Breach sealed');
    emit('sfx', 'scanDone');
  }
}
on('repairAll', () => { for (const br of [...breaches]) repairBreach(br, 999); });

const scrapMat = std(0x777066, { metalness: 0.8, roughness: 0.6 });
function spawnScrap(pos) {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(rand(0.05, 0.15), rand(0.02, 0.06), rand(0.05, 0.15)), scrapMat);
    b.position.set(rand(-0.15, 0.15), 0.02, rand(-0.15, 0.15)); b.rotation.y = rand(0, 3);
    g.add(b);
  }
  g.position.copy(pos).setY(room.floorY);
  G.scene.add(g);
  const s = { obj: g, value: 30 };
  const ctl = { press: () => collectScrap(s), setHover() {} };
  g.userData.control = ctl;
  G.interactables.push(g);
  scrap.push(s);
}
export function collectScrap(s, by = 'you') {
  const i = scrap.indexOf(s); if (i < 0) return;
  scrap.splice(i, 1);
  G.scene.remove(s.obj);
  const j = G.interactables.indexOf(s.obj); if (j >= 0) G.interactables.splice(j, 1);
  addCredits(s.value, 'scrap');
  emit('sfx', 'scrap');
  emit('toast', `${by === 'you' ? 'Scrap salvaged' : 'Custodian Bot salvaged scrap'}  +${s.value} cr`);
}

// ---------- update ----------
const _toShip = new THREE.Vector3();
export function updateCombat(dt) {
  phaserCd = Math.max(0, phaserCd - dt);
  invuln = Math.max(0, invuln - dt);

  // encounter director
  const enc = S.settings.encounters;
  if (enc !== 'off' && !encounter.active && !ship.warping && room.ready && !nearStation()) {
    encounter.timer -= dt;
    if (encounter.timer <= 0) { startEncounter(); encounter.timer = nextEncounterDelay(); }
  }

  // enemies
  const cloaked = S.toggles.cloak && S.energy > 1;
  for (const e of [...enemies]) {
    const o = e.obj;
    e.offT -= dt;
    if (e.offT <= 0) { e.offset.randomDirection().multiplyScalar(cloaked ? rand(800, 1200) : rand(120, 340)); e.offT = rand(3, 6); }
    let goal;
    if (e.type === 'shuttle' && !cloaked) goal = _v.copy(ship.pos).addScaledVector(_toShip.copy(o.position).sub(ship.pos).normalize(), 30);
    else goal = _v.copy(ship.pos).add(e.offset);
    const desired = _q.setFromRotationMatrix(_m.lookAt(o.position, goal, _v2.set(0, 1, 0)));
    o.quaternion.rotateTowards(desired, e.d.turn * dt);
    const fwd = _v2.set(0, 0, -1).applyQuaternion(o.quaternion);
    const distShip = o.position.distanceTo(ship.pos);
    let spd = e.d.speed;
    if (e.type === 'shuttle' && distShip < 80) spd = Math.max(5, distShip - 30);
    // follow the player's ship a bit so fights don't get left behind
    o.position.addScaledVector(fwd, spd * dt).addScaledVector(shipForward(_toShip), ship.speed * dt * 0.85);
    if (e.type === 'shuttle' && distShip < 45 && !cloaked) {
      e.docked += dt;
      if (e.docked > 2.5) {
        emit('toast', 'Boarding shuttle has latched onto the hull!', 'alert');
        startBoarding(2 + (system.sys.danger > 3 ? 1 : 0));
        killEnemy(e, false);
        if (!enemies.length) endEncounter();
        continue;
      }
    }
    e.fireT -= dt;
    if (e.d.dmg && e.fireT <= 0 && !cloaked && distShip < 1000) {
      const toS = _toShip.copy(ship.pos).sub(o.position).normalize();
      if (fwd.dot(toS) > 0.8) {
        e.fireT = e.d.rate * rand(0.8, 1.3);
        const bolt = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xff3020, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
        bolt.scale.setScalar(5 * e.d.scale);
        bolt.position.copy(o.position);
        addToSystem(bolt);
        spaceBolts.push({ obj: bolt, vel: toS.clone().multiplyScalar(420), dmg: e.d.dmg, life: 4, pdChecked: false });
        if (distShip < 500) emit('sfx', 'enemyFire');
      } else e.fireT = 0.2;
    }
  }

  // enemy bolts
  for (let i = spaceBolts.length - 1; i >= 0; i--) {
    const b = spaceBolts[i];
    b.life -= dt;
    b.obj.position.addScaledVector(b.vel, dt);
    const d = b.obj.position.distanceTo(ship.pos);
    let dead = b.life <= 0;
    if (!dead && !b.pdChecked && d < 200) {
      b.pdChecked = true;
      if (Math.random() < stat.pointDefense) {
        beam(hardpoint(Math.random() < 0.5 ? 1 : -1), b.obj.position, { color: 0x99ff66, width: 0.3, life: 0.15, parent: universe, space: true });
        flash(b.obj.position, { color: 0x99ff66, scale: 12, life: 0.3, parent: universe, space: true });
        dead = true;
      }
    }
    if (!dead && d < 16) { hitShip(b.dmg, b.obj.position); dead = true; }
    if (dead) { removeFromSystem(b.obj); spaceBolts.splice(i, 1); }
  }

  // torpedoes
  for (let i = torpedoes.length - 1; i >= 0; i--) {
    const t = torpedoes[i];
    t.life -= dt;
    let dead = t.life <= 0;
    if (validTarget(t.target)) {
      const want = _v.copy(t.target.obj.position).sub(t.obj.position);
      const dist = want.length();
      want.normalize().multiplyScalar(Math.max(500, t.vel.length() + 300 * dt));
      t.vel.lerp(want, 1 - Math.exp(-3 * dt));
      if (dist < (t.target.radius || 8) + 6) {
        dead = true;
        flash(t.obj.position, { color: 0xff6688, scale: 60, life: 0.6, parent: universe, space: true });
        damageTarget(t.target, stat.missileDmg, t.obj.position);
        emit('sfx', 'explosion');
      }
    }
    t.obj.position.addScaledVector(t.vel, dt);
    t.trailT -= dt;
    if (t.trailT <= 0) { t.trailT = 0.05; flash(t.obj.position, { color: 0xff3355, scale: 5, life: 0.5, parent: universe, space: true }); }
    if (dead) { removeFromSystem(t.obj); torpedoes.splice(i, 1); }
  }

  // auto turrets
  if (S.toggles.weapons && stat.turretRate > 0 && S.energy > 5 && !ship.warping) {
    turretCd -= dt;
    if (turretCd <= 0) {
      const e = nearestHostile(1500);
      if (e) { turretFire(e); turretCd = stat.turretRate; } else turretCd = 0.3;
    }
  }

  // salvage crates
  for (let i = crates.length - 1; i >= 0; i--) {
    const c = crates[i];
    c.t += dt;
    c.obj.rotation.x += dt * 0.5; c.obj.rotation.y += dt * 0.7;
    const d = c.obj.position.distanceTo(ship.pos);
    const tractor = S.upgrades.tractor && S.toggles.tractor;
    if (tractor && d < 1200) {
      c.obj.position.lerp(ship.pos, 1 - Math.exp(-0.8 * dt));
      if (Math.random() < dt * 8) beam(ship.pos.clone().addScaledVector(shipForward(_v), 10), c.obj.position, { color: 0x44aaff, width: 0.3, life: 0.1, parent: universe, space: true });
    }
    if (d < 40) {
      removeFromSystem(c.obj); crates.splice(i, 1);
      addCredits(c.value, 'salvage');
      emit('sfx', 'coin');
      emit('toast', `Salvage recovered  +${c.value} cr`);
    } else if (c.t > 120) { removeFromSystem(c.obj); crates.splice(i, 1); }
  }

  // shields: regen + visual
  if (S.toggles.shields) {
    S.shield = Math.min(stat.shieldMax, S.shield + stat.shieldRegen * dt * (encounter.active ? 0.6 : 1.5));
    S.energy -= 0.6 * dt;
  }
  shieldGlow = Math.max(0, shieldGlow - dt);
  shieldMat.opacity = (S.toggles.shields && S.shield > 0 ? 0.012 : 0) + shieldGlow * 0.5;
  shieldBubble.visible = shieldMat.opacity > 0.005;

  // cloak drains energy
  if (S.toggles.cloak) {
    if (!S.upgrades.cloak) { S.toggles.cloak = false; emit('toast', 'No cloaking device installed', 'warn'); emit('toggles'); }
    else { S.energy -= 6 * dt; if (S.energy <= 1) { S.toggles.cloak = false; emit('toast', 'Cloak failed: out of energy', 'warn'); emit('toggles'); } }
  }

  // energy & hull regen
  S.energy = Math.min(stat.energyMax, S.energy + stat.energyRegen * dt);
  S.hull = Math.min(stat.hullMax, S.hull + stat.hullRegen * dt - 0.4 * breaches.length * dt);
  if (S.hull <= 0) shipDestroyed();
  if (G.time - lastHurt > 5) healPlayer(2 * dt);

  // target bracket
  if (validTarget(G.target)) {
    if (!bracket.parent) addToSystem(bracket);
    const tp = G.target.obj.position;
    bracket.position.copy(tp);
    const dist = tp.distanceTo(ship.pos);
    bracket.scale.setScalar(Math.max((G.target.radius || 10) * 2.6, dist * 0.06));
    bracket.material.color.setHex(G.target.hostile ? 0xff5040 : 0x40ff90);
  } else {
    if (bracket.parent) removeFromSystem(bracket);
    if (G.target) G.target = null;
  }

  updateBoarders(dt);
  updateRoomBolts(dt);
  for (const br of breaches) {
    br.sparkT -= dt;
    br.m.material.opacity = 0.6 + Math.random() * 0.4;
    if (br.sparkT <= 0) { br.sparkT = rand(0.2, 0.8); burst(br.m.position, { color: 0xffbb55, count: 6, speed: 1.5, size: 0.025, life: 0.5, gravity: 5 }); }
  }
}

function updateBoarders(dt) {
  const player = _v.set(G.head.x, room.floorY, G.head.z);
  for (const b of [...boarders]) {
    const o = b.obj;
    if (b.spawn > 0) {
      b.spawn -= dt;
      o.scale.setScalar(Math.min(1, 1 - b.spawn + 0.01));
      b.col.material.opacity = Math.max(0, b.spawn) * 0.6;
      if (b.spawn <= 0) { G.scene.remove(b.col); b.col = null; o.scale.setScalar(1); }
      continue;
    }
    const to = _v2.copy(player).sub(o.position); to.y = 0;
    const dist = to.length();
    to.normalize();
    o.rotation.y = Math.atan2(-to.x, -to.z);
    b.strafeT -= dt;
    if (b.strafeT <= 0) { b.strafe = -b.strafe; b.strafeT = rand(1.5, 3); }
    let move = 0;
    const step = new THREE.Vector3();
    if (dist > 3.2) { step.copy(to); move = 1; } else if (dist < 1.6 && dist > 0.9) { step.copy(to).multiplyScalar(-0.5); move = 1; }
    step.add(new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(b.strafe * 0.5));
    const np = o.position.clone().addScaledVector(step, 0.9 * dt);
    const bb = room.bounds;
    np.x = clamp(np.x, bb.min.x + 0.35, bb.max.x - 0.35); np.z = clamp(np.z, bb.min.z + 0.35, bb.max.z - 0.35);
    o.position.copy(np);
    b.walk += dt * (move || 0.6) * 7;
    const legs = o.userData.legs;
    legs[0].rotation.x = Math.sin(b.walk) * 0.5; legs[1].rotation.x = -Math.sin(b.walk) * 0.5;
    // shoot
    b.fireT -= dt;
    if (b.fireT <= 0) {
      b.fireT = rand(1.8, 3.0);
      const m = o.userData.muzzle.getWorldPosition(new THREE.Vector3());
      const aim = G.head.clone().add(new THREE.Vector3(rand(-0.25, 0.25), rand(-0.3, 0.1), rand(-0.25, 0.25))).sub(m).normalize();
      fireRoomBolt(m, aim, { owner: 'enemy', dmg: 9, speed: 5.5 });
      emit('sfx', 'enemyFire');
    }
    if (dist < 0.9) { b.meleeT -= dt; if (b.meleeT <= 0) { b.meleeT = 1; damagePlayer(8); } }
  }
}

// a warp jump leaves every fight behind
on('system', () => {
  for (const e of [...enemies]) killEnemy(e, false);
  for (const arr of [spaceBolts, torpedoes, crates]) arr.length = 0;
  if (encounter.active) { encounter.active = false; encounter.timer = nextEncounterDelay(); }
  if (!boarders.length) { S.toggles.redAlert = false; emit('toggles'); }
});

export function initCombat() {
  bridgeFrame.add(shieldBubble);
  encounter.timer = 45;
}

export function encounterActive() { return encounter.active || boarders.length > 0; }
