// Hand-held items: blasters, a plasma saber, an arc hammer, a riot shield, grenades,
// the fusion welder, the analyzer (scanner) and food. They live on the armory rack.
import * as THREE from 'three';
import { G, emit, on, std, glow, glowTexture, box, cyl, rand, clamp } from './core.js';
import { S, stat, addCredits, save, layout } from './state.js';
import { GEAR } from './catalog.js';
import { fireRoomBolt, boardersOnSegment, damageBoarder, explode, breaches, repairBreach, healPlayer, boarders } from './combat.js';
import { room, walls } from './room.js';
import { raySurfaces } from './input.js';
import { burst, flash, beam } from './fx.js';
import { CanvasPanel } from './ui-panel.js';

export const items = [];
G.items = items;
G.supports = []; // Box3 surfaces items can rest on

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion();
const metal = std(0x5a6470, { metalness: 0.85, roughness: 0.3 });
const dark = std(0x23272d, { metalness: 0.6, roughness: 0.5 });
const grip = std(0x15171a, { metalness: 0.1, roughness: 0.9 });

// ---------- builders (barrel / blade along -Z, origin at the hand) ----------
function gunMesh(kind) {
  const g = new THREE.Group();
  const accent = glow(kind === 'rifle' ? 0x66ff88 : kind === 'shotgun' ? 0xffaa33 : 0x44ddff);
  const len = kind === 'rifle' ? 0.5 : kind === 'shotgun' ? 0.42 : 0.24;
  const body = box(0.045, 0.06, len, kind === 'pistol' ? metal : dark); body.position.set(0, 0.035, -len / 2 + 0.06); g.add(body);
  const handle = box(0.035, 0.11, 0.05, grip); handle.position.set(0, -0.03, 0.02); handle.rotation.x = 0.25; g.add(handle);
  const barrel = cyl(0.014, 0.014, 0.12, metal, 8); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0.045, -len + 0.0); g.add(barrel);
  const strip = box(0.048, 0.01, len * 0.7, accent); strip.position.set(0, 0.06, -len / 2 + 0.06); g.add(strip);
  if (kind === 'rifle') { const stock = box(0.04, 0.07, 0.16, grip); stock.position.set(0, 0.02, 0.15); g.add(stock); const mag = box(0.03, 0.09, 0.05, accent); mag.position.set(0, -0.02, -0.12); g.add(mag); }
  if (kind === 'shotgun') { const b2 = cyl(0.02, 0.02, 0.3, metal, 8); b2.rotation.x = Math.PI / 2; b2.position.set(0, 0.0, -0.22); g.add(b2); const pump = box(0.05, 0.04, 0.1, grip); pump.position.set(0, -0.005, -0.22); g.add(pump); }
  const sight = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 2.5, 4).rotateX(Math.PI / 2).translate(0, 0, -1.25), new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.35, toneMapped: false }));
  sight.position.set(0, 0.045, -len);
  sight.userData.noRay = true;
  sight.visible = false;
  g.add(sight);
  g.userData.sight = sight;
  g.userData.muzzle = new THREE.Vector3(0, 0.045, -len - 0.06);
  return g;
}

