// The Ops screen: ship status, galaxy map, shop, AI crew, room building tools and settings.
// It shows on the bridge's main screen and on the wrist tablet (left controller Y / Tab key).
import * as THREE from 'three';
import { G, emit, on, fmt, setPortalMode, view } from './core.js';
import { S, stat, lvl, units, buyUpgrade, buyGear, buySupply, buyUnit, save, resetGame } from './state.js';
import { UPGRADES, GEAR, SUPPLIES, UNITS, upgradePrice } from './catalog.js';
import { CanvasPanel, wrap, roundRect } from './ui-panel.js';
import { ship, system, galaxy, canWarp, engageWarp, setAutopilot, systemDist, nearStation } from './space.js';
import { enemies, boarders, breaches, startEncounter, startBoarding, firePhasers, fireTorpedo, cycleTarget } from './combat.js';
import { refreshRoomVisuals, rescan, room } from './room.js';
import { windowTool, removeTool, SHAPES, windowCount } from './windows.js';
import { setMusic } from './audio.js';

const ui = { tab: 'status', shopTab: 'ship', page: 0, crewPage: 0, sel: null, resetArm: false };
const TABS = [['status', 'STATUS'], ['map', 'NAV MAP'], ['shop', 'SHOP'], ['crew', 'AI CREW'], ['build', 'BUILD'], ['settings', 'SETTINGS']];

export const ops = new CanvasPanel({ width: 1280, height: 760, interval: 0.25, draw });
ops.pokeable = true;

function setTab(t) {
  ui.tab = t; ui.page = 0;
  const wasBuild = G.buildMode;
  G.buildMode = t === 'build';
  if (!G.buildMode && G.activeTool) endTool();
  if (wasBuild !== G.buildMode) refreshRoomVisuals();
}
export function openTab(t) { setTab(t); ops.dirty = true; }

function draw(g, P) {
  P.frame();
  // header
  P.text('U.S.S. STARHOME', 24, 44, { size: 30, bold: true, color: '#2fd6ff' });
  P.text(`${fmt(S.credits)} cr`, P.w - 24, 44, { size: 30, bold: true, color: '#ffd23f', align: 'right' });
  const alert = S.toggles.redAlert;
  if (alert) P.text('◆ RED ALERT ◆', P.w / 2, 44, { size: 28, bold: true, color: Math.floor(G.time * 2) % 2 ? '#ff4433' : '#ff9988', align: 'center' });
  TABS.forEach(([k, label], i) => P.button(20 + i * 206, 62, 196, 54, label, () => setTab(k), { active: ui.tab === k, size: 22, id: 'tab-' + k }));
  g.save();
  ({ status: drawStatus, map: drawMap, shop: drawShop, crew: drawCrew, build: drawBuild, settings: drawSettings })[ui.tab](g, P);
  g.restore();
}

