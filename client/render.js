// Three.js presentation layer. Builds the world from the shared deterministic generator and
// draws characters, loot, effects, the storm and the transport ship. No gameplay decisions here.

import * as THREE from 'three';
import { MAP_SIZE, WATER_LEVEL, RARITIES, CONSUMABLES, PLAYER, SHIP } from '/shared/config.js';
import { BIOMES } from '/shared/world.js';

const BOX_STYLE = {
  floor:     { colors: ['#6e5a44', '#5f4d3b'], rough: 0.9 },
  wall:      { colors: ['#e0d2b6', '#d4c3a3', '#cbbfa8', '#e6dccb'], rough: 0.95 },
  cabin:     { colors: ['#8a5a3b', '#7a4e33', '#94664a'], rough: 0.9 },
  neon:      { colors: ['#4b5878', '#3c4766', '#58648a'], rough: 0.4, windows: true },
  metal:     { colors: ['#7d6a5a', '#6b5d52', '#8a7461'], rough: 0.7, metal: 0.3 },
  ruin:      { colors: ['#8d8a80', '#7f7c72', '#9a978c'], rough: 1 },
  roof:      { colors: ['#9c3d2e', '#3d5a7a', '#4a4a52', '#6b4a2e', '#2f6a5a'], rough: 0.8 },
  stairs:    { colors: ['#7a6248'], rough: 0.9 },
  rock:      { colors: ['#7c7f84', '#6f7176', '#888b90'], rough: 1 },
  crate:     { colors: ['#a37a45', '#946d3c'], rough: 0.9 },
  container: { colors: ['#b8432f', '#2f6db8', '#d6a32a', '#3f8a4a', '#8a3fb8'], rough: 0.6, metal: 0.4 },
  trunk:     { colors: ['#5b3f2a', '#4f3624'], rough: 1 },
};

const SHIRTS = ['#e85d4a', '#4a90e8', '#e8c24a', '#5ad17a', '#b05ae8', '#e87ab9', '#4ad1c9', '#f08a3c', '#7a8cff', '#c9e84a'];
const SKINS = ['#f1c7a5', '#d9a07a', '#a8714d', '#7a4b2f', '#e8b88f'];

function hash(x, z) {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function windowsTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0d1220'; g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const on = Math.random() < 0.45;
    g.fillStyle = on ? (Math.random() < 0.5 ? '#7fe8ff' : '#ff8ad8') : '#1b2438';
    g.fillRect(x * 16 + 3, y * 16 + 4, 10, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function glowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, inner); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export function makeWeaponMesh(type, rarity = 0) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2f36', roughness: 0.5, metalness: 0.6 });
  const accent = new THREE.MeshStandardMaterial({ color: RARITIES[rarity].color, emissive: RARITIES[rarity].color, emissiveIntensity: 0.6 });
  const wood = new THREE.MeshStandardMaterial({ color: '#7a5230', roughness: 0.8 });
  const box = (w, h, d, m, x = 0, y = 0, z = 0) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
  const dims = { pistol: [0.06, 0.12, 0.26], smg: [0.07, 0.13, 0.45], ar: [0.08, 0.14, 0.72], shotgun: [0.09, 0.12, 0.78], sniper: [0.07, 0.12, 1.0] }[type] ?? [0.07, 0.12, 0.4];
  const [w, h, d] = dims;
  box(w, h, d, dark, 0, 0, -d / 2 + 0.08);
  box(w * 1.05, h * 0.25, d * 0.6, accent, 0, h * 0.5, -d / 2 + 0.08);
  box(w * 0.8, 0.14, 0.06, dark, 0, -0.1, 0.02); // grip
  if (type !== 'pistol') box(w * 0.7, 0.16, 0.08, type === 'shotgun' ? wood : dark, 0, -0.12, -d * 0.35); // mag / pump
  if (type === 'ar' || type === 'sniper' || type === 'shotgun') box(w * 0.9, h * 0.9, 0.22, type === 'shotgun' ? wood : dark, 0, -0.02, 0.18); // stock
  if (type === 'sniper') {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.32, 10), dark);
    s.rotation.x = Math.PI / 2; s.position.set(0, h * 0.75, -0.3); g.add(s);
  }
  g.userData.muzzle = new THREE.Vector3(0, 0.02, -d + 0.08);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function nameTag(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 30px Segoe UI, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const w = Math.min(250, g.measureText(text).width + 24);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath(); g.roundRect((256 - w) / 2, 10, w, 44, 10); g.fill();
  g.fillStyle = color; g.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  s.scale.set(2.0, 0.5, 1);
  return s;
}