function saberMesh() {
  const g = new THREE.Group();
  const hilt = cyl(0.018, 0.02, 0.24, metal, 12); hilt.rotation.x = Math.PI / 2; hilt.position.z = 0.02; g.add(hilt);
  const guard = cyl(0.026, 0.026, 0.03, dark, 12); guard.rotation.x = Math.PI / 2; guard.position.z = -0.1; g.add(guard);
  const btn = box(0.012, 0.012, 0.02, glow(0xff3333)); btn.position.set(0, 0.02, 0); g.add(btn);
  const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.014, 0.95, 10).rotateX(Math.PI / 2).translate(0, 0, -0.59), glow(0xccf6ff));
  const aura = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.97, 10).rotateX(Math.PI / 2).translate(0, 0, -0.59), new THREE.MeshBasicMaterial({ color: 0x2fa8ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  blade.userData.noRay = aura.userData.noRay = true;
  g.add(blade, aura);
  g.userData.blade = [blade, aura];
  return g;
}

function hammerMesh() {
  const g = new THREE.Group();
  const shaft = cyl(0.016, 0.016, 0.6, dark, 8); shaft.rotation.x = Math.PI / 2; shaft.position.z = -0.2; g.add(shaft);
  const head = box(0.12, 0.12, 0.2, metal); head.position.z = -0.5; head.rotation.y = Math.PI / 2; g.add(head);
  const coil = cyl(0.065, 0.065, 0.05, glow(0x99aaff), 12); coil.position.z = -0.5; g.add(coil);
  return g;
}

function riotMesh() {
  const g = new THREE.Group();
  const panel = box(0.55, 0.75, 0.02, new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.35, metalness: 0.2, roughness: 0.1 }));
  panel.position.set(0, 0.1, -0.12); g.add(panel);
  const rim = new THREE.Mesh(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.55, 0.75, 0.02)), new THREE.LineBasicMaterial({ color: 0x2fd6ff }));
  rim.position.copy(panel.position); g.add(rim);
  const handle = box(0.03, 0.12, 0.08, grip); handle.position.set(0, 0, -0.06); g.add(handle);
  return g;
}

function grenadeMesh() {
  const g = new THREE.Group();
  const s = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 12), dark); g.add(s);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.007, 6, 16), glow(0x44aaff)); g.add(band);
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), glow(0x330000)); light.position.y = 0.04; g.add(light);
  g.userData.light = light;
  return g;
}

function welderMesh() {
  const g = new THREE.Group();
  const body = box(0.06, 0.07, 0.22, std(0xd08a20, { metalness: 0.5 })); body.position.z = -0.06; g.add(body);
  const handle = box(0.035, 0.11, 0.05, grip); handle.position.set(0, -0.06, 0.02); g.add(handle);
  const nozzle = cyl(0.01, 0.02, 0.08, metal, 8); nozzle.rotation.x = -Math.PI / 2; nozzle.position.z = -0.2; g.add(nozzle);
  const tank = cyl(0.02, 0.02, 0.12, glow(0x55ccff), 8); tank.rotation.x = Math.PI / 2; tank.position.set(0, 0.05, -0.04); g.add(tank);
  g.userData.muzzle = new THREE.Vector3(0, 0, -0.25);
  return g;
}

function scannerMesh() {
  const g = new THREE.Group();
  const body = box(0.09, 0.03, 0.16, std(0x2e3a48, { metalness: 0.6 })); body.position.z = -0.06; g.add(body);
  const panel = new CanvasPanel({
    width: 256, height: 160, interval: 0.1,
    draw(c, P) {
      c.fillStyle = '#001a12'; c.fillRect(0, 0, 256, 160);
      const it = g.userData.item;
      const st = it?.scan;
      c.fillStyle = '#3f8'; c.font = 'bold 22px monospace';
      c.fillText('ANALYZER', 10, 26);
      c.font = '18px monospace';
      if (st?.target) {
        c.fillText(st.target.name.slice(0, 20), 10, 56);
        c.fillStyle = '#183'; c.fillRect(10, 70, 236, 16);
        c.fillStyle = '#3f8'; c.fillRect(10, 70, 236 * Math.min(1, st.progress), 16);
        (st.lines || []).slice(0, 3).forEach((l, i) => c.fillText(l, 10, 108 + i * 20));
      } else c.fillText('Aim at a planet,', 10, 60), c.fillText('ship or asteroid', 10, 82), c.fillText('and hold trigger', 10, 104);
      void P;
    },
  });
  const screen = panel.createMesh(0.08);
  G.interactables.splice(G.interactables.indexOf(screen), 1);
  screen.rotation.x = -Math.PI / 2 + 0.5;
  screen.position.set(0, 0.025, -0.06);
  g.add(screen);
  const lens = cyl(0.015, 0.02, 0.03, glow(0x33ff88), 10); lens.rotation.x = Math.PI / 2; lens.position.z = -0.15; g.add(lens);
  g.userData.panel2 = panel;
  return g;
}

