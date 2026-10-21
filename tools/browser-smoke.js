// Automated browser smoke test. Launches headless Edge/Chrome, opens the game, joins,
// starts a match with bots, jumps from the ship, lands, fires, and captures screenshots
// plus every console error / uncaught exception.
//
//   node tools/browser-smoke.js --url http://localhost:3000 [--browser "C:\...\msedge.exe"] [--out smoke-out]
//
// Requires a running server. Uses only Node built-ins (fetch, WebSocket, child_process).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const url = arg('--url', 'http://localhost:3000');
const out = path.resolve(arg('--out', 'smoke-out'));
const candidates = [
  arg('--browser'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const browserPath = candidates.find((p) => existsSync(p));
if (!browserPath) { console.error('No Chrome/Edge found. Pass --browser <path>.'); process.exit(2); }
mkdirSync(out, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(path.join(tmpdir(), 'slr-smoke-'));
const browser = spawn(browserPath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
let id = 0;
const pending = new Map();
let ws;

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

async function evaluate(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(out, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`  screenshot: ${file}`);
}

async function waitUntil(expr, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const STATE = `(() => { const g = window.__slr; return g && {
  phase: g.phase, connected: g.connected, alive: g.alive, havePred: g.havePred, mode: g.pred.m,
  pos: [g.pred.x, g.pred.y, g.pred.z].map((v) => Math.round(v * 10) / 10), remotes: g.remotes.size, loot: g.loot.size,
  hp: g.hp, inv: g.inv && g.inv.slots.map((s) => s && (s.type + (s.mag != null ? ':' + s.mag : ''))),
  draws: g.renderer && g.renderer.renderer.info.render.calls, tris: g.renderer && g.renderer.renderer.info.render.triangles,
  webgl: !!(g.renderer && g.renderer.renderer.getContext()), pending: g.pending.length }; })()`;

async function main() {
  let list = null;
  for (let i = 0; i < 40 && !list; i++) {
    try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(250); }
  }
  const page = list?.find((t) => t.type === 'page');
  if (!page) throw new Error('could not attach to the browser');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') problems.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      problems.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Log.enable');

  console.log(`Browser: ${browserPath}`);
  console.log(`Opening ${url}`);
  await cdp('Page.navigate', { url: `${url}/` });
  await sleep(1500);
  await shot('01-menu');
  await cdp('Page.navigate', { url: `${url}/?autoplay=1&name=SmokeTest` });
  await waitUntil('!!(window.__slr && window.__slr.havePred)', 20000, 'joined lobby with predicted state');
  await sleep(1500);
  console.log('Lobby:', JSON.stringify(await evaluate(STATE)));
  await shot('02-lobby');

  // Walk forward for a second (pointer lock is unavailable headless, so set the input state directly).
  const beforeWalk = await evaluate(STATE);
  await evaluate('(() => { const g = window.__slr; g.locked = true; g.keys.add("KeyW"); g.keys.add("ShiftLeft"); })()');
  await sleep(1200);
  await evaluate('(() => { const g = window.__slr; g.keys.clear(); })()');
  await sleep(400);
  const afterWalk = await evaluate(STATE);
  console.log('After walking:', JSON.stringify(afterWalk));

  await evaluate('(() => { const g = window.__slr; g.send({ t: "settings", bots: 6, teamSize: 1 }); g.send({ t: "start" }); })()');
  await waitUntil('window.__slr.phase === "live" && window.__slr.havePred', 20000, 'match live');
  await sleep(1500);
  console.log('Ship:', JSON.stringify(await evaluate(STATE)));
  await shot('03-ship');

  await evaluate('window.__slr.jumpLatch = true');
  await waitUntil('window.__slr.pred.m === 1', 5000, 'gliding');
  await evaluate('window.__slr.pitch = -0.5');
  await sleep(2500);
  console.log('Gliding:', JSON.stringify(await evaluate(STATE)));
  await shot('04-glide');

  await evaluate('window.__slr.keys.add("KeyC")'); // dive
  await waitUntil('window.__slr.pred.m === 0', 30000, 'landed');
  await evaluate('(() => { const g = window.__slr; g.keys.clear(); g.pitch = -0.15; })()');
  await sleep(1200);
  console.log('Landed:', JSON.stringify(await evaluate(STATE)));
  await shot('05-landed');

  // Fire the starting pistol a few times through the normal client path.
  for (let i = 0; i < 4; i++) { await evaluate('(() => { const g = window.__slr; g.trigger = true; g.firing = true; g.tryFire(); g.firing = false; })()'); await sleep(350); }
  await sleep(500);
  const afterFire = await evaluate(STATE);
  console.log('After firing:', JSON.stringify(afterFire));
  await shot('06-fired');

  await evaluate('(() => { const g = window.__slr; g.mapOpen = true; document.getElementById("bigmap").classList.remove("hidden"); })()');
  await sleep(600);
  await shot('07-map');
  await evaluate('(() => { const g = window.__slr; g.mapOpen = false; document.getElementById("bigmap").classList.add("hidden"); })()');

  // Let bots play for a while and look for runtime errors.
  await sleep(8000);
  console.log('Later:', JSON.stringify(await evaluate(STATE)));
  await shot('08-later');

  const fpsProbe = await evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { if (++n >= 60) res(Math.round(60000 / (performance.now() - t0))); else requestAnimationFrame(f); }; requestAnimationFrame(f); })`);
  console.log(`Headless software-rendered FPS (not representative of a real GPU): ${fpsProbe}`);

  const checks = [
    ['walked > 3m in the lobby (prediction + server agree)', Math.hypot(afterWalk.pos[0] - beforeWalk.pos[0], afterWalk.pos[2] - beforeWalk.pos[2]) > 3 && afterWalk.pending < 30],
    ['pistol magazine decreased after firing', afterFire.inv && afterFire.inv[0] && Number(afterFire.inv[0].split(':')[1]) < 12],
    ['WebGL context active', afterFire.webgl],
    ['no uncaught exceptions', !problems.some((p) => p.startsWith('EXCEPTION'))],
  ];
  console.log('\nChecks:');
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`\nConsole problems (${problems.length}):`);
  for (const p of problems.slice(0, 30)) console.log('  ' + p);
  return checks.every(([, ok]) => ok);
}

main()
  .then((ok) => { browser.kill(); process.exit(ok ? 0 : 1); })
  .catch((e) => { console.error('SMOKE TEST ERROR:', e.message); for (const p of problems) console.log('  ' + p); browser.kill(); process.exit(1); });