function drawStatus(g, P) {
  const x0 = 30, y0 = 150;
  P.bar(x0, y0, 560, 34, S.hull / stat.hullMax, '#e0533a', `HULL ${Math.round(S.hull)} / ${stat.hullMax}`);
  P.bar(x0, y0 + 46, 560, 34, S.shield / stat.shieldMax, '#2f9dff', `SHIELDS ${Math.round(S.shield)} / ${stat.shieldMax}${S.toggles.shields ? '' : '  (OFFLINE)'}`);
  P.bar(x0, y0 + 92, 560, 34, S.energy / stat.energyMax, '#f2c230', `ENERGY ${Math.round(S.energy)} / ${stat.energyMax}`);
  P.bar(x0, y0 + 138, 560, 34, S.hp / stat.hpMax, '#40d870', `CAPTAIN HEALTH ${Math.round(S.hp)} / ${stat.hpMax}`);
  const info = [
    ['System', `${system.sys.name}  (${system.sys.star.cls}-class, danger ${system.sys.danger})`],
    ['Speed', `${Math.round(ship.speed)} m/s   throttle ${Math.round(ship.throttle * 100)}%${ship.boost ? '  PULSE' : ''}`],
    ['Torpedoes', `${S.missiles} / ${stat.missilesMax}`],
    ['Warp cells', `${S.warpCells}`],
    ['Grenades', `${S.grenades}`],
    ['Hostiles', `${enemies.length} ships, ${boarders.length} boarders, ${breaches.length} breaches`],
    ['Record', `${S.stats.kills} kills, ${S.stats.scans} surveys, ${S.stats.jumps} jumps`],
  ];
  info.forEach(([k, v], i) => { P.text(k, x0, y0 + 220 + i * 34, { size: 22, color: '#7fbfd8' }); P.text(v, x0 + 150, y0 + 220 + i * 34, { size: 22, color: '#e8fbff', maxW: 420 }); });
  // target box
  const tx = 620, ty = 150;
  g.strokeStyle = '#ff6a50'; g.lineWidth = 2; roundRect(g, tx, ty, 630, 120, 10); g.stroke();
  const t = G.target;
  if (t && t.obj?.parent) {
    P.text('TARGET: ' + t.name, tx + 16, ty + 36, { size: 26, bold: true, color: t.hostile ? '#ff8070' : '#80ffb0' });
    P.text(`Distance ${Math.round(t.obj.position.distanceTo(ship.pos))} m`, tx + 16, ty + 70, { size: 22 });
    if (t.enemy) P.bar(tx + 16, ty + 82, 598, 24, t.enemy.hp / t.enemy.maxHp, '#ff5040', 'HULL');
    else if (t.kind === 'asteroid') P.text(`Ore value ${t.ore} cr`, tx + 300, ty + 70, { size: 22 });
  } else P.text('No target. Point at a ship/asteroid through a window and pull the trigger, or press NEXT TARGET.', tx + 16, ty + 64, { size: 20, maxW: 600 });
  // actions
  const bx = 620, by = 290, bw = 200, bh = 62, gap = 15;
  const btns = [
    ['FIRE PHASERS', firePhasers, { color: '#ff6a50' }],
    ['TORPEDO', fireTorpedo, { color: '#ff3d6a' }],
    ['NEXT TARGET', cycleTarget, {}],
    [`SHIELDS ${S.toggles.shields ? 'ON' : 'OFF'}`, () => tg('shields'), { active: S.toggles.shields }],
    [`WEAPONS ${S.toggles.weapons ? 'ARMED' : 'SAFE'}`, () => tg('weapons'), { active: S.toggles.weapons }],
    [`SHUTTERS ${S.toggles.blast ? 'SHUT' : 'OPEN'}`, () => tg('blast'), { active: S.toggles.blast }],
    [`CLOAK ${S.toggles.cloak ? 'ON' : 'OFF'}`, () => tg('cloak'), { active: S.toggles.cloak, disabled: !lvl('cloak') }],
    [`TRACTOR ${S.toggles.tractor ? 'ON' : 'OFF'}`, () => tg('tractor'), { active: S.toggles.tractor, disabled: !lvl('tractor') }],
    ['ALL STOP', () => { ship.throttle = 0; setAutopilot(null); emit('throttle', 0); }, {}],
  ];
  btns.forEach(([l, fn, o], i) => P.button(bx + (i % 3) * (bw + gap), by + Math.floor(i / 3) * (bh + gap), bw, bh, l, fn, { size: 20, ...o }));
  const near = nearStation();
  P.button(bx, 530, 310, 64, near ? 'STATION: REPAIR + RECHARGE' : 'Station services (fly closer)', () => {
    S.hull = stat.hullMax; S.energy = stat.energyMax; S.shield = stat.shieldMax; emit('repairAll'); emit('sfx', 'buy');
    emit('toast', 'Docked: hull repaired, systems recharged (free)'); emit('say', 'Station services complete.');
  }, { disabled: !near, color: '#40ff90', size: 20 });
  P.button(bx + 325, 530, 305, 64, 'RECALL ITEMS TO ARMORY', () => G.actions.recallItems(), { size: 20 });
  P.button(bx, 610, 310, 64, 'COMBAT DRILL', () => startEncounter(true), { size: 20, color: '#ffaa22' });
  P.button(bx + 325, 610, 305, 64, 'BOARDING DRILL', () => startBoarding(2), { size: 20, color: '#ffaa22' });
}
function tg(k) { S.toggles[k] = !S.toggles[k]; emit('toggles'); emit('sfx', 'switch'); }