function foodMesh(kind) {
  const g = new THREE.Group();
  if (kind === 'mug') {
    const m = cyl(0.04, 0.035, 0.1, std(0xeeeeee, { metalness: 0, roughness: 0.4 }), 16); g.add(m);
    const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.036, 16), std(0x3b2414, { metalness: 0 })); coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.045; g.add(coffee);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 6, 12, Math.PI), std(0xeeeeee)); handle.rotation.z = -Math.PI / 2; handle.position.x = 0.04; g.add(handle);
  } else {
    const plate = cyl(0.11, 0.09, 0.015, std(0xdddddd, { metalness: 0.1 }), 20); g.add(plate);
    const colors = [0xc0702a, 0x5fae3a, 0xe8c25a, 0xb3322a];
    for (let i = 0; i < 5; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(rand(0.025, 0.045), 8, 6), std(colors[i % 4], { metalness: 0, roughness: 0.8 })); b.position.set(rand(-0.05, 0.05), 0.03, rand(-0.05, 0.05)); g.add(b); }
  }
  return g;
}

// ---------- item class ----------
const DEFS = {
  pistol: { build: () => gunMesh('pistol'), type: 'gun', dmg: 28, rate: 0.22, auto: false, sfx: 'blaster' },
  rifle: { build: () => gunMesh('rifle'), type: 'gun', dmg: 15, rate: 0.09, auto: true, sfx: 'rifle' },
  shotgun: { build: () => gunMesh('shotgun'), type: 'gun', dmg: 13, rate: 0.75, auto: false, pellets: 7, sfx: 'shotgun' },
  sword: { build: saberMesh, type: 'melee', dmg: 45, reach: 1.05 },
  hammer: { build: hammerMesh, type: 'melee', dmg: 70, reach: 0.6, aoe: true },
  riot: { build: riotMesh, type: 'shield' },
  grenade: { build: grenadeMesh, type: 'grenade' },
  welder: { build: welderMesh, type: 'welder' },
  scanner: { build: scannerMesh, type: 'scanner' },
  meal: { build: () => foodMesh('meal'), type: 'food', heal: 40, name: 'Hot Meal' },
  mug: { build: () => foodMesh('mug'), type: 'food', heal: 6, name: 'Coffee', refill: true },
};

export class Item {
  constructor(kind) {
    this.kind = kind;
    this.def = DEFS[kind];
    this.root = this.def.build();
    this.root.userData.item = this;
    this.name = GEAR[kind]?.name || this.def.name || kind;
    this.holder = null;
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3();
    this.resting = true;
    this.cd = 0;
    this.home = null; // {pos, quat}
    this.bladeOn = true;
    this.swing = 0;
    this.lastTip = new THREE.Vector3();
    this.hitCd = new Map();
    this.scan = { target: null, progress: 0, lines: [] };
    G.scene.add(this.root);
    G.interactables.push(this.root);
    items.push(this);
  }

  grab(p) {
    if (this.root.userData.sight) this.root.userData.sight.visible = p.hand !== 'desktop';
    this.holder = p;
    this.resting = false;
    if (this.kind === 'riot') G.blockers.push(this.blocker ||= { blocks: (pt) => this.blocks(pt) });
    if (this.kind === 'sword' && this.bladeOn) emit('sfx', 'saber');
  }

  drop(p) {
    if (this.root.userData.sight) this.root.userData.sight.visible = false;
    this.holder = null;
    this.vel.copy(p.velocity).clampLength(0, 12);
    if (p.hand === 'desktop') this.vel.copy(p.dir).multiplyScalar(this.kind === 'grenade' ? 7 : 2).add(_v.set(0, 1.5, 0));
    this.spin.set(rand(-4, 4), rand(-4, 4), rand(-4, 4)).multiplyScalar(this.vel.length() / 6);
    this.resting = false;
    const bi = G.blockers.indexOf(this.blocker); if (bi >= 0) G.blockers.splice(bi, 1);
    emit('sfx', 'drop');
  }

  blocks(pt) {
    const local = this.root.worldToLocal(_v2.copy(pt));
    return Math.abs(local.x) < 0.3 && Math.abs(local.y - 0.1) < 0.4 && Math.abs(local.z + 0.12) < 0.12;
  }

