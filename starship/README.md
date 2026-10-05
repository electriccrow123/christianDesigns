# 🚀 Starhome: your room is the bridge

A WebXR game for VR headsets that runs on a plain website. Open the page, connect your headset, and
Starhome scans your room, cuts windows into your walls that look out into space, and turns your home into a
starship. Put the flight console in front of your couch, fly through procedurally generated star systems,
fight pirates and boarding parties, and buy upgrades and AI crew for your ship.

No build step and no install: it is static HTML + JavaScript using [three.js](https://threejs.org) from a CDN.

## Play it online (Meta Quest 3)

**https://electriccrow123.github.io/christianDesigns/starship/**

Open that address in the **Meta Quest Browser**. To get it in your app library, open the browser's
menu (⋯) and choose **Install app** (or add it to bookmarks). The site is hosted free on GitHub Pages. To turn
Pages on once: GitHub repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick the
branch that has the `starship/` folder and the `/ (root)` folder, then **Save**. Every push to that branch updates the site.


| Where | How |
| --- | --- |
| **Meta Quest 3 / 3S / Pro (best)** | Do *Space Setup* in the headset settings first so it knows your walls and couch. Then open the site in the Quest Browser and press **Connect headset & scan my room**. The browser may also prompt you to enter right away. |
| **Other WebXR headsets** | Use **Enter VR**. Without a room scan, your play boundary (guardian) becomes the room. |
| **Desktop browser** | Press **Play in this browser** for a mouse & keyboard preview in a simulated room. |

WebXR only works over **HTTPS** (or `localhost`). Ways to run it:

```bash
node starship/serve.mjs            # http://localhost:8080 on this computer (desktop preview)

# Quest over USB: forward the port, then open http://localhost:8080 in the Quest Browser
adb reverse tcp:8080 tcp:8080
```

Or upload the `starship/` folder to any HTTPS static host (GitHub Pages, Netlify, Cloudflare Pages...).

## What's in the game

**Room scan & building**
- Uses WebXR *plane detection* and *mesh detection* to find walls, floor, ceiling, couches and tables, with a
  sweeping scan effect and labels. Falls back to your guardian boundary, or a default room.
- **Windows** on any wall: rectangular, porthole, panorama and hex. They are stencil "portals" into space.
  Add, resize and remove them from the **BUILD** tab.
- **Keep your real room** (passthrough), switch to **sci-fi hull walls**, or turn on the **Observation Deck**
  to make the whole hull see-through.
- Move the **bridge console** anywhere, or **link it to your couch** so you can sit and fly. Adjust the desk height.
- Move the **armory** rack to any wall.

**Bridge console**: throttle lever, flight joystick, toggle switches (shields, weapons, blast shutters, red alert,
tractor beam, cloak, lights), push buttons (phasers, torpedo, target, boost, stop, warp), a tactical radar,
a command terminal with a holographic keyboard you can poke, the main Ops screen, and **ARIA**, a hologram
ship AI that talks to you.

**Flying (No Man's Sky style)**: 48 procedurally generated star systems with planets (rocky, ocean, jungle,
lava, ice, desert, toxic, gas giants with rings), moons, asteroid belts, space stations and nebula skies.
Autopilot to any planet, Pulse Drive boost, and warp jumps between systems on the galaxy map.

**Combat**
- Pirate raiders, gunships and **boarding shuttles** that latch on and teleport boarders into your room.
- Ship weapons: phasers, auto-turrets, homing photon torpedoes, point defense, shields and a cloaking device.
- Hand weapons from the armory: blaster pistol, pulse rifle, scatter blaster, plasma saber, arc hammer, riot
  shield and plasma grenades. Swing the saber for real; faster swings hit harder.
- Hull breaches spark on your walls: fix them with the fusion welder.

**Economy**: earn credits from kills, salvage, mining asteroids, surveying planets with the Analyzer, and
discovering new systems. Spend them on:
- **15 ship upgrades** (shields, hull, phasers, auto-turrets, torpedo bay, reactor, engines, pulse drive, warp
  core, point defense, nanites, sensors, tractor beam, cloak, personal armor).
- **Gear and supplies** (new weapons, torpedoes, warp cells, grenades, hull repairs).
- **13 AI crew units**: Custodian Bot (cleans up scrap), Chef Bot (cooks meals you can eat to heal), Repair
  Drone (welds breaches), Sentinel Bot (fights boarders), Medic Bot, Engineer Bot (reactor boost),
  Hydroponics Bot (grows crops to sell), Lounge Bot (generative music and lights), Robo-Pup, plus Combat,
  Mining, Science and Shield drones that fly outside your windows.

Progress saves in the browser (localStorage).

## Controls

**VR controllers**: trigger = press / select / fire, grip = grab or drop an item, hold a lever. Poke buttons and
keys with your fingertip or controller tip. Left stick = throttle and roll, right stick = pitch and yaw, click a
stick = Pulse boost. **A** phasers, **B** torpedo, **X** next target, **Y** wrist tablet. Point at a ship or asteroid
and pull the trigger to lock on. Hand tracking works too (pinch to select, poke to press).

**Desktop**: click to look, WASD walk, C sit/stand, left click use, right click or G grab/drop, drag the throttle
and joystick, arrows pitch/yaw, Z/X roll, R/F throttle, Shift boost, Space phasers, M torpedo, N next target,
Tab tablet, B build mode, T type on the terminal, H help.

## Code map

```
index.html        landing page (headset detection, session start) and desktop HUD
js/main.js        renderer, WebXR session, desktop controls, main loop
js/core.js        shared context, events, helpers, stencil portal materials
js/room.js        room scanning (planes & meshes), fallback rooms, room surfaces
js/windows.js     wall windows (stencil portals), blast shutters, placement tools
js/space.js       galaxy & star system generation, flight, autopilot, warp
js/combat.js      enemies, ship weapons, shields, boarders, breaches, scrap
js/items.js       hand-held weapons and tools, armory rack
js/bridge.js      console controls, radar, ARIA, bridge placement
js/ops.js         Ops screen & wrist tablet: status, map, shop, crew, build, settings
js/terminal.js    command terminal and holographic keyboard
js/bots.js        AI crew units
js/input.js       controllers, hands and mouse as unified pointers
js/fx.js          particles, beams, damage flash, floating messages
js/audio.js       synthesized sound, engine hum, music, ship voice
js/state.js       save game, derived stats, purchases
js/catalog.js     upgrades, gear, supplies and units
```
