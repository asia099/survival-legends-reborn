// Survival Legends: Reborn - dedicated game server.
// Serves the browser client over HTTP and runs one authoritative match over WebSockets.
//
//   node server/index.js [--port 3000] [--quick] [--seed 1234]

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from './websocket.js';
import { TICK_RATE, PROTOCOL_VERSION } from '../shared/config.js';
import { Match } from './match.js';
import { AccountStore } from './accounts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const STATIC_DIRS = { '/shared/': 'shared', '/': 'client' };

const RATE = { perSec: 120, burst: 240 };

function resolveStatic(urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  for (const [prefix, dir] of Object.entries(STATIC_DIRS)) {
    if (!urlPath.startsWith(prefix)) continue;
    const base = path.join(ROOT, dir);
    const file = path.normalize(path.join(base, decodeURIComponent(urlPath.slice(prefix.length))));
    if (!file.startsWith(base + path.sep)) return null; // path traversal
    return file;
  }
  return null;
}

export async function startServer({ port = 3000, quick = false, seed, dataFile, log = console.log, host = '0.0.0.0' } = {}) {
  const accounts = new AccountStore(dataFile === undefined ? path.join(ROOT, 'data', 'accounts.json') : dataFile);
  const match = new Match({ seed: seed ?? (Math.random() * 1e9) | 0, accounts, quick, log });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, phase: match.phase, players: match.players.size, time: match.time }));
      return;
    }
    const file = resolveStatic(url.pathname);
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });
  const sockets = new Map(); // ws -> player

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let tokens = RATE.burst, last = Date.now(), player = null;
    const send = (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const helloTimer = setTimeout(() => { if (!player) ws.close(4000, 'hello timeout'); }, 5000);

    ws.on('message', (data) => {
      const now = Date.now();
      tokens = Math.min(RATE.burst, tokens + ((now - last) / 1000) * RATE.perSec);
      last = now;
      if (--tokens < 0) { log(`[net] rate limit exceeded by ${player?.name ?? ip}`); ws.close(4008, 'rate limit'); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { tokens -= 20; return; }
      if (!player) {
        if (msg?.t !== 'hello') return;
        clearTimeout(helloTimer);
        if (msg.v !== PROTOCOL_VERSION) { send({ t: 'error', m: 'Client version mismatch - refresh the page.' }); ws.close(4001, 'version'); return; }
        const { account, token } = accounts.login(msg.token, msg.name);
        // One live session per account.
        const existing = match.findConnected(account.id);
        if (existing) {
          for (const [otherWs, p] of sockets) if (p === existing) { otherWs.close(4002, 'logged in elsewhere'); sockets.delete(otherWs); }
          match.disconnect(existing);
        }
        send({ t: 'welcome', token, profile: accounts.publicProfile(account) });
        const prev = match.findDisconnected(account.id);
        if (prev) { player = prev; match.reconnect(prev, send); }
        else player = match.addPlayer({ name: account.name, account, send });
        sockets.set(ws, player);
        log(`[net] ${player.name} connected from ${ip}`);
        return;
      }
      try { match.handleMessage(player, msg); }
      catch (e) { log('[match] error handling message', msg?.t, e); }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (player && sockets.get(ws) === player) {
        sockets.delete(ws);
        match.disconnect(player);
        log(`[net] ${player.name} disconnected`);
      }
    });
    ws.on('error', () => {});
  });

  // Fixed-rate simulation loop.
  const dt = 1 / TICK_RATE;
  let acc = 0, prev = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    acc += Math.min(0.25, (now - prev) / 1000);
    prev = now;
    while (acc >= dt) {
      acc -= dt;
      try { match.tick(dt); } catch (e) { log('[match] tick error', e); }
    }
  }, 1000 / TICK_RATE / 2);

  await new Promise((resolve) => server.listen(port, host, resolve));
  const actualPort = server.address().port;

  return {
    match, accounts, port: actualPort,
    close: () => new Promise((resolve) => {
      clearInterval(timer);
      accounts.saveNow();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const port = Number(arg('--port') ?? process.env.PORT ?? 3000);
  const seed = arg('--seed') !== undefined ? Number(arg('--seed')) : undefined;
  const quick = args.includes('--quick');
  const srv = await startServer({ port, seed, quick });
  console.log('');
  console.log('  Survival Legends: Reborn server running');
  console.log(`  Map seed: ${srv.match.seed}${quick ? '   (quick storm timings)' : ''}`);
  console.log(`  Play on this PC:      http://localhost:${srv.port}`);
  for (const ip of lanAddresses()) console.log(`  Play from your network: http://${ip}:${srv.port}`);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  const shutdown = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