  muzzleWorld(out) { return out.copy(this.root.userData.muzzle || _v.set(0, 0, -0.2)).applyMatrix4(this.root.matrixWorld); }
  forward(out) { return out.set(0, 0, -1).applyQuaternion(this.root.quaternion); }

  // place in the hand: position at the grip, pointing along the controller ray
  follow(p) {
    p.gripPos(this.root.position);
    this.root.quaternion.copy(p.rayQuat);
    if (this.kind === 'grenade' || this.def.type === 'food') this.root.quaternion.identity();
    if (this.swing > 0) this.root.rotateX(-Math.sin((1 - this.swing) * Math.PI) * 1.4);
    this.root.updateMatrixWorld(true);
  }

  use(p, dt) {
    this.cd -= dt;
    this.follow(p);
    const d = this.def;
    const desk = p.hand === 'desktop';
    if (d.type === 'gun') {
      const fire = d.auto ? p.trigger : p.pressed('trigger');
      if (fire && this.cd <= 0) {
        this.cd = d.rate;
        const from = this.muzzleWorld(new THREE.Vector3());
        let dir = this.forward(new THREE.Vector3());
        if (desk) dir = _v.copy(p.origin).addScaledVector(p.dir, 12).sub(from).normalize().clone();
        const n = d.pellets || 1;
        for (let i = 0; i < n; i++) {
          const dd = dir.clone();
          if (n > 1) dd.add(new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.07)).normalize();
          fireRoomBolt(from, dd, { owner: 'player', dmg: d.dmg, speed: 34 });
        }
        flash(from, { color: 0x88eeff, scale: 0.4, life: 0.08 });
        emit('sfx', d.sfx);
        p.haptic(d.pellets ? 1 : 0.5, d.pellets ? 80 : 30);
        this.swing = 0;
      }
    } else if (d.type === 'melee') {
      if (this.kind === 'sword' && p.pressed('trigger') && !desk) {
        this.bladeOn = !this.bladeOn;
        this.root.userData.blade.forEach((b) => (b.visible = this.bladeOn));
        emit('sfx', this.bladeOn ? 'saber' : 'drop');
      }
      if (desk && p.pressed('trigger') && this.swing <= 0) { this.swing = 1; emit('sfx', this.kind === 'sword' ? 'saber' : 'hammer'); }
      if (this.swing > 0) this.swing = Math.max(0, this.swing - dt * 3.2);
      const hiltW = this.root.getWorldPosition(new THREE.Vector3());
      const tipW = this.forward(new THREE.Vector3()).multiplyScalar(d.reach).add(hiltW);
      const speed = tipW.distanceTo(this.lastTip) / Math.max(dt, 1e-3);
      this.lastTip.copy(tipW);
      const swinging = desk ? this.swing > 0.2 && this.swing < 0.8 : speed > 1.4;
      if (this.kind === 'sword' && !this.bladeOn) return;
      if (swinging) {
        if (!desk && speed > 3 && Math.random() < dt * 6) emit('sfx', 'saber');
        // desktop swings reach a bit further so mouse players can hit
        const a = desk ? p.origin.clone().addScaledVector(p.dir, 0.3) : hiltW;
        const b = desk ? p.origin.clone().addScaledVector(p.dir, 1.8) : tipW;
        for (const bd of boardersOnSegment(a, b, desk ? 0.25 : 0.05)) {
          if ((this.hitCd.get(bd) || 0) > G.time) continue;
          this.hitCd.set(bd, G.time + 0.4);
          const dmg = d.dmg + (desk ? 10 : Math.min(40, speed * 6));
          damageBoarder(bd, dmg, tipW.clone());
          emit('sfx', this.kind === 'sword' ? 'saberHit' : 'hammer');
          p.haptic(1, 60);
          if (d.aoe) { flash(tipW, { color: 0x99aaff, scale: 2.5, life: 0.4 }); for (const o of [...boarders]) if (o !== bd && o.obj.position.distanceTo(tipW) < 1.6) damageBoarder(o, 35); }
        }
      }
    } else if (d.type === 'grenade') {
      if (p.pressed('trigger') && !this.armed) {
        this.armed = G.time + 2.6; emit('sfx', 'boop');
        if (desk) { p.held = null; this.drop(p); }
      }
    } else if (d.type === 'welder') {
      if (p.trigger) {
        const from = this.muzzleWorld(new THREE.Vector3());
        const dir = desk ? p.dir : this.forward(new THREE.Vector3());
        const ray = new THREE.Raycaster(from, dir, 0, 3);
        ray.camera = G.camera;
        const hit = ray.intersectObjects(breaches.map((b) => b.m), false)[0];
        const wallHit = raySurfaces({ origin: from, dir }, walls());
        const end = hit ? hit.point : wallHit && wallHit.distance < 2.5 ? wallHit.point : from.clone().addScaledVector(dir, 0.6);
        if (Math.random() < 0.5) beam(from, end, { color: 0x99ddff, width: 0.006, life: 0.05 });
        if (Math.random() < dt * 20) burst(end, { color: 0xbbeeff, count: 3, speed: 1.5, size: 0.02, life: 0.25, gravity: 6 });
        if (Math.random() < dt * 10) emit('sfx', 'weld');
        if (hit) { repairBreach(hit.object.userData.breach, 60 * dt); p.haptic(0.3, 20); }
      }
    } else if (d.type === 'scanner') {
      const st = this.scan;
      if (p.trigger) {
        const from = this.muzzleWorld(new THREE.Vector3());
        const dir = desk ? p.dir : this.forward(new THREE.Vector3());
        const ray = new THREE.Raycaster(desk ? p.origin : from, dir, 0, 30000);
        ray.camera = G.camera;
        let t = null;
        for (const h of ray.intersectObjects(G.spaceTargets, true)) {
          let o = h.object; while (o && !o.userData.target) o = o.parent;
          if (o) { t = o.userData.target; break; }
        }
        if (t && t === st.target) st.progress += dt / 1.6;
        else if (t) { st.target = t; st.progress = 0; st.lines = []; st.done = false; }
        if (t && Math.random() < dt * 8) emit('sfx', 'scan');
        if (t && st.progress >= 1 && !st.done) { st.done = true; completeScan(t, st); }
      } else if (!st.done) st.progress = Math.max(0, st.progress - dt);
      this.root.userData.panel2.update(dt);
    } else if (d.type === 'food') {
      const near = this.root.position.distanceTo(G.head) < 0.22;
      if ((near && !desk) || (desk && p.pressed('trigger'))) {
        if (this.cd > 0) return;
        this.cd = 1.5;
        healPlayer(d.heal);
        emit('sfx', 'eat');
        emit('toast', `${d.name}: +${d.heal} health`);
        if (!d.refill) { p.held = null; this.remove(); }
      }
    }
  }

  remove() {
    G.scene.remove(this.root);
    items.splice(items.indexOf(this), 1);
    const i = G.interactables.indexOf(this.root); if (i >= 0) G.interactables.splice(i, 1);
  }

  update(dt) {
    if (this.kind === 'grenade' && this.armed) {
      const t = this.armed - G.time;
      this.root.userData.light.material.color.setHex(Math.sin(t * (t < 1 ? 40 : 15)) > 0 ? 0xff2222 : 0x330000);
      if (t <= 0) {
        if (this.holder) this.holder.held = null;
        explode(this.root.getWorldPosition(new THREE.Vector3()), 2.6, 130);
        this.remove();
        S.grenades = Math.max(0, S.grenades - 1);
        if (S.grenades > 0) setTimeout(() => restockGrenade(), 2000);
        return;
      }
    }
    if (this.holder || this.resting) return;
    // simple physics for dropped / thrown items
    this.vel.y -= 9.8 * dt;
    this.root.position.addScaledVector(this.vel, dt);
    this.root.rotation.x += this.spin.x * dt; this.root.rotation.y += this.spin.y * dt; this.root.rotation.z += this.spin.z * dt;
    const p = this.root.position;
    let floor = room.floorY + 0.04;
    for (const b of G.supports) if (p.x > b.min.x && p.x < b.max.x && p.z > b.min.z && p.z < b.max.z && p.y > b.max.y - 0.15) floor = Math.max(floor, b.max.y + 0.04);
    const bb = room.bounds;
    if (p.x < bb.min.x + 0.05 || p.x > bb.max.x - 0.05) { this.vel.x *= -0.4; p.x = clamp(p.x, bb.min.x + 0.05, bb.max.x - 0.05); }
    if (p.z < bb.min.z + 0.05 || p.z > bb.max.z - 0.05) { this.vel.z *= -0.4; p.z = clamp(p.z, bb.min.z + 0.05, bb.max.z - 0.05); }
    if (p.y < floor) {
      p.y = floor;
      if (Math.abs(this.vel.y) > 1.2) { this.vel.y *= -0.35; this.vel.x *= 0.6; this.vel.z *= 0.6; this.spin.multiplyScalar(0.5); }
      else {
        this.vel.set(0, 0, 0); this.spin.set(0, 0, 0); this.resting = true;
        // lie flat-ish
        const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, 'YXZ');
        this.root.rotation.set(0, e.y, 0);
      }
    }
  }

  sendHome() {
    if (this.root.userData.sight) this.root.userData.sight.visible = false;
    if (this.holder) { this.holder.held = null; this.holder = null; }
    if (!this.home) return;
    this.root.position.copy(this.home.pos);
    this.root.quaternion.copy(this.home.quat);
    this.vel.set(0, 0, 0);
    this.resting = true;
    const bi = G.blockers.indexOf(this.blocker); if (bi >= 0) G.blockers.splice(bi, 1);
  }
}

