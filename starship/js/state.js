// Persistent game state (saved to localStorage), derived ship stats and purchases.
import { G, emit, clamp } from './core.js';
import { UPGRADES, GEAR, SUPPLIES, UNITS, upgradePrice } from './catalog.js';

const KEY = 'starhome-save-v1';

function newGame() {
  return {
    v: 1,
    credits: 1500,
    hull: 100, shield: 100, energy: 100,
    missiles: 4, warpCells: 2, grenades: 3,
    hp: 100,
    upgrades: { turrets: 1 },
    gear: { pistol: true, sword: true, welder: true, scanner: true, grenade: true },
    units: {},
    system: 0,
    shipPos: [0, 0, 0], shipQuat: [0, 0, 0, 1], placed: false,
    toggles: { shields: true, weapons: true, autopilot: false, redAlert: false, cloak: false, tractor: true, blast: false, lights: true },
    layout: {}, // per mode: { bridge, windows: [], armory }
    settings: { encounters: 'normal', voice: true, music: false, turnSpeed: 1, skin: false },
    stats: { kills: 0, scans: 0, jumps: 0, earned: 0, boarders: 0 },
    discovered: [0],
    scanned: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s && s.v === 1) return { ...newGame(), ...s, settings: { ...newGame().settings, ...s.settings }, toggles: { ...newGame().toggles, ...s.toggles } };
  } catch (e) { /* storage blocked or corrupt */ }
  return null;
}

export const S = load() || newGame();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
}
export function resetGame() {
  try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  location.reload();
}
setInterval(save, 10000);
addEventListener('beforeunload', save);

export const lvl = (k) => S.upgrades[k] || 0;
export const units = (k) => S.units[k] || 0;

// Derived ship stats from upgrade levels.
export const stat = {
  get shieldMax() { return 100 + 60 * lvl('shields') + 40 * units('shieldbot'); },
  get shieldRegen() { return 4 + 2.5 * lvl('shields') + 4 * units('shieldbot'); },
  get hullMax() { return 100 + 60 * lvl('hull'); },
  get energyMax() { return 100 + 40 * lvl('reactor'); },
  get energyRegen() { return (7 + 3 * lvl('reactor')) * (units('engineer') ? 1.3 : 1); },
  get phaserDmg() { return 22 + 10 * lvl('phasers'); },
  get phaserCooldown() { return Math.max(0.35, 0.9 - 0.1 * lvl('phasers')); },
  get turretRate() { return lvl('turrets') ? 2.4 - 0.4 * lvl('turrets') : 0; },
  get missilesMax() { return 4 + 2 * lvl('missiles'); },
  get missileDmg() { return 120 + 40 * lvl('missiles'); },
  get maxSpeed() { return 60 + 30 * lvl('engines'); },
  get boost() { return lvl('pulse') ? 4 + 4 * lvl('pulse') : 1; },
  get warpRange() { return 1.6 + 0.9 * lvl('warp'); },
  get pointDefense() { return 0.25 * lvl('pointdef'); },
  get hullRegen() { return 0.6 * lvl('nanites'); },
  get scanMult() { return 1 + 0.5 * lvl('scanner'); },
  get radarRange() { return 1500 + 800 * lvl('scanner'); },
  get hpMax() { return 100 + 40 * lvl('armor'); },
};

export function addCredits(n, why) {
  S.credits = Math.max(0, Math.round(S.credits + n));
  if (n > 0) S.stats.earned += n;
  emit('credits', n, why);
}

function spend(price) {
  if (S.credits < price) { emit('toast', 'Not enough credits', 'warn'); emit('sfx', 'deny'); return false; }
  S.credits -= price;
  emit('sfx', 'buy');
  emit('credits', -price);
  return true;
}

export function buyUpgrade(key) {
  const l = lvl(key);
  if (l >= UPGRADES[key].max) return false;
  if (!spend(upgradePrice(key, l))) return false;
  S.upgrades[key] = l + 1;
  if (key === 'hull') S.hull += 60;
  if (key === 'missiles') S.missiles += 2;
  emit('toast', `${UPGRADES[key].name} upgraded to Mk ${l + 2}`);
  emit('say', `${UPGRADES[key].name} installed.`);
  emit('upgrade', key);
  save();
  return true;
}

export function buyGear(key) {
  if (S.gear[key]) return false;
  if (!spend(GEAR[key].price)) return false;
  S.gear[key] = true;
  emit('toast', `${GEAR[key].name} delivered to the armory`);
  emit('gear', key);
  save();
  return true;
}

export function buySupply(key) {
  if (key === 'repair') {
    const need = Math.ceil(stat.hullMax - S.hull);
    if (need <= 0) { emit('toast', 'Hull already at full integrity'); return false; }
    const cost = need * 2;
    if (!spend(cost)) return false;
    S.hull = stat.hullMax;
    emit('toast', 'Hull repaired');
    emit('repairAll');
  } else if (key === 'torpedo') {
    if (S.missiles >= stat.missilesMax) { emit('toast', 'Torpedo bay is full'); return false; }
    if (!spend(SUPPLIES.torpedo.price)) return false;
    S.missiles++;
  } else if (key === 'warpcell') {
    if (!spend(SUPPLIES.warpcell.price)) return false;
    S.warpCells++;
  } else if (key === 'grenades') {
    if (!spend(SUPPLIES.grenades.price)) return false;
    S.grenades += 3;
    emit('gear', 'grenade');
  }
  save();
  return true;
}

export function buyUnit(key) {
  const u = UNITS[key];
  if (units(key) >= u.max) { emit('toast', `Maximum ${u.name}s reached`); return false; }
  if (!spend(u.price)) return false;
  S.units[key] = units(key) + 1;
  emit('toast', `${u.name} activated`);
  emit('say', `${u.name} online.`);
  emit('unit', key);
  save();
  return true;
}

export function clampShip() {
  S.hull = clamp(S.hull, 0, stat.hullMax);
  S.shield = clamp(S.shield, 0, stat.shieldMax);
  S.energy = clamp(S.energy, 0, stat.energyMax);
  S.hp = clamp(S.hp, 0, stat.hpMax);
}

export function layout() {
  return (S.layout[G.mode] ||= { bridge: null, windows: [], armory: null });
}