export class Avatar {
  constructor(id, name, { teammate = false, self = false } = {}) {
    this.group = new THREE.Group();
    const shirt = SHIRTS[id % SHIRTS.length];
    const skin = SKINS[(id * 7) % SKINS.length];
    const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
    const shirtM = mat(shirt), pantsM = mat('#2e3445'), skinM = mat(skin), bootM = mat('#1d1f24');
    const accentM = mat(new THREE.Color(shirt).multiplyScalar(0.6));

    this.legs = [];
    for (const sx of [-0.13, 0.13]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx, 0.92, 0);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.24), pantsM);
      leg.position.y = -0.4;
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.32), bootM);
      boot.position.set(0, -0.85, -0.04);
      pivot.add(leg, boot);
      this.group.add(pivot);
      this.legs.push(pivot);
    }
    this.upper = new THREE.Group();
    this.group.add(this.upper);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), shirtM);
    torso.position.y = 1.23;
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.08, 0.32), accentM);
    belt.position.y = 0.94;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.45, 0.18), accentM);
    pack.position.set(0, 1.25, 0.24);
    this.head = new THREE.Group();
    this.head.position.y = 1.62;
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skinM);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.21, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.1), accentM);
    hair.position.y = 0.02;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.06, 0.05), bootM);
    visor.position.set(0, 0.03, -0.18);
    this.head.add(headM, hair, visor);
    this.upper.add(torso, belt, pack, this.head);

    this.arms = [];
    for (const sx of [0.33, -0.33]) {
      const pivot = new THREE.Group();
      pivot.position.set(sx, 1.48, 0);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.58, 0.14), shirtM);
      arm.position.y = -0.29;
      const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), skinM);
      hand.position.y = -0.62;
      pivot.add(arm, hand);
      this.upper.add(pivot);
      this.arms.push(pivot);
    }
    this.weaponHolder = new THREE.Group();
    this.weaponHolder.position.set(0, -0.64, 0);
    this.weaponHolder.rotation.x = -Math.PI / 2;
    this.arms[0].add(this.weaponHolder);
    this.weaponKey = null;
    this.weapon = null;

    this.glider = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 1.1), new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.6 }));
    this.glider.position.y = 2.9;
    this.glider.visible = false;
    this.group.add(this.glider);

    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    if (!self) {
      this.tag = nameTag(name, teammate ? '#7dff9a' : '#ffffff');
      this.tag.position.y = 2.25;
      if (teammate) { this.tag.material.depthTest = false; this.tag.renderOrder = 10; }
      this.group.add(this.tag);
    }
    this.phase = 0;
    this.speed = 0;
    this.last = null;
  }

  setWeapon(code, weaponTypes) {
    if (code === this.weaponKey) return;
    this.weaponKey = code;
    if (this.weapon) { this.weaponHolder.remove(this.weapon); this.weapon = null; }
    if (code == null || code < 0) return;
    const type = weaponTypes[code >> 3], rarity = code & 7;
    if (!type) return;
    this.weapon = makeWeaponMesh(type, rarity);
    this.weaponHolder.add(this.weapon);
  }

  muzzleWorld(out) {
    if (!this.weapon) return this.group.localToWorld(out.set(0.35, 1.45, -0.7));
    return this.weapon.localToWorld(out.copy(this.weapon.userData.muzzle));
  }

  // x,y,z feet position; flags as in snapshots (1 crouch, 2 grounded, 32 glide)
  update(dt, x, y, z, yaw, pitch, flags) {
    const g = this.group;
    if (this.last) {
      const v = Math.hypot(x - this.last.x, z - this.last.z) / Math.max(dt, 1e-3);
      this.speed += (Math.min(v, 12) - this.speed) * Math.min(1, dt * 10);
    }
    this.last = { x, z };
    g.position.set(x, y, z);
    g.rotation.y = yaw;
    const crouch = (flags & 1) !== 0, glide = (flags & 32) !== 0;
    this.glider.visible = glide;
    this.upper.position.y = crouch ? -0.42 : 0;
    for (const l of this.legs) l.scale.y = crouch ? 0.55 : 1;
    for (const l of this.legs) l.position.y = crouch ? 0.5 : 0.92;
    this.phase += dt * this.speed * 2.2;
    const swing = (flags & 2) && !glide ? Math.sin(this.phase) * 0.7 * Math.min(1, this.speed / 5) : 0;
    this.legs[0].rotation.x = swing;
    this.legs[1].rotation.x = -swing;
    if (glide) {
      this.arms[0].rotation.set(Math.PI, 0, 0.2);
      this.arms[1].rotation.set(Math.PI, 0, -0.2);
    } else {
      const p = Math.max(-1.2, Math.min(1.2, pitch));
      this.arms[0].rotation.set(Math.PI / 2 + p, 0, 0);
      this.arms[1].rotation.set(Math.PI / 2 + p, 0, -0.55);
      this.head.rotation.x = p * 0.6;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }
}

