# Survival Legends: Reborn

An online multiplayer 3D battle royale that runs in your web browser. Drop from an airship onto an island, find weapons, and be the last legend standing while a storm closes in.

**Status: Phase 1 playable prototype.** The battle royale loop works end to end: lobby, airship drop, looting, shooting, the shrinking storm, and a victory screen, with real multiplayer. Building, survival meters, RPG classes, quests and the open world are planned for later phases and are **not in this build** (see [Roadmap](#roadmap)).

---

## Play it

### Windows (easiest)

1. Install **Node.js** (the LTS version) from <https://nodejs.org> if you don't have it.
2. Download this project: green **Code** button → **Download ZIP**, then unzip it.
3. Double-click **`start.bat`**. A server window opens and the game opens in your browser.
4. Type a name, press **PLAY**, click the world, and you're in the warm-up lobby.

> **Tip:** Unzip it somewhere like `C:\Games\`. Windows' ransomware protection (Controlled Folder Access) can block the server from saving stats if the folder is inside Documents or Desktop.

### macOS / Linux / command line

```bash
node server/index.js          # normal match timings
node server/index.js --quick  # short storm phases, good for testing
```

Then open <http://localhost:3000>. There are no packages to install. The project has **zero npm dependencies**, and Three.js is bundled in `client/vendor/`.

Options: `--port 3000`, `--seed 1234` (pick a map layout), `--quick`.

### Play with friends

- **Same Wi-Fi / LAN:** the server window prints addresses like `http://192.168.1.20:3000`. Friends open that address in their browser. Windows may ask you to allow Node.js through the firewall; allow it on *private* networks.
- **Over the internet:** the host needs to forward TCP port 3000 on their router, or use a tunnelling service. Only share your address with people you trust.
- **Solo:** the party leader can add up to 15 bots in the lobby and press **START MATCH**.

### Multiple clients on one PC

Open several browser windows (or one normal + one private window) to `http://localhost:3000`. Each window is a separate player. Use different browsers or private windows, because two tabs in the same browser profile share one account and the newer tab takes over.

---

## Controls

| Key | Action |
|---|---|
| W A S D | Move |
| Mouse | Look / aim |
| Left click | Fire · use selected healing item |
| Right click (hold) | Aim down sights (scope on the DMR) |
| Shift | Sprint |
| Space | Jump · jump out of the airship |
| C / Ctrl | Crouch · dive while gliding |
| R | Reload |
| E | Pick up |
| G | Drop selected item |
| 1–5 / mouse wheel | Select inventory slot |
| M | Full map |
| Tab (hold) | Player list |
| Enter | Chat |
| Esc | Pause / lobby menu |

---

## What's in this build

### Working

- **Online multiplayer** with a dedicated, server-authoritative Node.js game server (30 Hz simulation), up to 16 players per match (humans + bots).
- **Third-person movement:** walk, sprint, crouch, jump, step up stairs, fall damage, slower movement in water, and an over-the-shoulder camera that avoids clipping through walls.
- **Netcode:** client-side prediction with server reconciliation for your own character, interpolation for other players, and lag-compensated hit detection (up to 300 ms rewind).
- **Match flow:** warm-up lobby → ready-up or leader start → countdown → airship flight → jump and glide (dive to land faster) → loot and fight → shrinking storm (6 phases, 5 in quick mode) → victory → results → back to the lobby.
- **Combat:** 5 hitscan weapons (pistol, SMG, assault rifle, shotgun, DMR with a scope), 6 rarity tiers (Common to Mythic), headshots, damage falloff, spread, recoil, reloads, hit markers, damage numbers, damage-direction indicators, killfeed.
- **Health and shields:** shields absorb gunfire first; storm and fall damage bypass them. Bandages, med kits, shield cells and shield packs, each with use times and caps.
- **Loot:** location-based loot tables (towns and the city have better gear), ammo types, 5-slot inventory, stacking, weapon swapping, dropping, and death drops.
- **Teams:** Solo, Duos or Squads, with no friendly fire, teammate health bars and teammate markers.
- **Bots:** server-side AI that loots, heals, rotates with the storm and fights, using the same validated actions as human players.
- **World:** a 480 × 480 m island with 5 visual biomes (Verdant Frontier, Neon District, Ashen Wastes, Frostfall Mountains, Forgotten Kingdom) and 8 named locations (Mossbridge, Lumen Heights, Old Crown Keep, Cinder Works, Frostgate Station, and more). Buildings have doors and upper floors with stairs. The layout is fixed so players can learn it; building placement and loot vary with the seed.
- **Accounts and progression:** automatic guest accounts with persistent stats (matches, wins, eliminations, damage, best placement), XP and levels, saved to `data/accounts.json`. Rewards are granted exactly once per match.
- **Reconnection:** if your connection drops mid-match, your character stays in the world for 45 seconds and you rejoin as the same player.
- **UI:** main menu, lobby with leader controls, HUD (health/shield, hotbar, ammo, minimap, compass, storm timer, alive count, ping), full map, chat, scoreboard, death/spectate screen, results screen, pause menu, settings (sensitivity, aim sensitivity, FOV, volume, render scale, shadows, invert Y, FPS counter), controls screen.
- **Audio:** synthesized sound effects for weapons, hits, footsteps, the storm, pickups and victory/defeat, with positional stereo panning. No audio files needed.

### Security and fairness (server side)

The client only sends inputs and requests. The server decides everything that matters.

- Movement is simulated on the server; an input-rate budget blocks speed hacks.
- Damage, ammo, fire rate, aim direction, pickups (distance-checked), healing, inventory, loot, eliminations, placements and rewards are all decided by the server.
- Per-connection message rate limits (abusive clients are disconnected), message size limits, protocol version checks, and sanitized names and chat.
- One active session per account. Account tokens are stored only as SHA-256 hashes.
- The static file server blocks path traversal.

No anti-cheat can stop every cheat; this covers the common client-side manipulation attacks.

### Placeholders and limitations (be aware)

- **Art is placeholder:** characters, weapons and buildings are built from simple shapes in code. There are no textures, character animations beyond procedural limb swings, or music.
- **Biomes are visual only:** no temperature, hazards or biome-specific resources yet.
- **Guest accounts only:** an account is a secret token in your browser's local storage. Clearing browser data creates a new account. There are no passwords, email login, friends list or parties.
- **One match per server:** each server process runs one lobby/match at a time. No matchmaking across servers or regions.
- **Keyboard and mouse only:** no controller or touch support yet.
- **Tested scale:** automated tests cover 2 human clients plus bots, and up to 16 players are supported per match. A 100-player match would need load testing and optimization first.
- **Desktop browsers:** tested with Microsoft Edge (Chromium). Chrome should behave the same; Firefox and Safari have not been tested.
- **Spectating** follows other players with a free orbit camera, not their exact view.

---

## How it works

```
Browser (client)                         Node.js (server, authoritative)
────────────────                         ───────────────────────────────
input @60 Hz ── WebSocket ─────────────▶ input queue → shared movement sim
prediction (shared/physics.js)            hit detection with lag compensation
reconciliation ◀── snapshots @30 Hz ───── health, inventory, loot, storm
interpolated remote players               match lifecycle, bots, accounts
Three.js rendering, HUD, audio            rate limits & validation
```

The **same movement code** (`shared/physics.js`) and **same world generator** (`shared/world.js`) run on both sides. That's what lets the client predict its own movement without waiting for the server, and lets the server verify it.

### Project structure

```
start.bat              Windows launcher (finds Node, starts server, opens browser)
server/
  index.js             HTTP static server, WebSocket endpoint, tick loop, rate limits
  websocket.js         Small built-in WebSocket (RFC 6455) server, no npm needed
  match.js             Authoritative match: lifecycle, inputs, combat, inventory, snapshots
  combat.js            Hitboxes, ray tests, lag-compensation history, damage model
  storm.js             Shrinking storm phases
  loot.js              Loot tables and inventory rules
  bots.js              Server-side bot AI
  accounts.js          Guest accounts, stats, XP, one-time rewards
shared/
  config.js            All balance numbers: weapons, items, storm, movement, XP
  world.js             Deterministic island generator, terrain, raycasts
  physics.js           Character movement and collision (client + server)
client/
  index.html, style.css
  main.js              Networking, prediction, interpolation, camera, input, UI flow
  render.js            Three.js scene: terrain, buildings, characters, loot, effects
  hud.js               HUD, minimap, full map
  audio.js             Procedural Web Audio sound effects
  vendor/              Three.js r169 (MIT license)
tests/                 Automated tests (node:test)
tools/browser-smoke.js Headless-browser smoke test
data/                  Created at runtime: accounts.json (not committed)
```

Balance tuning (weapon damage, fire rates, storm timings, movement speeds) lives in **`shared/config.js`**.

---

## Testing

```bash
node --test "tests/*.test.js"     # or: npm test
```

**22 automated tests**, all passing (run 3 times in a row with no flakes):

- **Movement physics:** gravity, walking and sprinting speeds, yaw direction, wall collision, stair stepping, jump height, fall damage vs. gliding, and identical results on client and server.
- **Match logic:** full lifecycle (lobby → ship → glide → combat → victory → one-time rewards → lobby), shooting with fire-rate and aim validation, malformed payloads, shields, friendly fire, refusing to start a match with only one team, pickup distance and double pickup, healing timing and caps, speed-hack input flood, disconnect/reconnect, reconnect timeout, and a bots-only match that plays to a winner.
- **End-to-end networking:** a real server and real WebSocket clients. Two players join and see each other, movement replicates, the host starts a match, a server-validated shot lands, a forged shot is rejected, a player reconnects as the same character, the match ends with correct placements and stats, and version mismatches and message floods are rejected. Also checks that path traversal on the file server returns 404.

**Browser smoke test** (needs Edge or Chrome and a running server):

```bash
node server/index.js --quick --port 3000
node tools/browser-smoke.js --url http://localhost:3000
```

This drives a real headless browser through menu → lobby → walking → match start with bots → airship → glide → landing → firing → map, saving screenshots to `smoke-out/` and failing on any JavaScript error. Last result: all checks passed, with 0 console errors.

---

## Roadmap

Following the phased plan from the design document. Nothing below is implemented yet.

- **Phase 2 – Core battle royale:** supply drops, more weapons and attachments, revive/down state for teams, matchmaking across multiple match instances, spectating a player's own view, match history.
- **Phase 3 – Building and destruction:** gathering wood/stone/metal, walls/floors/ramps/roofs with server-side placement validation, structure health, repair.
- **Phase 4 – Survival and crafting:** hunger, thirst, temperature, crafting recipes, wildlife, biome hazards (blizzards, heat, toxic zones).
- **Phase 5 – RPG progression:** Warrior/Engineer/Scout/Medic/Hunter classes and skill trees (normalized in competitive modes), quests, NPCs and factions, dungeons and bosses.
- **Phase 6 – Social and live world:** real accounts and login, friends and parties, clans, trading, public events, world bosses, custom matches, moderation tools (reporting, blocking).
- **Phase 7 – Production polish:** real art, animation and music, controller and touch support, accessibility (colorblind modes, remapping), load testing toward larger matches, deployment and monitoring.

---

## Credits and licenses

- Game code: © the Survival Legends: Reborn author. No open-source license has been chosen yet, so all rights are reserved.
- [Three.js](https://threejs.org) r169: MIT License, see `client/vendor/THREE-LICENSE.txt`.

All characters, locations, weapons and names in this game are original.
