// AI crew units. Room units walk/fly around your real room; space units fly outside the hull.
import * as THREE from 'three';
import { G, emit, on, std, glow, box, cyl, sphere, rand, damp, spaceMat, glowTexture, textSprite } from './core.js';
import { S, stat, addCredits } from './state.js';
import { UNITS } from './catalog.js';
import { room, randomFloorPoint } from './room.js';
import { ship, system, addToSystem, universe } from './space.js';
import { enemies, boarders, breaches, scrap, repairBreach, collectScrap, fireRoomBolt, damageTarget, healPlayer } from './combat.js';
import { beam, burst } from './fx.js';
import { spawnMeal } from './items.js';
import { setMusic } from './audio.js';

const bots = [];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const white = std(0xe8edf2, { metalness: 0.3, roughness: 0.4 });
const steel = std(0x7d8792, { metalness: 0.8, roughness: 0.3 });
const darkM = std(0x22272e, { metalness: 0.5, roughness: 0.6 });

function nameTag(obj, text, y) {
  const s = textSprite(text, { size: 0.035, color: '#8ff', bg: 'rgba(0,10,20,0.5)' });
  s.position.y = y; s.material.depthTest = true; s.material.opacity = 0.85;
  obj.add(s);
}

class RoomBot {
  constructor(kind, obj, { speed = 0.6, fly = 0 } = {}) {
    this.kind = kind; this.obj = obj; this.speed = speed; this.fly = fly;
    this.goal = null; this.wait = rand(0, 2); this.t = rand(0, 10);
    obj.position.copy(randomFloorPoint(0.6)); obj.position.y = room.floorY + fly;
    nameTag(obj, UNITS[kind].name, fly ? 0.32 : obj.userData.h || 0.5);
    G.scene.add(obj);
  }
  moveTo(target, dt, stopAt = 0.05) {
    _v.copy(target).sub(this.obj.position);
    if (!this.fly) _v.y = 0;
    const d = _v.length();
    if (d < stopAt) return true;
    _v.normalize();
    this.obj.position.addScaledVector(_v, Math.min(d, this.speed * dt));
    const yaw = Math.atan2(-_v.x, -_v.z);
    this.obj.rotation.y = damp(this.obj.rotation.y, nearAngle(this.obj.rotation.y, yaw), 6, dt);
    return false;
  }
  wander(dt) {
    if (!this.goal || this.wait > 0) { this.wait -= dt; if (this.wait <= 0 && !this.goal) { this.goal = randomFloorPoint(0.5); if (this.fly) this.goal.y = room.floorY + this.fly; } return; }
    if (this.moveTo(this.goal, dt, 0.1)) { this.goal = null; this.wait = rand(1, 4); }
  }
  update(dt) { this.t += dt; this.wander(dt); }
}
const nearAngle = (from, to) => { let d = to - from; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return from + d; };
const playerFloor = () => _v2.set(G.head.x, room.floorY, G.head.z);

// ---------- room units ----------
class Cleaner extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const b = cyl(0.17, 0.17, 0.08, white, 24); b.position.y = 0.05; g.add(b);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), darkM); dome.position.y = 0.09; g.add(dome);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.008, 6, 24), glow(0x40ff90)); ring.rotation.x = Math.PI / 2; ring.position.y = 0.03; g.add(ring);
    g.userData.h = 0.3;
    super('cleaner', g, { speed: 0.35 });
  }
  update(dt) {
    this.t += dt;
    let best = null, bd = 99;
    for (const s of scrap) { const d = s.obj.position.distanceTo(this.obj.position); if (d < bd) { bd = d; best = s; } }
    if (best) { if (this.moveTo(best.obj.position, dt, 0.18)) collectScrap(best, 'bot'); }
    else this.wander(dt);
  }
}

