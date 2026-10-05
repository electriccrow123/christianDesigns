// Command terminal on the bridge console with a holographic keyboard you can poke or point at.
import { G, emit, on } from './core.js';
import { S, stat, buyUpgrade, buyGear, buySupply, buyUnit, save, resetGame } from './state.js';
import { UPGRADES, GEAR, SUPPLIES, UNITS } from './catalog.js';
import { CanvasPanel, roundRect } from './ui-panel.js';
import { ship, system, galaxy, engageWarp, setAutopilot, systemDist } from './space.js';
import { firePhasers, fireTorpedo, cycleTarget, startEncounter, startBoarding, enemies } from './combat.js';
import { say } from './audio.js';

const lines = [
  'STARHOME OS v4.7  //  Bridge Terminal',
  'Type HELP and press ENTER.',
  '',
];
let input = '';
let blink = 0;

function out(s) { for (const l of String(s).split('\n')) lines.push(l); while (lines.length > 200) lines.shift(); screen.dirty = true; }

export const screen = new CanvasPanel({
  width: 640, height: 400, interval: 0.5,
  draw(g, P) {
    g.fillStyle = '#010d08'; g.fillRect(0, 0, P.w, P.h);
    g.strokeStyle = '#1f8'; g.lineWidth = 4; g.strokeRect(2, 2, P.w - 4, P.h - 4);
    g.font = '19px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = '#3f9'; g.textBaseline = 'alphabetic';
    const shown = lines.slice(-16);
    shown.forEach((l, i) => g.fillText(l.slice(0, 58), 12, 28 + i * 21));
    blink++;
    g.fillStyle = '#8fc';
    g.fillText('> ' + input.slice(-52) + (blink % 2 ? '_' : ' '), 12, P.h - 14);
  },
});

const KEYS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫'],
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', '⏎'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '-', '.'],
  ['HELP', 'SPACE', 'STATUS'],
];
export const keyboard = new CanvasPanel({
  width: 1024, height: 340, interval: 0,
  draw(g, P) {
    g.clearRect(0, 0, P.w, P.h);
    g.fillStyle = 'rgba(0,30,40,0.55)'; roundRect(g, 0, 0, P.w, P.h, 16); g.fill();
    g.strokeStyle = 'rgba(47,214,255,0.8)'; g.lineWidth = 3; g.stroke();
    const kw = 84, kh = 56, gap = 8;
    KEYS.forEach((row, r) => {
      let widths = row.map((k) => (k === 'SPACE' ? 440 : k.length > 1 && k !== '⌫' && k !== '⏎' ? 190 : k === '⏎' ? 140 : kw));
      const total = widths.reduce((a, b) => a + b, 0) + gap * (row.length - 1);
      let x = (P.w - total) / 2;
      row.forEach((k, i) => {
        P.button(x, 12 + r * (kh + gap), widths[i], kh, k, () => press(k), { size: k.length > 2 ? 22 : 28, fill: 'rgba(10,50,70,0.6)' });
        x += widths[i] + gap;
      });
    });
  },
});
keyboard.pokeable = true;

function press(k) {
  emit('sfx', 'key');
  if (k === '⌫') input = input.slice(0, -1);
  else if (k === '⏎') submit();
  else if (k === 'SPACE') input += ' ';
  else if (k === 'HELP' || k === 'STATUS') { input = k.toLowerCase(); submit(); }
  else input += k.toLowerCase();
  screen.dirty = true;
}

export function typeKey(e) {
  if (e.key === 'Enter') submit();
  else if (e.key === 'Backspace') input = input.slice(0, -1);
  else if (e.key.length === 1) input += e.key.toLowerCase();
  screen.dirty = true;
}

function submit() {
  const cmd = input.trim();
  input = '';
  if (!cmd) return;
  out('> ' + cmd);
  try { run(cmd); } catch (e) { out('ERROR: ' + e.message); }
  screen.dirty = true;
}

const findKey = (obj, q) => Object.keys(obj).find((k) => k === q || obj[k].name.toLowerCase().replace(/[^a-z]/g, '').includes(q.replace(/[^a-z]/g, '')));

const JOKES = [
  'Why did the photon refuse to check a bag? It was traveling light.',
  'I tried to read a book about anti-gravity. I could not put it down.',
  'The pirates asked for our shield frequency. I told them it was on a need-to-know basis. They did not need to know.',
  'My favorite kind of music? Heavy metal asteroids.',
  'Captain, statistically, you are the best captain I have ever had. You are also the only one.',
];