function completeScan(t, st) {
  emit('sfx', 'scanDone');
  const key = t.scanKey || (t.kind === 'asteroid' ? null : t.name);
  if (t.kind === 'planet') {
    st.lines = [`Class: ${t.type}`, `Radius: ${Math.round(t.radius * 30)} km`, S.scanned[key] ? 'Already logged' : `Data value: ${Math.round(t.value * stat.scanMult)}`];
    if (!S.scanned[key]) {
      S.scanned[key] = true; S.stats.scans++;
      const v = Math.round(t.value * stat.scanMult);
      addCredits(v, 'scan');
      emit('toast', `Planet ${t.name} surveyed (${t.type})  +${v} cr`);
      emit('say', `Survey of ${t.name} complete. Data uploaded.`);
      save();
    } else emit('toast', `${t.name}: already surveyed`);
  } else if (t.kind === 'asteroid') {
    st.lines = [`Ore: ${t.ore} cr`, `Mass: ${Math.round(t.radius ** 3)} kt`, 'Mine with phasers'];
    emit('toast', `Asteroid: ${t.ore} cr of ore. Lock on and fire phasers to mine it.`);
  } else if (t.kind === 'enemy') {
    st.lines = [`Hull: ${Math.max(0, Math.round(t.enemy.hp))}/${t.enemy.maxHp}`, 'Weak point exposed', '+25% damage'];
    t.enemy.maxHp = Math.round(t.enemy.maxHp);
    t.enemy.hp *= 0.75;
    emit('toast', `${t.name} scanned: weak point found (-25% hull)`);
  } else if (t.kind === 'station') {
    st.lines = ['Docking: open', 'Repairs: free', 'Trade: online'];
    emit('toast', `${t.name}: free repairs and refuel when you fly within 900 m`);
  }
}

