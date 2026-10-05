// STARHOME: your room is the bridge of a starship.
// Boot, WebXR session handling, desktop controls and the main loop.
import * as THREE from 'three';
import { G, emit, on, clamp } from './core.js';
import { S, stat, clampShip, save } from './state.js';
import { initAudio, say, setMusic } from './audio.js';
import { initInput, updateInput, pointers } from './input.js';
import { room, updateScan, startScan, refreshRoomVisuals, clampToRoom } from './room.js';
import { windowsGroup, loadWindows, updateWindows } from './windows.js';
import { initSpace, updateSpace, ship, system } from './space.js';
import { initCombat, updateCombat, firePhasers, fireTorpedo, cycleTarget } from './combat.js';
import { initItems, updateItems, ensureItems } from './items.js';
import { initBridge, updateBridge, setupDeck, bridge } from './bridge.js';
import { initTablet, openTab } from './ops.js';
import { initBots, updateBots } from './bots.js';
import { initFx, updateFx, initVignette, initToast } from './fx.js';
import { typeKey } from './terminal.js';

// ---------- renderer & scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.setClearColor(0x000000, 1);
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 40000);
camera.position.set(0, 1.6, 2);
scene.add(camera);
G.scene = scene; G.camera = camera; G.renderer = renderer;

const hemi = new THREE.HemisphereLight(0xcfe6ff, 0x2a3038, 1.6);
const ceiling = new THREE.DirectionalLight(0xffffff, 1.0);
ceiling.position.set(0.5, 3, 1);
const alertLight = new THREE.PointLight(0xff2010, 0, 9, 1.5);
alertLight.position.set(0, 2.4, 0);
scene.add(hemi, ceiling, alertLight, room.group, windowsGroup);

initFx(scene);
initVignette(camera);
initToast(scene);
initInput(renderer, scene, camera);
initSpace(scene);
initCombat();
initItems(scene);
initBridge(scene);
initTablet(camera);
G.bridgeObj = bridge;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- game start ----------
let started = false;
function startGame(mode) {
  G.mode = mode;
  document.body.classList.add('playing', 'mode-' + mode);
  scene.background = mode === 'ar' ? null : new THREE.Color(0x000000);
  renderer.setClearColor(0x000000, mode === 'ar' ? 0 : 1);
  started = true;
  startScan();
  setTimeout(() => say(mode === 'ar' ? 'Welcome aboard, captain. Scanning your quarters.' : 'Welcome aboard, captain.', true), 600);
}

on('roomReady', () => {
  loadWindows();
  setupDeck();
  ensureItems();
  if (!G.botsStarted) { G.botsStarted = true; initBots(); }
  refreshRoomVisuals();
  if (G.mode === 'desktop') sitDown();
  if (S.settings.music && S.units.dj) setMusic(true);
  setTimeout(() => emit('toast', G.mode === 'desktop'
    ? 'Click to look around. Tab opens the tablet. H shows controls.'
    : 'Pull the throttle lever or push the left stick to fly. Y opens your wrist tablet.'), 4000);
});

// ---------- WebXR ----------
const XR_INIT = {
  requiredFeatures: ['local-floor'],
  optionalFeatures: ['plane-detection', 'mesh-detection', 'hand-tracking', 'bounded-floor', 'anchors', 'hit-test'],
};

async function startXR(mode, offered) {
  initAudio();
  try {
    const session = offered || await navigator.xr.requestSession(mode === 'ar' ? 'immersive-ar' : 'immersive-vr', XR_INIT);
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    G.session = session;
    session.requestReferenceSpace('bounded-floor').then((s) => (G.bounded = s)).catch(() => {});
    session.addEventListener('end', () => { save(); location.reload(); });
    startGame(mode);
  } catch (e) {
    console.error(e);
    setStatus(`Could not start ${mode.toUpperCase()}: ${e.message || e}`, 'bad');
  }
}

const statusEl = document.getElementById('xr-status');
function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = cls; }
const btnAR = document.getElementById('btn-ar');
const btnVR = document.getElementById('btn-vr');
const btnDesk = document.getElementById('btn-desktop');

