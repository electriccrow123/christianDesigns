// Everything you can buy: ship upgrades, hand gear, supplies and AI crew units.

export const UPGRADES = {
  shields:  { name: 'Deflector Shields',     max: 5, base: 400, desc: '+60 shield capacity and faster recharge per level' },
  hull:     { name: 'Duranium Hull Plating', max: 5, base: 350, desc: '+60 hull integrity per level' },
  phasers:  { name: 'Phaser Array',          max: 5, base: 500, desc: 'More phaser damage and a faster recharge' },
  turrets:  { name: 'Auto-Turrets',          max: 4, base: 450, desc: 'Turrets fire on hostiles by themselves while WEAPONS is armed' },
  missiles: { name: 'Photon Torpedo Bay',    max: 4, base: 450, desc: '+2 torpedo capacity and +40 blast damage per level' },
  reactor:  { name: 'Antimatter Reactor',    max: 5, base: 400, desc: 'More energy capacity and regeneration' },
  engines:  { name: 'Impulse Engines',       max: 5, base: 300, desc: '+30 top speed per level' },
  pulse:    { name: 'Pulse Drive',           max: 3, base: 600, desc: 'Hold BOOST to cross a star system fast' },
  warp:     { name: 'Warp Core',             max: 4, base: 900, desc: 'Reach star systems further away' },
  pointdef: { name: 'Point-Defense Grid',    max: 3, base: 700, desc: 'Chance to shoot down incoming fire' },
  nanites:  { name: 'Repair Nanites',        max: 3, base: 650, desc: 'The hull slowly repairs itself' },
  scanner:  { name: 'Sensor Suite',          max: 3, base: 400, desc: 'Bigger scan rewards and longer radar range' },
  tractor:  { name: 'Tractor Beam',          max: 1, base: 900, desc: 'Pulls in salvage crates from destroyed ships' },
  cloak:    { name: 'Cloaking Device',       max: 1, base: 2500, desc: 'Enemies lose track of you while CLOAK is on (drains energy)' },
  armor:    { name: 'Personal Armor',        max: 3, base: 300, desc: '+40 max health for you per level' },
};

export function upgradePrice(key, level) {
  return Math.round(UPGRADES[key].base * Math.pow(1.65, level));
}

export const GEAR = {
  pistol:   { name: 'Blaster Pistol',   price: 0,    desc: 'Reliable sidearm. Pull the trigger to fire.' },
  sword:    { name: 'Plasma Saber',     price: 0,    desc: 'Swing it at boarders. Faster swings hit harder.' },
  welder:   { name: 'Fusion Welder',    price: 0,    desc: 'Aim at hull breaches and hold the trigger to repair.' },
  scanner:  { name: 'Analyzer',         price: 0,    desc: 'Aim through a window at planets, asteroids or ships and hold the trigger to scan.' },
  rifle:    { name: 'Pulse Rifle',      price: 600,  desc: 'Fully automatic. Hold the trigger.' },
  shotgun:  { name: 'Scatter Blaster',  price: 900,  desc: 'Seven-bolt spread for close quarters.' },
  riot:     { name: 'Riot Shield',      price: 500,  desc: 'Hold it up to block boarder fire.' },
  hammer:   { name: 'Arc Hammer',       price: 750,  desc: 'Heavy melee hit with an electric shockwave.' },
  grenade:  { name: 'Plasma Grenade',   price: 0,    desc: 'Pull the trigger to arm, then throw (let go of grip).', consumable: 'grenades' },
};

export const SUPPLIES = {
  torpedo:  { name: 'Photon Torpedo',  price: 60,  desc: 'Refill one torpedo' },
  warpcell: { name: 'Warp Cell',       price: 250, desc: 'Fuel for one warp jump' },
  grenades: { name: 'Grenade Crate',   price: 150, desc: '+3 plasma grenades' },
  repair:   { name: 'Hull Repair',     price: 0,   desc: 'Fully repair the hull (2 credits per point)' },
};

// AI crew units. `where` decides if they work inside your room or outside the ship.
export const UNITS = {
  cleaner:  { name: 'Custodian Bot',  where: 'room',  price: 250,  max: 2, desc: 'Sweeps up scrap and scorch marks and sells the salvage.' },
  chef:     { name: 'Chef Bot',       where: 'room',  price: 400,  max: 1, desc: 'Cooks meals on the console tray. Eat them to heal.' },
  repair:   { name: 'Repair Drone',   where: 'room',  price: 600,  max: 2, desc: 'Flies to hull breaches and welds them shut.' },
  security: { name: 'Sentinel Bot',   where: 'room',  price: 900,  max: 3, desc: 'Patrols the deck and shoots boarders.' },
  medic:    { name: 'Medic Bot',      where: 'room',  price: 700,  max: 1, desc: 'Follows you and heals you when you are hurt.' },
  engineer: { name: 'Engineer Bot',   where: 'room',  price: 800,  max: 1, desc: 'Tunes the reactor: +30% energy regeneration.' },
  gardener: { name: 'Hydroponics Bot',where: 'room',  price: 450,  max: 1, desc: 'Grows space crops and sells the harvest.' },
  dj:       { name: 'Lounge Bot',     where: 'room',  price: 300,  max: 1, desc: 'Plays generative space music.' },
  pet:      { name: 'Robo-Pup',       where: 'room',  price: 200,  max: 1, desc: 'A loyal mechanical dog. Follows you around.' },
  fighter:  { name: 'Combat Drone',   where: 'space', price: 1200, max: 4, desc: 'Escorts the ship and attacks hostiles.' },
  miner:    { name: 'Mining Drone',   where: 'space', price: 900,  max: 3, desc: 'Mines nearby asteroids for credits.' },
  science:  { name: 'Science Drone',  where: 'space', price: 700,  max: 2, desc: 'Surveys planets in the system for credits.' },
  shieldbot:{ name: 'Shield Drone',   where: 'space', price: 1100, max: 2, desc: 'Projects extra shield regeneration.' },
};