function drawMap(g, P) {
  const mx = 20, my = 130, mw = 760, mh = 610;
  g.fillStyle = 'rgba(0,10,20,0.9)'; g.fillRect(mx, my, mw, mh);
  g.strokeStyle = '#1d5a70'; g.strokeRect(mx, my, mw, mh);
  const cur = galaxy[S.system];
  const sc = 52, cx = mx + mw / 2, cy = my + mh / 2;
  g.save(); g.beginPath(); g.rect(mx, my, mw, mh); g.clip();
  g.strokeStyle = 'rgba(64,255,144,0.45)'; g.setLineDash([8, 8]); g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, stat.warpRange * sc, 0, 7); g.stroke(); g.setLineDash([]);
  for (const s of galaxy) {
    const x = cx + (s.x - cur.x) * sc, y = cy + (s.y - cur.y) * sc;
    if (x < mx - 20 || x > mx + mw + 20 || y < my - 20 || y > my + mh + 20) continue;
    const col = '#' + new THREE.Color(s.star.color).getHexString();
    g.fillStyle = col; g.beginPath(); g.arc(x, y, s.id === S.system ? 10 : 6, 0, 7); g.fill();
    if (S.discovered.includes(s.id)) { g.strokeStyle = '#2fd6ff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 12, 0, 7); g.stroke(); }
    if (ui.sel === s.id) { g.strokeStyle = '#ffd23f'; g.lineWidth = 3; g.beginPath(); g.arc(x, y, 17, 0, 7); g.stroke(); }
    g.fillStyle = s.id === S.system ? '#fff' : '#9cc'; g.font = '16px system-ui';
    g.fillText(s.name, x + 12, y - 10);
    if (s.id !== S.system) P.buttons.push({ id: 'sys' + s.id, x: x - 18, y: y - 18, w: 36, h: 36, fn: () => { ui.sel = s.id; G.selectedWarp = s.id; } });
  }
  g.restore();
  P.text('YOU ARE HERE: ' + cur.name, mx + 12, my + 28, { size: 20, color: '#fff', bold: true });
  P.text('dashed ring = warp range', mx + 12, my + mh - 14, { size: 16, color: '#4f9' });
  // right column
  const rx = 800;
  const sel = ui.sel != null ? galaxy[ui.sel] : null;
  if (sel) {
    const d = systemDist(cur, sel);
    P.text(sel.name, rx, 165, { size: 32, bold: true, color: '#ffd23f' });
    P.text(`${sel.star.cls}-class star  •  ${sel.economy}  •  danger ${'◆'.repeat(sel.danger)}`, rx, 200, { size: 20 });
    P.text(`Distance ${d.toFixed(1)} ly  •  ${S.discovered.includes(sel.id) ? 'visited' : 'unexplored'}`, rx, 230, { size: 20 });
    const err = canWarp(sel.id);
    P.button(rx, 248, 450, 70, err ? err : `ENGAGE WARP (1 cell)`, () => engageWarp(sel.id), { disabled: !!err, color: '#40ff90', size: err ? 17 : 26 });
  } else P.text('Tap a star to plot a warp jump.', rx, 200, { size: 22 });
  P.text('IN-SYSTEM AUTOPILOT', rx, 360, { size: 22, bold: true, color: '#2fd6ff' });
  const dest = [system.station.userData.target, ...system.planets.map((p) => p.userData.target)];
  dest.slice(0, 7).forEach((t, i) => {
    const y = 375 + i * 52;
    const d = Math.round(t.obj.position.distanceTo(ship.pos));
    P.button(rx, y, 450, 44, `${t.name}  ·  ${d > 9999 ? (d / 1000).toFixed(1) + ' km' : d + ' m'}${t.scanKey && S.scanned[t.scanKey] ? '  ✓' : ''}`, () => setAutopilot(t), { size: 19, bold: false, active: ship.autopilot?.obj === t.obj });
  });
}