function run(cmd) {
  const [c, ...rest] = cmd.toLowerCase().split(/\s+/);
  const arg = rest.join(' ');
  const toggle = (k, label) => {
    S.toggles[k] = arg ? ['on', 'up', 'arm', 'engage', '1'].includes(arg) : !S.toggles[k];
    emit('toggles'); emit('sfx', 'switch');
    out(`${label}: ${S.toggles[k] ? 'ON' : 'OFF'}`);
  };
  switch (c) {
    case 'help': case '?':
      out([
        'STATUS            ship report',
        'SHIELDS/WEAPONS/CLOAK/TRACTOR/BLAST [on|off]',
        'FIRE  TORPEDO  TARGET   combat',
        'SCAN              list nearby objects',
        'COURSE <n>        autopilot to object n from SCAN',
        'STOP              all stop',
        'MAP               list warp destinations',
        'WARP <name|#>     jump to a star system',
        'SHOP              list things to buy',
        'BUY <name>        buy an upgrade, gear, supply or unit',
        'SAY <text>  JOKE  SIM ATTACK  SIM BOARD  SAVE',
      ].join('\n'));
      break;
    case 'status': case 'report':
      out(`Hull ${Math.round(S.hull)}/${stat.hullMax}  Shields ${Math.round(S.shield)}/${stat.shieldMax}  Energy ${Math.round(S.energy)}/${stat.energyMax}`);
      out(`Credits ${S.credits}  Torpedoes ${S.missiles}/${stat.missilesMax}  Warp cells ${S.warpCells}  HP ${Math.round(S.hp)}`);
      out(`System ${system.sys.name} (danger ${system.sys.danger})  Speed ${Math.round(ship.speed)}  Hostiles ${enemies.length}`);
      break;
    case 'shields': toggle('shields', 'Shields'); break;
    case 'weapons': toggle('weapons', 'Weapons'); break;
    case 'cloak': toggle('cloak', 'Cloak'); break;
    case 'tractor': toggle('tractor', 'Tractor beam'); break;
    case 'blast': case 'shutters': toggle('blast', 'Blast shutters'); break;
    case 'alert': toggle('redAlert', 'Red alert'); break;
    case 'fire': case 'phasers': firePhasers(); out('Phasers fired.'); break;
    case 'torpedo': case 'missile': fireTorpedo(); out('Torpedo away.'); break;
    case 'target': cycleTarget(); out('Target: ' + (G.target?.name || 'none')); break;
    case 'scan': {
      const objs = [system.station.userData.target, ...system.planets.map((p) => p.userData.target), ...enemies.map((e) => e.obj.userData.target)];
      G.scanList = objs;
      objs.forEach((t, i) => out(`${i + 1}. ${t.name.padEnd(22)} ${Math.round(t.obj.position.distanceTo(ship.pos))} m`));
      out('Use COURSE <n> to fly there.');
      break;
    }
    case 'course': case 'goto': case 'autopilot': {
      const list = G.scanList || [system.station.userData.target, ...system.planets.map((p) => p.userData.target)];
      const n = parseInt(arg, 10);
      const t = n ? list[n - 1] : list.find((x) => x.name.toLowerCase().includes(arg));
      if (!t) { out('Unknown destination. Run SCAN first.'); break; }
      setAutopilot(t); out('Autopilot engaged: ' + t.name);
      break;
    }
    case 'stop': ship.throttle = 0; setAutopilot(null); emit('throttle', 0); out('All stop.'); break;
    case 'map': {
      const cur = galaxy[S.system];
      galaxy.map((s) => ({ s, d: systemDist(cur, s) })).filter((x) => x.s.id !== S.system && x.d <= stat.warpRange + 1.5).sort((a, b) => a.d - b.d).slice(0, 10)
        .forEach(({ s, d }) => out(`#${s.id} ${s.name.padEnd(12)} ${d.toFixed(1)} ly ${d <= stat.warpRange ? 'IN RANGE' : 'too far'}  danger ${s.danger}`));
      break;
    }
    case 'warp': case 'jump': {
      const n = parseInt(arg.replace('#', ''), 10);
      const dst = Number.isFinite(n) ? galaxy[n] : galaxy.find((s) => s.name.toLowerCase() === arg || s.name.toLowerCase().startsWith(arg));
      if (!dst) { out('Unknown system. Try MAP.'); break; }
      if (engageWarp(dst.id)) out('Warp engaged → ' + dst.name);
      break;
    }
    case 'shop':
      out('UPGRADES: ' + Object.values(UPGRADES).map((u) => u.name).join(', '));
      out('GEAR: ' + Object.entries(GEAR).filter(([, g]) => g.price).map(([, g]) => g.name).join(', '));
      out('SUPPLIES: ' + Object.values(SUPPLIES).map((u) => u.name).join(', '));
      out('UNITS: ' + Object.values(UNITS).map((u) => u.name).join(', '));
      break;
    case 'buy': {
      let k;
      if ((k = findKey(UPGRADES, arg))) out(buyUpgrade(k) ? 'Installed ' + UPGRADES[k].name : 'Purchase failed');
      else if ((k = findKey(GEAR, arg))) out(buyGear(k) ? 'Delivered ' + GEAR[k].name : 'Purchase failed');
      else if ((k = findKey(SUPPLIES, arg))) out(buySupply(k) ? 'Bought ' + SUPPLIES[k].name : 'Purchase failed');
      else if ((k = findKey(UNITS, arg))) out(buyUnit(k) ? 'Activated ' + UNITS[k].name : 'Purchase failed');
      else out('Nothing called "' + arg + '". Try SHOP.');
      break;
    }
    case 'say': say(arg || 'Hello captain.', true); out('ARIA: ' + arg); break;
    case 'joke': { const j = JOKES[Math.floor(Math.random() * JOKES.length)]; say(j, true); out('ARIA: ' + j); break; }
    case 'sim': case 'simulate':
      if (arg.startsWith('board')) { startBoarding(2); out('Boarding drill started.'); }
      else { startEncounter(true); out('Combat drill: hostiles spawned.'); }
      break;
    case 'save': save(); out('Game saved.'); break;
    case 'reset': if (arg === 'confirm') resetGame(); else out('Type RESET CONFIRM to erase your save.'); break;
    case 'hello': case 'hi': say('Hello, captain. All systems nominal.', true); out('ARIA: Hello, captain.'); break;
    case 'credits': out(`Credits: ${S.credits}`); break;
    default: out('Unknown command. Type HELP.');
  }
}

on('termOut', out);
