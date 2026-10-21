// Gameplay configuration shared by server and client.
// All balance numbers live here so they can be tuned without touching systems code.

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30;            // server simulation + snapshot rate (Hz)
export const INPUT_DT = 1 / 60;         // fixed movement step used by client prediction and server
export const INTERP_DELAY = 0.1;        // seconds remote entities are rendered in the past
export const MAX_REWIND = 0.3;          // lag-compensation cap (seconds)

export const MAP_SIZE = 480;            // world spans [-MAP_SIZE/2, MAP_SIZE/2] on X and Z
export const WATER_LEVEL = -1.2;

export const PLAYER = {
  radius: 0.4,
  height: 1.8,
  crouchHeight: 1.2,
  eyeHeight: 1.6,
  crouchEyeHeight: 1.05,
  walkSpeed: 5.5,
  sprintSpeed: 8.5,
  crouchSpeed: 3.0,
  waterSpeedMult: 0.6,
  groundAccel: 50,
  airAccel: 8,
  gravity: 24,
  jumpVelocity: 8.2,
  stepHeight: 0.55,
  terminalVelocity: 55,
  safeFallSpeed: 17,       // impact speed (m/s) above which fall damage applies
  fallDamagePerMps: 5,
  glideFallSpeed: 11,
  diveFallSpeed: 30,
  glideSpeed: 16,
  maxHealth: 100,
  maxShield: 100,
};

export const SHIP = { altitude: 140, speed: 24 };

// Input bitfield
export const IN = {
  FWD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16, SPRINT: 32, CROUCH: 64, AIM: 128,
};

export const RARITIES = [
  { id: 0, name: 'Common',    color: '#b4bcc6', dmg: 1.00, reload: 1.00 },
  { id: 1, name: 'Uncommon',  color: '#5bd16a', dmg: 1.05, reload: 0.97 },
  { id: 2, name: 'Rare',      color: '#4aa3ff', dmg: 1.10, reload: 0.94 },
  { id: 3, name: 'Epic',      color: '#b26bff', dmg: 1.15, reload: 0.91 },
  { id: 4, name: 'Legendary', color: '#ffb23e', dmg: 1.20, reload: 0.88 },
  { id: 5, name: 'Mythic',    color: '#ff4f7b', dmg: 1.25, reload: 0.85 },
];

export const AMMO = {
  light:  { name: 'Light Rounds',  pickup: 36, max: 360 },
  medium: { name: 'Medium Rounds', pickup: 30, max: 300 },
  shells: { name: 'Shells',        pickup: 10, max: 60 },
  heavy:  { name: 'Heavy Rounds',  pickup: 6,  max: 40 },
};

// Hitscan weapons. dmg is per pellet. spread is a cone half-angle in radians.
export const WEAPONS = {
  pistol: {
    name: 'Warden P9', ammo: 'light', dmg: 24, pellets: 1, rpm: 380, mag: 12, reload: 1.3,
    spread: 0.022, aimSpread: 0.006, range: 140, falloffStart: 35, falloffMin: 0.6,
    headMult: 1.75, auto: false, aimFov: 55,
  },
  smg: {
    name: 'Hornet SMG', ammo: 'light', dmg: 16, pellets: 1, rpm: 780, mag: 30, reload: 2.0,
    spread: 0.04, aimSpread: 0.022, range: 90, falloffStart: 20, falloffMin: 0.55,
    headMult: 1.5, auto: true, aimFov: 55,
  },
  ar: {
    name: 'Ranger AR', ammo: 'medium', dmg: 30, pellets: 1, rpm: 520, mag: 30, reload: 2.2,
    spread: 0.03, aimSpread: 0.007, range: 220, falloffStart: 60, falloffMin: 0.65,
    headMult: 1.75, auto: true, aimFov: 48,
  },
  shotgun: {
    name: 'Breacher 12', ammo: 'shells', dmg: 11, pellets: 9, rpm: 68, mag: 5, reload: 3.6,
    spread: 0.075, aimSpread: 0.06, range: 45, falloffStart: 10, falloffMin: 0.35,
    headMult: 1.5, auto: false, aimFov: 58,
  },
  sniper: {
    name: 'Longshot DMR', ammo: 'heavy', dmg: 98, pellets: 1, rpm: 38, mag: 4, reload: 2.8,
    spread: 0.06, aimSpread: 0.0008, range: 500, falloffStart: 500, falloffMin: 1,
    headMult: 2.5, auto: false, aimFov: 20, scope: true,
  },
};

// Consumables. heal applies to health up to healCap; shield applies to shield up to shieldCap.
export const CONSUMABLES = {
  bandage:   { name: 'Field Bandage', heal: 15, healCap: 75,  useTime: 3.0, stack: 10, color: '#e8e2d0' },
  medkit:    { name: 'Med Kit',       heal: 100, healCap: 100, useTime: 7.0, stack: 3,  color: '#ff6b6b' },
  shieldcell:{ name: 'Shield Cell',   shield: 25, shieldCap: 50, useTime: 2.0, stack: 6, color: '#7fd4ff' },
  shieldpack:{ name: 'Shield Pack',   shield: 50, shieldCap: 100, useTime: 5.0, stack: 3, color: '#3a8bff' },
};

export const INVENTORY_SLOTS = 5;
export const PICKUP_RANGE = 3.0;

// Storm phases. Each phase: wait (seconds before shrinking), shrink (seconds to contract), target radius, damage/sec outside.
export const STORM_PHASES = [
  { wait: 70, shrink: 45, radius: 190, dps: 1 },
  { wait: 50, shrink: 40, radius: 115, dps: 2 },
  { wait: 40, shrink: 32, radius: 65,  dps: 4 },
  { wait: 30, shrink: 25, radius: 32,  dps: 6 },
  { wait: 25, shrink: 20, radius: 12,  dps: 9 },
  { wait: 20, shrink: 25, radius: 0,   dps: 14 },
];

// Shortened timings for local testing (`npm run dev` / --quick).
export const QUICK_STORM_PHASES = [
  { wait: 25, shrink: 20, radius: 150, dps: 2 },
  { wait: 20, shrink: 18, radius: 80,  dps: 4 },
  { wait: 15, shrink: 15, radius: 35,  dps: 7 },
  { wait: 12, shrink: 12, radius: 10,  dps: 10 },
  { wait: 10, shrink: 15, radius: 0,   dps: 16 },
];

export const MATCH = {
  minPlayersToAutoStart: 2,   // humans needed for the ready-up auto start
  maxPlayers: 16,
  countdown: 8,
  resultsDuration: 15,
  reconnectGrace: 45,         // seconds a disconnected player's character is kept in a running match
};

export const XP = {
  participation: 50,
  perKill: 30,
  win: 150,
  perPlacementAbove: 5,       // bonus per player outlasted
  perLevel: 500,
};