// ---------- armory rack ----------
export const rack = new THREE.Group();
const SLOTS = {
  pistol: [-0.55, 0.25], rifle: [0, 0.25], shotgun: [0.55, 0.25],
  sword: [-0.55, -0.1], hammer: [0, -0.1], riot: [0.62, -0.18],
  welder: [-0.55, -0.42], scanner: [-0.2, -0.42], grenade: [0.15, -0.42],
};
function buildRack() {
  const back = box(1.6, 1.05, 0.04, std(0x2c333b, { metalness: 0.6 }));
  rack.add(back);
  const trim = box(1.64, 0.03, 0.05, glow(0x2fd6ff)); trim.position.y = 0.54; rack.add(trim);
  const trim2 = trim.clone(); trim2.position.y = -0.54; rack.add(trim2);
  for (const [k, [x, y]] of Object.entries(SLOTS)) {
    const peg = box(0.04, 0.04, 0.08, metal); peg.position.set(x, y - 0.06, 0.04); rack.add(peg);
  }
  const c = document.createElement('canvas'); c.width = 512; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#2fd6ff'; g.font = 'bold 44px system-ui'; g.fillText('ARMORY', 160, 48);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.075), new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false }));
  label.position.set(0, 0.6, 0.03); rack.add(label);
  // recall button
  const btn = cyl(0.04, 0.04, 0.03, glow(0xffaa22), 16); btn.rotation.x = Math.PI / 2; btn.position.set(0.62, 0.42, 0.04);
  btn.userData.control = { press: () => { recallItems(); emit('sfx', 'switch'); }, setHover() {} };
  rack.add(btn);
  G.interactables.push(btn);
}