class Chef extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const body = cyl(0.13, 0.16, 0.6, white, 16); body.position.y = 0.4; g.add(body);
    const head = sphere(0.11, white); head.position.y = 0.82; g.add(head);
    const hat = cyl(0.1, 0.08, 0.14, std(0xffffff, { metalness: 0, roughness: 1 }), 12); hat.position.y = 0.97; g.add(hat);
    const puff = sphere(0.12, std(0xffffff, { metalness: 0, roughness: 1 })); puff.position.y = 1.06; puff.scale.y = 0.6; g.add(puff);
    const eye = box(0.14, 0.03, 0.02, glow(0x40ff90)); eye.position.set(0, 0.84, -0.1); g.add(eye);
    for (const sx of [-1, 1]) { const a = cyl(0.025, 0.025, 0.3, steel, 8); a.position.set(sx * 0.17, 0.5, -0.08); a.rotation.x = 1.1; g.add(a); }
    const wheel = cyl(0.17, 0.17, 0.08, darkM, 16); wheel.position.y = 0.05; g.add(wheel);
    g.userData.h = 1.25;
    super('chef', g, { speed: 0.4 });
    this.cook = 25;
  }
  update(dt) {
    this.t += dt;
    const tray = G.trayAnchor ? G.trayAnchor.getWorldPosition(new THREE.Vector3()) : null;
    if (tray) {
      const stand = tray.clone().setY(room.floorY);
      const side = new THREE.Vector3(-0.5, 0, 0.4).applyQuaternion(G.bridgeObj.quaternion);
      stand.add(side);
      this.moveTo(stand, dt, 0.1);
      this.obj.rotation.y = damp(this.obj.rotation.y, nearAngle(this.obj.rotation.y, Math.atan2(-(tray.x - this.obj.position.x), -(tray.z - this.obj.position.z))), 4, dt);
    } else this.wander(dt);
    this.cook -= dt;
    if (this.cook <= 0 && tray) {
      this.cook = 75;
      const m = spawnMeal(tray.clone().add(new THREE.Vector3(rand(-0.06, 0.06), 0.15, rand(-0.06, 0.06))));
      if (m) { emit('toast', 'Chef Bot: Order up! A hot meal is on the console tray.'); emit('sfx', 'coin'); burst(tray, { color: 0xffeeaa, count: 12, speed: 0.5, size: 0.03, life: 1 }); }
    }
  }
}

class RepairDrone extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const core = sphere(0.08, std(0xffaa22, { metalness: 0.6 })); g.add(core);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.012, 6, 24), steel); ring.rotation.x = Math.PI / 2; g.add(ring);
    const eye = sphere(0.025, glow(0x55ccff)); eye.position.z = -0.075; g.add(eye);
    const torch = cyl(0.008, 0.015, 0.08, steel, 6); torch.position.set(0, -0.08, -0.03); g.add(torch);
    g.userData.ring = ring;
    super('repair', g, { speed: 0.8, fly: 2.0 });
  }
  update(dt) {
    this.t += dt;
    this.obj.userData.ring.rotation.z += dt * 10;
    this.obj.position.y += Math.sin(this.t * 3) * 0.002;
    const free = breaches.filter((b) => !bots.some((o) => o !== this && o.kind === 'repair' && o.job === b));
    let target = free[0] || breaches[0];
    this.job = target || null;
    if (target) {
      const spot = target.m.position.clone().addScaledVector(target.normal, 0.35);
      if (this.moveTo(spot, dt, 0.06)) {
        repairBreach(target, 30 * dt);
        if (Math.random() < 0.5) beam(this.obj.position, target.m.position, { color: 0xffcc66, width: 0.006, life: 0.05 });
        if (Math.random() < dt * 8) emit('sfx', 'weld');
      }
    } else {
      if (!this.goal) { this.goal = randomFloorPoint(0.6); this.goal.y = room.floorY + 2.0; }
      if (this.moveTo(this.goal, dt, 0.1)) this.goal = null;
    }
  }
}