async function detectXR() {
  if (!navigator.xr) {
    setStatus(window.isSecureContext ? 'No VR headset browser detected. Open this page in your headset\'s browser (e.g. Meta Quest Browser) — or play the preview in this browser.' : 'WebXR needs HTTPS. Open this page over https:// (or localhost).', 'warn');
    return;
  }
  const [ar, vr] = await Promise.all([
    navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
    navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
  ]);
  btnAR.disabled = !ar; btnVR.disabled = !vr;
  if (ar) {
    setStatus('Headset connected. Mixed reality is ready — your room will be scanned and turned into the bridge.', 'good');
    btnAR.classList.add('pulse');
    // Ask the browser to prompt the player to enter immediately (supported on some headsets).
    if (navigator.xr.offerSession) {
      navigator.xr.offerSession('immersive-ar', XR_INIT).then((s) => startXR('ar', s)).catch(() => {});
    }
  } else if (vr) {
    setStatus('Headset connected (VR). Your play boundary becomes the bridge.', 'good');
    btnVR.classList.add('pulse');
    if (navigator.xr.offerSession) navigator.xr.offerSession('immersive-vr', XR_INIT).then((s) => startXR('vr', s)).catch(() => {});
  } else setStatus('Waiting for a headset... Connect one, or play the preview in this browser.', 'warn');
}
navigator.xr?.addEventListener?.('devicechange', detectXR);
detectXR();
btnAR.addEventListener('click', () => startXR('ar'));
btnVR.addEventListener('click', () => startXR('vr'));
btnDesk.addEventListener('click', () => { initAudio(); startGame('desktop'); renderer.domElement.requestPointerLock?.(); });

// ---------- desktop controls ----------
const keys = (G.keys = {});
const look = (G.look = { yaw: 0, pitch: 0 });
let seated = false;
const dp = pointers.desktop;

function sitDown() {
  const seat = bridge.localToWorld(new THREE.Vector3(0, 0, 0.85));
  camera.position.set(seat.x, room.floorY + 1.15, seat.z);
  look.yaw = bridge.rotation.y; look.pitch = -0.18;
  seated = true;
}
function standUp() { seated = false; camera.position.y = room.floorY + 1.65; }

renderer.domElement.addEventListener('click', () => { if (G.mode === 'desktop' && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock?.(); });
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousedown', (e) => {
  if (G.mode !== 'desktop' || !started) return;
  if (document.pointerLockElement !== renderer.domElement) return;
  if (e.button === 0) dp.trigger = true;
  if (e.button === 2) dp.squeeze = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) dp.trigger = false;
  if (e.button === 2) dp.squeeze = false;
});
addEventListener('mousemove', (e) => {
  if (G.mode !== 'desktop' || document.pointerLockElement !== renderer.domElement) return;
  if (dp.drag) {
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion); right.y = 0; right.normalize();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion); fwd.y = 0; fwd.normalize();
    dp.virt.addScaledVector(right, e.movementX * 0.0012).addScaledVector(fwd, -e.movementY * 0.0012);
    return;
  }
  look.yaw -= e.movementX * 0.0022;
  look.pitch = clamp(look.pitch - e.movementY * 0.0022, -1.45, 1.45);
});
addEventListener('wheel', (e) => { G.wheel = (G.wheel || 0) + e.deltaY; }, { passive: true });