function slotPose(kind) {
  const [x, y] = SLOTS[kind] || [0, 0];
  const pos = rack.localToWorld(new THREE.Vector3(x, y, 0.09));
  // items hang sideways, pointing along the rack
  const q = rack.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)));
  if (kind === 'riot') q.copy(rack.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0)));
  if (kind === 'grenade') q.copy(rack.quaternion);
  return { pos, quat: q };
}

export function placeRack(pos, quat) {
  rack.position.copy(pos);
  rack.quaternion.copy(quat);
  rack.updateMatrixWorld(true);
  layout().armory = { pos: pos.toArray(), quat: quat.toArray() };
  for (const it of items) {
    if (!SLOTS[it.kind]) continue;
    it.home = slotPose(it.kind);
    if (!it.holder) it.sendHome();
  }
}

export function recallItems() {
  for (const it of items) if (it.home && !(it.holder && it.holder.held === it)) it.sendHome();
  emit('toast', 'Items recalled to the armory');
}

export function ensureItems() {
  for (const k of Object.keys(SLOTS)) {
    const owned = k === 'grenade' ? S.grenades > 0 : S.gear[k];
    if (owned && !items.some((i) => i.kind === k)) {
      const it = new Item(k);
      it.home = slotPose(k);
      it.sendHome();
    }
  }
}
function restockGrenade() { ensureItems(); }
on('gear', () => ensureItems());

// auto-place the rack on a wall beside the bridge
export function autoRack(bridgeObj) {
  const L = layout();
  if (L.armory) {
    const pos = new THREE.Vector3().fromArray(L.armory.pos);
    const q = new THREE.Quaternion().fromArray(L.armory.quat);
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const hit = raySurfaces({ origin: pos.clone().addScaledVector(n, 0.4), dir: n.clone().negate() }, walls());
    if (hit && hit.distance < 0.9) { placeRack(pos, q); return; }
  }
  const origin = bridgeObj.getWorldPosition(new THREE.Vector3()).setY(room.floorY + 1.3);
  const dirs = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)].map((d) => d.applyQuaternion(bridgeObj.quaternion));
  for (const d of dirs) {
    const hit = raySurfaces({ origin, dir: d }, walls());
    if (hit) { rackOnWall(hit, 0.6); return; }
  }
  placeRack(origin.clone().add(new THREE.Vector3(-1.5, 0, 0)), bridgeObj.quaternion.clone());
}

export function rackOnWall(hit, offsetAlong = 0) {
  const n = hit.object.userData.surface.normal.clone(); n.y = 0; n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const along = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const pos = hit.point.clone().addScaledVector(n, 0.03).addScaledVector(along, offsetAlong);
  pos.y = room.floorY + 1.3;
  placeRack(pos, q);
}

export function initItems(scene) {
  buildRack();
  scene.add(rack);
}

export function updateItems(dt) {
  for (const it of [...items]) it.update(dt);
}

// Give the chef's meals somewhere to appear.
export function spawnMeal(pos) {
  if (items.filter((i) => i.kind === 'meal').length >= 3) return null;
  const it = new Item('meal');
  it.root.position.copy(pos);
  it.resting = false;
  return it;
}