class Sentinel extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const blue = std(0x2f6fd8, { metalness: 0.6, roughness: 0.4 });
    const legs = cyl(0.1, 0.16, 0.5, darkM, 12); legs.position.y = 0.25; g.add(legs);
    const torso = box(0.36, 0.4, 0.24, blue); torso.position.y = 0.72; g.add(torso);
    const head = box(0.2, 0.16, 0.18, steel); head.position.y = 1.0; g.add(head);
    const visor = box(0.18, 0.04, 0.02, glow(0x40ff90)); visor.position.set(0, 1.01, -0.1); g.add(visor);
    for (const sx of [-1, 1]) { const gun = box(0.07, 0.07, 0.3, darkM); gun.position.set(sx * 0.24, 0.72, -0.12); g.add(gun); }
    g.userData.h = 1.2;
    super('security', g, { speed: 0.9 });
    this.fireT = 1;
  }
  update(dt) {
    this.t += dt;
    let tgt = null, bd = 99;
    for (const b of boarders) { if (b.spawn > 0) continue; const d = b.obj.position.distanceTo(this.obj.position); if (d < bd) { bd = d; tgt = b; } }
    if (!tgt) { this.wander(dt); return; }
    if (bd > 3) this.moveTo(tgt.obj.position, dt, 3);
    else this.obj.rotation.y = damp(this.obj.rotation.y, nearAngle(this.obj.rotation.y, Math.atan2(-(tgt.obj.position.x - this.obj.position.x), -(tgt.obj.position.z - this.obj.position.z))), 8, dt);
    this.fireT -= dt;
    if (this.fireT <= 0) {
      this.fireT = 0.9;
      const from = this.obj.localToWorld(new THREE.Vector3(Math.random() < 0.5 ? 0.24 : -0.24, 0.72, -0.3));
      const to = tgt.obj.position.clone().setY(tgt.obj.position.y + 1.2);
      fireRoomBolt(from, to.sub(from).normalize(), { owner: 'bot', dmg: 18, speed: 26 });
      emit('sfx', 'rifle');
    }
  }
}

class Medic extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.14, 6, 12), white); g.add(body);
    const cross1 = box(0.1, 0.03, 0.01, glow(0xff3344)); cross1.position.z = -0.092; g.add(cross1);
    const cross2 = box(0.03, 0.1, 0.01, glow(0xff3344)); cross2.position.z = -0.092; g.add(cross2);
    super('medic', g, { speed: 0.9, fly: 1.4 });
  }
  update(dt) {
    this.t += dt;
    const f = new THREE.Vector3(0.7, 0, 0.3).applyQuaternion(G.headQuat); f.y = 0;
    const spot = G.head.clone().add(f); spot.y = G.head.y - 0.2 + Math.sin(this.t * 2) * 0.05;
    this.moveTo(spot, dt, 0.1);
    if (S.hp < stat.hpMax * 0.8) {
      healPlayer(7 * dt);
      if (Math.random() < 0.4) beam(this.obj.position, G.head.clone().setY(G.head.y - 0.3), { color: 0x40ff90, width: 0.01, life: 0.06 });
    }
  }
}

class Engineer extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const y = std(0xf2c230, { metalness: 0.5 });
    const base = box(0.3, 0.2, 0.3, darkM); base.position.y = 0.12; g.add(base);
    const body = box(0.26, 0.3, 0.2, y); body.position.y = 0.37; g.add(body);
    const head = sphere(0.09, steel); head.position.y = 0.6; g.add(head);
    const eye = sphere(0.03, glow(0xffaa22)); eye.position.set(0, 0.62, -0.08); g.add(eye);
    const arm = cyl(0.02, 0.02, 0.3, steel, 6); arm.position.set(0.17, 0.4, -0.12); arm.rotation.x = 1.3; g.add(arm);
    g.userData.h = 0.85; g.userData.arm = arm;
    super('engineer', g, { speed: 0.4 });
  }
  update(dt) {
    this.t += dt;
    const spot = G.bridgeObj.localToWorld(new THREE.Vector3(1.0, 0, -0.6)); spot.y = room.floorY;
    if (this.moveTo(spot, dt, 0.1)) {
      this.obj.userData.arm.rotation.x = 1.3 + Math.sin(this.t * 8) * 0.3;
      if (Math.random() < dt * 1.5) burst(this.obj.localToWorld(new THREE.Vector3(0.17, 0.4, -0.3)), { color: 0xffdd77, count: 5, speed: 1, size: 0.02, life: 0.3, gravity: 5 });
    }
  }
}