let pulse = null; // one-frame button taps from the keyboard
addEventListener('keydown', (e) => {
  if (!started || G.mode !== 'desktop') return;
  if (G.typing) {
    if (e.key === 'Escape') { G.typing = false; document.body.classList.remove('typing'); }
    else typeKey(e);
    e.preventDefault();
    return;
  }
  keys[e.code] = true;
  switch (e.code) {
    case 'Tab': e.preventDefault(); emit('tablet'); break;
    case 'KeyT': G.typing = true; document.body.classList.add('typing'); e.preventDefault(); break;
    case 'KeyC': if (seated) standUp(); else sitDown(); break;
    case 'KeyG': pulse = 'squeeze'; break;
    case 'KeyE': pulse = 'trigger'; break;
    case 'Space': e.preventDefault(); firePhasers(); break;
    case 'KeyM': fireTorpedo(); break;
    case 'KeyN': cycleTarget(); break;
    case 'KeyH': document.getElementById('help').classList.toggle('show'); break;
    case 'KeyB': openTab('build'); if (!G.tablet.visible) emit('tablet'); break;
    case 'Escape': if (G.activeTool) { G.activeTool.cancel?.(); } break;
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

function updateDesktop(dt) {
  if (pulse && !pulse.startsWith('release-')) { dp[pulse] = true; pulse = 'release-' + pulse; }
  camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
  if (!seated) {
    const f = new THREE.Vector3(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
    const r = new THREE.Vector3(-f.z, 0, f.x);
    const mv = new THREE.Vector3();
    if (keys.KeyW) mv.add(f); if (keys.KeyS) mv.sub(f);
    if (keys.KeyD) mv.add(r); if (keys.KeyA) mv.sub(r);
    if (mv.lengthSq()) camera.position.addScaledVector(mv.normalize(), 2.2 * dt);
    clampToRoom(camera.position, 0.25);
    camera.position.y = room.floorY + 1.65;
  } else if (keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD) standUp();
}
function releasePulse() {
  if (pulse?.startsWith('release-')) { dp[pulse.slice(8)] = false; pulse = null; }
}

// ---------- HUD (desktop) ----------
const hud = document.getElementById('hud-stats');
let hudT = 0;
function updateHud(dt) {
  hudT -= dt;
  if (hudT > 0 || G.mode !== 'desktop') return;
  hudT = 0.2;
  const tgt = G.target?.obj?.parent ? ` · Target: ${G.target.name}` : '';
  hud.innerHTML = `<b>Hull</b> ${Math.round(S.hull)}/${stat.hullMax} · <b>Shields</b> ${Math.round(S.shield)} · <b>Energy</b> ${Math.round(S.energy)} · <b>HP</b> ${Math.round(S.hp)} · <b>${S.credits.toLocaleString()} cr</b> · ${Math.round(ship.speed)} m/s · ${system?.sys.name || ''}${tgt}${G.held ? ' · holding ' + G.held : ''}`;
  document.getElementById('crosshair').className = dp.hover ? 'hot' : '';
}

// ---------- main loop ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop((t, frame) => {
  const dt = Math.min(clock.getDelta(), 0.05);
  G.time += dt; G.dt = dt; G.frame = frame;
  camera.getWorldPosition(G.head);
  camera.getWorldQuaternion(G.headQuat);
  let refSpace = null;
  if (frame) {
    refSpace = renderer.xr.getReferenceSpace();
    G.refSpace = refSpace;
    if (G.bounded && !G.boundsPoly && G.bounded.boundsGeometry?.length >= 3) {
      const pose = frame.getPose(G.bounded, refSpace);
      if (pose) {
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        G.boundsPoly = G.bounded.boundsGeometry.map((p) => { const v = new THREE.Vector3(p.x, 0, p.z).applyMatrix4(m); return [v.x, v.z]; });
      }
    }
  }
  if (started) {
    if (G.mode === 'desktop') updateDesktop(dt);
    updateScan(frame, refSpace, dt);
    updateInput(dt);
    updateSpace(dt);
    updateBridge(dt);
    updateCombat(dt);
    updateItems(dt);
    updateBots(dt);
    updateWindows(dt);
    clampShip();
    // lighting: red alert pulse, lights switch
    const alert = S.toggles.redAlert;
    alertLight.intensity = alert ? 3 + 3 * Math.sin(G.time * 5) : 0;
    alertLight.position.set(room.center.x, room.floorY + room.height - 0.2, room.center.z);
    hemi.intensity = S.toggles.lights ? 1.6 : 0.35;
    ceiling.intensity = S.toggles.lights ? 1.0 : 0.1;
    G.held = dp.held?.name;
    updateHud(dt);
    if (G.mode === 'desktop') releasePulse();
  }
  updateFx(dt);
  renderer.render(scene, camera);
});

// debugging handle
window.STARHOME = { G, S, ship, room };