export class Renderer {
  constructor(container, world, settings) {
    this.world = world;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog('#bcd3e6', 140, 560);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1500);
    this.camera.rotation.order = 'YXZ';

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#5e5040', 1.25);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight('#fff0d8', 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    this.scene.add(this.sun, this.sun.target);
    this.sunOffset = new THREE.Vector3(90, 160, 50);

    this.buildSky();
    this.buildTerrain();
    this.buildBoxes();
    this.buildDecor();
    this.buildWater();
    this.buildStorm();
    this.buildShip();

    this.lootGroup = new THREE.Group();
    this.scene.add(this.lootGroup);
    this.lootMeshes = new Map();
    this.fx = [];
    this.glowTex = glowTexture();
    this.flashTex = glowTexture('rgba(255,230,150,1)', 'rgba(255,140,40,0)');

    this.applySettings(settings);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  applySettings(s) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * s.renderScale);
    this.renderer.shadowMap.enabled = s.shadows;
    this.sun.castShadow = s.shadows;
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.baseFov = s.fov;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildSky() {
    const geo = new THREE.SphereGeometry(1200, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#2f6fc2') }, horizon: { value: new THREE.Color('#d6e8f5') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float k = pow(max(vP.y,0.0), 0.55); gl_FragColor = vec4(mix(horizon, top, k), 1.0); }',
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  buildTerrain() {
    const seg = 240;
    const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.world.heightAt(pos.getX(i), pos.getZ(i)));
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color(), c2 = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const b = BIOMES[this.world.biomeAt(x, z)];
      const n = hash(Math.floor(x / 3), Math.floor(z / 3));
      c.setRGB(...b.ground).lerp(c2.setRGB(...b.ground2), n * 0.8);
      const slope = 1 - nrm.getY(i);
      if (slope > 0.12) c.lerp(c2.set('#77736b'), Math.min(1, (slope - 0.12) * 4));
      if (y < WATER_LEVEL + 0.9) c.lerp(c2.set('#cdbd8b'), 0.75);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);
  }

  buildBoxes() {
    const byKind = new Map();
    for (const b of this.world.boxes) {
      if (!byKind.has(b.k)) byKind.set(b.k, []);
      byKind.get(b.k).push(b);
    }
    const unit = new THREE.BoxGeometry(1, 1, 1);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    const col = new THREE.Color();
    const winTex = windowsTexture();
    for (const [kind, list] of byKind) {
      const st = BOX_STYLE[kind] ?? BOX_STYLE.wall;
      const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: st.rough, metalness: st.metal ?? 0 });
      if (st.windows) { mat.map = winTex; mat.emissiveMap = winTex; mat.emissive = new THREE.Color('#ffffff'); mat.emissiveIntensity = 0.9; }
      const mesh = new THREE.InstancedMesh(unit, mat, list.length);
      list.forEach((b, i) => {
        p.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
        s.set(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
        m4.compose(p, q, s);
        mesh.setMatrixAt(i, m4);
        let hex = st.colors[Math.floor(hash(b.minX, b.minZ) * st.colors.length)];
        if (kind === 'rock') {
          const biome = this.world.biomeAt(p.x, p.z);
          hex = biome === 3 ? '#c9d3dc' : biome === 2 ? '#4a3b36' : hex;
        }
        mesh.setColorAt(i, col.set(hex));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
    }
  }

  buildDecor() {
    const trees = this.world.decor.filter((d) => d.type === 'tree' || d.type === 'pine_snow');
    const cone = new THREE.ConeGeometry(1, 1, 7);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const mesh = new THREE.InstancedMesh(cone, mat, trees.length * 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    let i = 0;
    for (const t of trees) {
      const snow = t.type === 'pine_snow';
      for (let k = 0; k < 2; k++) {
        p.set(t.x, t.y - 0.6 + k * 1.9 * t.s, t.z);
        const r = (2.6 - k * 0.9) * t.s;
        s.set(r, 3.4 * t.s, r);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r + k);
        m4.compose(p, q, s);
        mesh.setMatrixAt(i, m4);
        const h = hash(t.x, t.z);
        mesh.setColorAt(i, snow ? col.setRGB(0.75 + h * 0.1, 0.85, 0.85) : col.setRGB(0.18 + h * 0.1, 0.42 + h * 0.15, 0.2));
        i++;
      }
    }
    mesh.castShadow = true;
    this.scene.add(mesh);
  }

  buildWater() {
    const geo = new THREE.PlaneGeometry(MAP_SIZE * 3, MAP_SIZE * 3);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: '#2a6f9a', roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.82 });
    this.water = new THREE.Mesh(geo, mat);
    this.water.position.y = WATER_LEVEL;
    this.scene.add(this.water);
  }

  buildStorm() {
    const geo = new THREE.CylinderGeometry(1, 1, 1, 128, 1, true);
    this.stormMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: false,
      uniforms: { time: { value: 0 } },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: `uniform float time; varying vec2 vUv; varying vec3 vW;
        void main(){
          float a = atan(vW.z, vW.x);
          float s = sin(a*90.0 + time*1.5 + vW.y*0.05) * 0.5 + 0.5;
          float s2 = sin(a*37.0 - time*0.8 + vW.y*0.11) * 0.5 + 0.5;
          float alpha = 0.2 + 0.16 * s * s2;
          alpha *= smoothstep(0.0, 0.08, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
          vec3 col = mix(vec3(0.42,0.12,0.85), vec3(0.85,0.45,1.0), s*s2);
          gl_FragColor = vec4(col, alpha);
        }`,
    });
    this.storm = new THREE.Mesh(geo, this.stormMat);
    this.storm.visible = false;
    this.storm.renderOrder = 5;
    this.scene.add(this.storm);
  }

  setStorm(circle, time) {
    if (!circle) { this.storm.visible = false; return; }
    this.storm.visible = true;
    this.storm.position.set(circle.x, 120, circle.z);
    this.storm.scale.set(Math.max(0.5, circle.r), 420, Math.max(0.5, circle.r));
    this.stormMat.uniforms.time.value = time;
  }

  buildShip() {
    const g = new THREE.Group();
    const env = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshStandardMaterial({ color: '#d8dde6', roughness: 0.6 }));
    env.scale.set(7, 6, 22);
    const stripe = new THREE.Mesh(new THREE.SphereGeometry(1.01, 24, 16, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.1), new THREE.MeshStandardMaterial({ color: '#ffcf3f', emissive: '#553300' }));
    stripe.scale.copy(env.scale);
    const gondola = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 12), new THREE.MeshStandardMaterial({ color: '#3a4256', metalness: 0.4, roughness: 0.5 }));
    gondola.position.y = -7;
    const finM = new THREE.MeshStandardMaterial({ color: '#c0453a' });
    for (const [rx, rz] of [[0, 0], [0, Math.PI / 2]]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 5), finM);
      fin.position.z = 19; fin.rotation.set(rx, 0, rz);
      g.add(fin);
    }
    g.add(env, stripe, gondola);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.visible = false;
    this.ship = g;
    this.scene.add(g);
  }

  setShip(pos, dir) {
    if (!pos) { this.ship.visible = false; return; }
    this.ship.visible = true;
    this.ship.position.set(pos.x, SHIP.altitude + 9, pos.z);
    this.ship.rotation.y = Math.atan2(-dir.x, -dir.z);
  }

  // ---------------------------------------------------------------- loot

  addLoot(l) {
    if (this.lootMeshes.has(l.id)) return;
    const g = new THREE.Group();
    const item = l.item;
    let color = '#ffffff';
    if (item.kind === 'weapon') {
      color = RARITIES[item.rarity].color;
      const w = makeWeaponMesh(item.type, item.rarity);
      w.rotation.y = Math.PI / 2;
      w.position.y = 0.5;
      g.add(w);
      if (item.rarity >= 2) {
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 6, 1, true),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
        beam.position.y = 2.2;
        g.add(beam);
      }
    } else if (item.kind === 'item') {
      color = CONSUMABLES[item.type].color;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 0.32), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25 }));
      m.position.y = 0.45;
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.2), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      cross.position.y = 0.45;
      g.add(m, cross);
    } else {
      color = { light: '#e8d36b', medium: '#8fd16b', shells: '#e8836b', heavy: '#6bb9e8' }[item.type];
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.22), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
      m.position.y = 0.3;
      g.add(m);
    }
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), new THREE.MeshBasicMaterial({ map: this.glowTex, color, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.04;
    g.add(glow);
    g.position.set(l.x, l.y, l.z);
    g.userData.spin = g.children[0];
    g.userData.bob = Math.random() * 6;
    this.lootGroup.add(g);
    this.lootMeshes.set(l.id, g);
  }

  removeLoot(id) {
    const g = this.lootMeshes.get(id);
    if (!g) return;
    this.lootGroup.remove(g);
    g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.lootMeshes.delete(id);
  }

  clearLoot() { for (const id of [...this.lootMeshes.keys()]) this.removeLoot(id); }

  // ---------------------------------------------------------------- effects

  tracer(a, b, color = '#ffe9a8') {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 0.5) return;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 4, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    m.scale.y = len;
    this.scene.add(m);
    this.fx.push({ obj: m, life: 0.08, max: 0.08 });
  }

  flash(pos) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.position.copy(pos);
    s.scale.setScalar(0.7);
    this.scene.add(s);
    this.fx.push({ obj: s, life: 0.05, max: 0.05 });
  }

  puff(pos, color = '#cfc7b8', size = 0.5) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, depthWrite: false }));
    s.position.copy(pos);
    s.scale.setScalar(size);
    this.scene.add(s);
    this.fx.push({ obj: s, life: 0.3, max: 0.3, grow: 2 });
  }

  updateFx(dt) {
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        f.obj.geometry?.dispose?.();
        f.obj.material.dispose();
        this.fx.splice(i, 1);
        continue;
      }
      f.obj.material.opacity = f.life / f.max;
      if (f.grow) f.obj.scale.multiplyScalar(1 + f.grow * dt);
    }
  }

  // ---------------------------------------------------------------- frame

  render(dt, time, focus) {
    // Shadow camera follows the focus point.
    if (focus) {
      this.sun.position.set(focus.x + this.sunOffset.x, focus.y + this.sunOffset.y, focus.z + this.sunOffset.z);
      this.sun.target.position.set(focus.x, focus.y, focus.z);
      this.sky.position.set(focus.x, 0, focus.z);
    }
    for (const g of this.lootMeshes.values()) {
      const near = !focus || Math.abs(g.position.x - focus.x) + Math.abs(g.position.z - focus.z) < 140;
      g.visible = near;
      if (!near) continue;
      g.userData.spin.rotation.y += dt * 1.2;
      g.userData.spin.position.y = (g.userData.spin.userData.baseY ??= g.userData.spin.position.y) + Math.sin(time * 2 + g.userData.bob) * 0.08;
    }
    this.updateFx(dt);
    this.renderer.render(this.scene, this.camera);
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, visible: v.z < 1 && v.z > -1 };
  }
}