class Gardener extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const pot = cyl(0.25, 0.2, 0.35, std(0x5a3d2a, { metalness: 0 }), 20); pot.position.y = 0.17; g.add(pot);
    const soil = cyl(0.23, 0.23, 0.02, std(0x2a1a10, { metalness: 0, roughness: 1 }), 20); soil.position.y = 0.35; g.add(soil);
    const plants = new THREE.Group(); plants.position.y = 0.35; g.add(plants);
    for (let i = 0; i < 7; i++) {
      const p = new THREE.Group();
      const stem = cyl(0.008, 0.01, 0.3, std(0x2f8a2a, { metalness: 0 }), 5); stem.position.y = 0.15; p.add(stem);
      const fruit = sphere(0.035, std([0xff4433, 0xffd23f, 0xaa44ff][i % 3], { metalness: 0, emissive: 0x111111 })); fruit.position.y = 0.3; p.add(fruit);
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), std(0x3fae3a, { metalness: 0 })); leaf.scale.set(1, 0.3, 0.5); leaf.position.y = 0.18; p.add(leaf);
      p.position.set(Math.cos(i) * 0.14 * (i % 2 ? 1 : 0.5), 0, Math.sin(i) * 0.14 * (i % 2 ? 1 : 0.5));
      plants.add(p);
    }
    const lamp = box(0.5, 0.02, 0.1, glow(0xff66ff)); lamp.position.y = 0.95; g.add(lamp);
    const pole = cyl(0.01, 0.01, 0.6, steel, 6); pole.position.set(0.25, 0.65, 0); g.add(pole);
    g.userData.h = 1.1; g.userData.plants = plants;
    super('gardener', g, { speed: 0 });
    this.grow = 0;
    const L = room.bounds;
    this.obj.position.set(L.min.x + 0.45, room.floorY, L.min.z + 0.45);
  }
  update(dt) {
    this.grow = Math.min(1, this.grow + dt / 90);
    this.obj.userData.plants.scale.setScalar(0.15 + this.grow * 0.85);
    if (this.grow >= 1) {
      this.grow = 0;
      addCredits(70, 'harvest');
      emit('toast', 'Hydroponics harvest sold  +70 cr');
      emit('sfx', 'coin');
    }
  }
}

class Lounge extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const sp = box(0.2, 0.3, 0.2, darkM); g.add(sp);
    for (const y of [-0.07, 0.07]) { const cone = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), steel); cone.position.set(0, y, -0.101); cone.rotation.y = Math.PI; g.add(cone); }
    const lights = [];
    for (let i = 0; i < 6; i++) { const l = sphere(0.02, glow(0xff00ff)); l.position.set(Math.cos(i) * 0.15, 0.18, Math.sin(i) * 0.15); g.add(l); lights.push(l); }
    g.userData.lights = lights;
    super('dj', g, { speed: 0.3, fly: 1.9 });
    this.light = new THREE.PointLight(0xff00ff, 0, 5);
    G.scene.add(this.light);
    if (!S.settings.music) { S.settings.music = true; setMusic(true); }
  }
  update(dt) {
    this.t += dt;
    this.wander(dt);
    const on = S.settings.music;
    const hue = (this.t * 0.1) % 1;
    for (const [i, l] of this.obj.userData.lights.entries()) l.material.color.setHSL((hue + i / 6) % 1, 1, on ? 0.5 + 0.5 * Math.sin(this.t * 8 + i) : 0.1);
    this.light.color.setHSL(hue, 1, 0.5);
    this.light.intensity = on ? 1.5 + Math.sin(this.t * 4) : 0;
    this.light.position.copy(this.obj.position);
  }
}