function card(P, x, y, w, h, title, sub, desc, price, buy, opts = {}) {
  const g = P.ctx;
  g.fillStyle = 'rgba(8,30,46,0.9)'; roundRect(g, x, y, w, h, 10); g.fill();
  g.strokeStyle = 'rgba(47,214,255,0.5)'; g.lineWidth = 1.5; g.stroke();
  P.text(title, x + 14, y + 30, { size: 21, bold: true, color: '#e8fbff', maxW: w - 28 });
  P.text(sub, x + w - 14, y + 30, { size: 17, color: '#7fd8ff', align: 'right' });
  g.font = '15px system-ui';
  wrap(g, desc, w - 160).slice(0, 3).forEach((l, i) => P.text(l, x + 14, y + 56 + i * 19, { size: 15, color: '#a9c9d6' }));
  P.button(x + w - 136, y + h - 56, 122, 46, opts.label || (price ? `${fmt(price)} cr` : 'FREE'), buy, { size: 19, disabled: opts.disabled, color: opts.disabled ? undefined : S.credits >= price ? '#40ff90' : '#ff9a5a', id: 'buy-' + title });
}

function grid(P, entries, page, setPage) {
  const per = 12, cols = 3, cw = 400, ch = 132, x0 = 26, y0 = 196;
  const pages = Math.ceil(entries.length / per);
  entries.slice(page * per, page * per + per).forEach((e, i) => card(P, x0 + (i % cols) * (cw + 14), y0 + Math.floor(i / cols) * (ch + 10), cw, ch, ...e));
  if (pages > 1) {
    P.button(P.w - 330, 136, 140, 46, '◀ PREV', () => setPage(Math.max(0, page - 1)), { size: 18, disabled: page === 0 });
    P.text(`${page + 1}/${pages}`, P.w - 168, 168, { size: 20, align: 'center' });
    P.button(P.w - 150, 136, 130, 46, 'NEXT ▶', () => setPage(Math.min(pages - 1, page + 1)), { size: 18, disabled: page >= pages - 1 });
  }
}

function drawShop(g, P) {
  [['ship', 'SHIP UPGRADES'], ['gear', 'WEAPONS & GEAR'], ['supplies', 'SUPPLIES']].forEach(([k, l], i) =>
    P.button(26 + i * 250, 136, 236, 46, l, () => { ui.shopTab = k; ui.page = 0; }, { active: ui.shopTab === k, size: 19, id: 'st-' + k }));
  let entries = [];
  if (ui.shopTab === 'ship') {
    entries = Object.entries(UPGRADES).map(([k, u]) => {
      const l = lvl(k), max = l >= u.max;
      return [u.name, `Mk ${l + 1}/${u.max + 1}`, u.desc, max ? 0 : upgradePrice(k, l), () => buyUpgrade(k), { disabled: max, label: max ? 'MAXED' : undefined }];
    });
  } else if (ui.shopTab === 'gear') {
    entries = Object.entries(GEAR).filter(([k, gg]) => gg.price).map(([k, gg]) => [gg.name, S.gear[k] ? 'owned' : '', gg.desc, gg.price, () => buyGear(k), { disabled: !!S.gear[k], label: S.gear[k] ? 'OWNED' : undefined }]);
  } else {
    entries = Object.entries(SUPPLIES).map(([k, s]) => {
      const price = k === 'repair' ? Math.ceil(stat.hullMax - S.hull) * 2 : s.price;
      const have = { torpedo: `${S.missiles}/${stat.missilesMax}`, warpcell: `have ${S.warpCells}`, grenades: `have ${S.grenades}`, repair: `${Math.round(S.hull)}/${stat.hullMax}` }[k];
      return [s.name, have, s.desc, price, () => buySupply(k), {}];
    });
  }
  grid(P, entries, ui.page, (p) => (ui.page = p));
}