class Pet extends RoomBot {
  constructor() {
    const g = new THREE.Group();
    const m = std(0xb8c4d0, { metalness: 0.8, roughness: 0.3 });
    const body = box(0.32, 0.14, 0.14, m); body.position.y = 0.24; g.add(body);
    body.rotation.y = Math.PI / 2;
    const head = box(0.14, 0.13, 0.15, m); head.position.set(0, 0.36, -0.2); g.add(head);
    const eyeL = sphere(0.015, glow(0x40d0ff)); eyeL.position.set(-0.035, 0.38, -0.28); g.add(eyeL);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.035; g.add(eyeR);
    for (const sx of [-1, 1]) { const ear = box(0.03, 0.08, 0.04, darkM); ear.position.set(sx * 0.05, 0.46, -0.18); g.add(ear); }
    const legs = [];
    for (const [x, z] of [[-0.06, -0.12], [0.06, -0.12], [-0.06, 0.12], [0.06, 0.12]]) { const l = box(0.035, 0.18, 0.035, darkM); l.position.set(x, 0.09, z); g.add(l); legs.push(l); }
    const tail = cyl(0.01, 0.015, 0.14, m, 6); tail.position.set(0, 0.33, 0.2); tail.rotation.x = 0.8; g.add(tail);
    g.userData.legs = legs; g.userData.tail = tail; g.userData.h = 0.6;
    super('pet', g, { speed: 1.1 });
    this.barkT = 15;
  }
  update(dt) {
    this.t += dt;
    const pf = playerFloor();
    const f = new THREE.Vector3(-0.6, 0, -0.5).applyQuaternion(G.headQuat); f.y = 0;
    const spot = pf.clone().add(f);
    const moving = !this.moveTo(spot, dt, 0.25);
    const legs = this.obj.userData.legs;
    legs.forEach((l, i) => (l.rotation.x = moving ? Math.sin(this.t * 14 + (i % 2) * Math.PI) * 0.5 : 0));
    this.obj.userData.tail.rotation.z = Math.sin(this.t * (boarders.length ? 4 : 12)) * 0.6;
    if (!moving) this.obj.rotation.y = damp(this.obj.rotation.y, nearAngle(this.obj.rotation.y, Math.atan2(-(pf.x - this.obj.position.x), -(pf.z - this.obj.position.z))), 4, dt);
    this.barkT -= dt;
    if (this.barkT <= 0 || (boarders.length && this.barkT < 12)) { this.barkT = boarders.length ? 2.5 : rand(25, 60); emit('sfx', 'bark'); }
  }
}

// ---------- space units ----------
class SpaceDrone {
  constructor(kind, color) {
    this.kind = kind;
    const g = new THREE.Group();
    const hull = spaceMat(new THREE.MeshStandardMaterial({ color: 0xcfd6dd, metalness: 0.7, roughness: 0.3 }));
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3.5, 8).rotateX(-Math.PI / 2), hull); g.add(body);
    const wings = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 1.2), hull); wings.position.z = 0.6; g.add(wings);
    const light = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })));
    light.scale.setScalar(6); light.position.z = 1.8; g.add(light);
    const beacon = new THREE.Sprite(spaceMat(new THREE.SpriteMaterial({ map: glowTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, toneMapped: false })));
    beacon.scale.setScalar(12); g.add(beacon);
    g.userData.persistent = true;
    this.obj = g;
    this.phase = rand(0, Math.PI * 2);
    this.orbit = rand(40, 70);
    this.color = color;
    this.cd = rand(0, 1);
    g.position.copy(ship.pos);
    addToSystem(g);
  }
  steer(target, speed, dt) {
    const to = _v.copy(target).sub(this.obj.position);
    const d = to.length();
    if (d > 0.01) {
      const step = Math.min(d, speed * dt);
      this.obj.position.addScaledVector(to.normalize(), step);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(this.obj.position, target, new THREE.Vector3(0, 1, 0)));
      this.obj.quaternion.slerp(q, 1 - Math.exp(-4 * dt));
    }
    return d;
  }
  orbitPoint() {
    const t = G.time * 0.4 + this.phase;
    return new THREE.Vector3(Math.cos(t) * this.orbit, Math.sin(t * 0.7) * 15, Math.sin(t) * this.orbit).applyQuaternion(ship.quat).add(ship.pos);
  }
  ensureInSystem() { if (!this.obj.parent) { this.obj.position.copy(ship.pos); addToSystem(this.obj); } }
  update(dt) {
    this.ensureInSystem();
    this.steer(this.orbitPoint(), Math.max(80, ship.speed * 1.3 + 60), dt);
  }
}