function drawCrew(g, P) {
  P.text('Buy AI units. Room units work inside your room; space units fly outside (look through a window).', 26, 166, { size: 19, color: '#a9c9d6' });
  const entries = Object.entries(UNITS).map(([k, u]) => {
    const n = units(k), full = n >= u.max;
    return [u.name, `${u.where === 'room' ? 'ROOM' : 'SPACE'}  ${n}/${u.max}`, u.desc, u.price, () => buyUnit(k), { disabled: full, label: full ? 'FULL' : undefined }];
  });
  grid(P, entries, ui.crewPage, (p) => (ui.crewPage = p));
}

function startTool(make) {
  if (G.activeTool) G.activeTool.end?.();
  const p = G.clickPointer && G.clickPointer.hand !== 'left' ? G.clickPointer : G.mode === 'desktop' ? G.pointers.desktop : G.pointers.right.connected ? G.pointers.right : G.pointers.left;
  G.activeTool = make(p);
  emit('toast', `${G.activeTool.name}: aim and pull the trigger${G.mode === 'desktop' ? ' (click). Mouse wheel = size, Esc = done' : '. Thumbstick = size, grip/B = done'}`);
}
function endTool() { G.activeTool?.end?.(); G.activeTool = null; }
on('toolEnd', () => { ops.dirty = true; });

function drawBuild(g, P) {
  P.text(`Room: ${room.source === 'fallback' ? (G.mode === 'desktop' ? 'simulated deck' : 'play boundary') : 'scanned from your headset'}  •  ${windowCount()} windows`, 26, 168, { size: 21, color: '#a9c9d6' });
  P.text('WINDOWS', 26, 215, { size: 22, bold: true, color: '#2fd6ff' });
  Object.entries(SHAPES).forEach(([k, s], i) => P.button(26 + i * 200, 230, 186, 64, s.name, () => startTool((p) => windowTool(p, k)), { size: 21, active: G.activeTool?.name === `Place ${s.name}` }));
  P.button(830, 230, 200, 64, 'Remove', () => startTool((p) => removeTool(p)), { size: 21, color: '#ff8070', active: G.activeTool?.name === 'Remove Window' });
  P.text('BRIDGE & FURNITURE', 26, 335, { size: 22, bold: true, color: '#2fd6ff' });
  P.button(26, 350, 290, 64, 'Move Bridge Console', () => startTool((p) => G.actions.bridgeTool(p)), { size: 21 });
  P.button(330, 350, 290, 64, 'Link Console to Couch', () => G.actions.linkCouch(), { size: 21 });
  P.button(634, 350, 260, 64, 'Move Armory', () => startTool((p) => G.actions.rackTool(p)), { size: 21 });
  P.button(908, 350, 160, 64, 'Desk ▲', () => G.actions.deskHeight(0.03), { size: 21 });
  P.button(1080, 350, 160, 64, 'Desk ▼', () => G.actions.deskHeight(-0.03), { size: 21 });
  P.text('VIEW', 26, 455, { size: 22, bold: true, color: '#2fd6ff' });
  P.button(26, 470, 290, 64, 'Windows Only', () => { setPortalMode('windows'); refreshRoomVisuals(); }, { active: view.portal === 'windows', size: 21 });
  P.button(330, 470, 290, 64, 'Observation Deck', () => { setPortalMode('open'); refreshRoomVisuals(); }, { active: view.portal === 'open', size: 21 });
  if (G.mode === 'ar') P.button(634, 470, 330, 64, S.settings.skin ? 'Walls: Sci-fi Hull' : 'Walls: My Real Room', () => { S.settings.skin = !S.settings.skin; refreshRoomVisuals(); save(); }, { size: 21, active: S.settings.skin });
  P.button(G.mode === 'ar' ? 978 : 634, 470, 260, 64, 'Rescan Room', () => rescan(), { size: 21 });
  P.text('Observation Deck makes the whole hull transparent. Hull Skin replaces your real walls with spaceship panels.', 26, 575, { size: 18, color: '#a9c9d6', maxW: 1220 });
  P.text('Tip: windows go on any scanned wall. Link the console to your couch to sit and fly.', 26, 605, { size: 18, color: '#a9c9d6', maxW: 1220 });
  P.button(26, 650, 300, 70, G.activeTool ? 'DONE PLACING' : 'CLOSE BUILD MODE', () => { if (G.activeTool) endTool(); else setTab('status'); }, { size: 22, color: '#40ff90' });
}

function drawSettings(g, P) {
  P.text('Encounters', 26, 180, { size: 22, color: '#7fbfd8' });
  ['off', 'normal', 'hard'].forEach((k, i) => P.button(230 + i * 170, 146, 160, 52, k.toUpperCase(), () => { S.settings.encounters = k; save(); }, { active: S.settings.encounters === k, size: 20 }));
  P.text('Ship voice', 26, 250, { size: 22, color: '#7fbfd8' });
  P.button(230, 216, 160, 52, S.settings.voice ? 'ON' : 'OFF', () => { S.settings.voice = !S.settings.voice; save(); }, { active: S.settings.voice, size: 20 });
  P.text('Music', 26, 320, { size: 22, color: '#7fbfd8' });
  P.button(230, 286, 330, 52, units('dj') ? (S.settings.music ? 'ON' : 'OFF') : 'Needs a Lounge Bot', () => { S.settings.music = !S.settings.music; setMusic(S.settings.music); save(); }, { active: S.settings.music, disabled: !units('dj'), size: 20 });
  P.text('Turn speed', 26, 390, { size: 22, color: '#7fbfd8' });
  [[0.5, 'GENTLE'], [1, 'NORMAL'], [1.6, 'FAST']].forEach(([v, l], i) => P.button(230 + i * 170, 356, 160, 52, l, () => { S.settings.turnSpeed = v; save(); }, { active: S.settings.turnSpeed === v, size: 20 }));
  P.button(26, 440, 360, 56, ui.resetArm ? 'TAP AGAIN TO ERASE SAVE' : 'Reset game', () => { if (ui.resetArm) resetGame(); else { ui.resetArm = true; setTimeout(() => (ui.resetArm = false), 4000); } }, { color: '#ff5a4a', size: 20 });
  P.button(400, 440, 200, 56, 'Save now', () => { save(); emit('toast', 'Game saved'); }, { size: 20 });
  const help = G.mode === 'desktop' ? [
    'DESKTOP: click to look around. WASD walk, C sit/stand, Tab tablet, T type on terminal.',
    'Click buttons/switches. Drag the throttle lever and joystick. G or right-click = grab/drop items.',
    'Arrows pitch/yaw, Z/X roll, R/F throttle, Shift boost, Space phasers, M torpedo, N next target.',
  ] : [
    'VR: Trigger = press, select, fire. Grip = grab/drop items, hold levers. Poke buttons with your finger.',
    'Left stick: throttle (up/down) and roll. Right stick: pitch and yaw. Click a stick = Pulse boost.',
    'A = fire phasers, B = torpedo, X = next target, Y = wrist tablet. Point + trigger on a ship = lock on.',
  ];
  help.forEach((l, i) => P.text(l, 26, 560 + i * 34, { size: 19, color: '#cfefff', maxW: 1230 }));
}

// ---------- wrist / desktop tablet ----------
let tablet = null;
export function initTablet(camera) {
  tablet = ops.createMesh(0.44);
  tablet.visible = false;
  G.tablet = tablet;
  on('tablet', () => toggleTablet(camera));
}
export function toggleTablet(camera) {
  tablet.visible = !tablet.visible;
  emit('sfx', 'boop');
  if (!tablet.visible) return;
  tablet.parent?.remove(tablet);
  if (G.mode === 'desktop') {
    camera.add(tablet);
    tablet.scale.setScalar(1.25);
    tablet.position.set(0, -0.02, -0.62);
    tablet.rotation.set(0, 0, 0);
  } else {
    const L = G.pointers.left;
    const grip = L.entry?.grip;
    if (grip) {
      grip.add(tablet);
      tablet.scale.setScalar(1);
      tablet.position.set(0.02, 0.07, -0.16);
      tablet.rotation.set(-1.0, 0, 0);
    }
  }
}