class FighterDrone extends SpaceDrone {
  constructor() { super('fighter', 0x40a0ff); }
  update(dt) {
    this.ensureInSystem();
    let tgt = null, bd = 1800;
    for (const e of enemies) { const d = e.obj.position.distanceTo(ship.pos); if (d < bd) { bd = d; tgt = e; } }
    if (!tgt || ship.warping) { super.update(dt); return; }
    const off = new THREE.Vector3(Math.cos(this.phase + G.time) * 60, 20, Math.sin(this.phase + G.time) * 60);
    this.steer(tgt.obj.position.clone().add(off), 200, dt);
    this.cd -= dt;
    if (this.cd <= 0 && this.obj.position.distanceTo(tgt.obj.position) < 600) {
      this.cd = 1.1;
      beam(this.obj.position, tgt.obj.position, { color: 0x40a0ff, width: 0.4, life: 0.2, parent: universe, space: true });
      damageTarget(tgt.obj.userData.target, 12);
    }
  }
}

class MinerDrone extends SpaceDrone {
  constructor() { super('miner', 0xffaa22); }
  update(dt) {
    this.ensureInSystem();
    if (!system || ship.warping) { super.update(dt); return; }
    let rock = null, bd = 2500;
    for (const a of system.asteroids) { const d = a.position.distanceTo(ship.pos); if (d < bd) { bd = d; rock = a; } }
    if (!rock) { super.update(dt); return; }
    const t = rock.userData.target;
    const spot = rock.position.clone().add(new THREE.Vector3(0, t.radius + 10, 0));
    const d = this.steer(spot, 160, dt);
    if (d < 15) {
      this.cd -= dt;
      if (Math.random() < 0.3) beam(this.obj.position, rock.position, { color: 0xffaa22, width: 0.3, life: 0.08, parent: universe, space: true });
      if (this.cd <= 0) { this.cd = 1.2; damageTarget(t, 8); }
    }
  }
}

class ScienceDrone extends SpaceDrone {
  constructor() { super('science', 0x40ff90); this.survey = 45; }
  update(dt) {
    super.update(dt);
    this.survey -= dt;
    if (this.survey <= 0 && system) {
      this.survey = 60;
      const p = system.planets.map((x) => x.userData.target).find((t) => !S.scanned[t.scanKey]);
      if (p) {
        S.scanned[p.scanKey] = true; S.stats.scans++;
        const v = Math.round(p.value * 0.6 * stat.scanMult);
        addCredits(v, 'survey');
        emit('toast', `Science Drone surveyed ${p.name}  +${v} cr`);
      } else { addCredits(20, 'survey'); }
    }
  }
}

class ShieldDrone extends SpaceDrone {
  constructor() { super('shieldbot', 0x66ccff); this.orbit = 30; }
}

const CTORS = { cleaner: Cleaner, chef: Chef, repair: RepairDrone, security: Sentinel, medic: Medic, engineer: Engineer, gardener: Gardener, dj: Lounge, pet: Pet, fighter: FighterDrone, miner: MinerDrone, science: ScienceDrone, shieldbot: ShieldDrone };

export function spawnUnit(kind) {
  const C = CTORS[kind];
  if (!C) return;
  bots.push(new C());
}

export function initBots() {
  for (const [k, n] of Object.entries(S.units)) for (let i = 0; i < n; i++) spawnUnit(k);
  on('unit', (k) => spawnUnit(k));
}

export function updateBots(dt) {
  for (const b of bots) { try { b.update(dt); } catch (e) { console.warn(b.kind, e); } }
}

