import * as THREE from 'three';
import { indexAtS, frameAt, newFrame, type Track } from '../track/track.ts';
import { mulberry32, hashString } from '../track/random.ts';
import { FOG_GLSL, PALETTE_GLSL, intensityColor, shared } from './palette.ts';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const SKY_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uEnergy;
uniform float uBass;
uniform vec3 uHeat;
uniform vec3 uSunDir;
varying vec3 vDir;

float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 top = vec3(0.006, 0.004, 0.02);
  vec3 horizon = mix(vec3(0.05, 0.012, 0.1), uHeat * 0.18, 0.4);
  vec3 col = mix(horizon, top, smoothstep(-0.05, 0.55, h));
  col = mix(col, vec3(0.004, 0.002, 0.01), 1.0 - smoothstep(-0.5, 0.0, h));

  // Nebula
  float n = fbm(d * 2.2 + vec3(0.0, 0.0, uTime * 0.01));
  float n2 = fbm(d * 5.0 - vec3(uTime * 0.02, 0.0, 0.0));
  vec3 neb = mix(vec3(0.25, 0.05, 0.5), uHeat, 0.55) * pow(n, 3.0) * 1.4 + vec3(0.0, 0.25, 0.4) * pow(n2, 4.0) * 0.8;
  col += neb * (0.3 + uEnergy * 0.4);

  // Stars
  vec3 sp = d * 380.0;
  float st = hash(floor(sp));
  float star = step(0.9985, st) * (0.6 + 0.4 * sin(uTime * 3.0 + st * 100.0));
  col += vec3(star) * smoothstep(-0.1, 0.2, h);

  // Synthwave sun
  float sd = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9966, 0.9971, sd);
  vec3 sunUp = normalize(vec3(0.0, 1.0, 0.0) - uSunDir * uSunDir.y);
  float sy = dot(d - uSunDir * sd, sunUp) / 0.078; // -1..1 across the disc
  float bands = step(0.0, sin((sy * 14.0) + uTime * 1.5)) + step(0.25, sy);
  vec3 sunCol = mix(vec3(1.0, 0.18, 0.55), vec3(1.0, 0.85, 0.3), smoothstep(-0.8, 0.8, sy));
  col += sunCol * disc * min(1.0, bands) * (0.75 + uBass * 0.35);
  col += sunCol * pow(max(0.0, sd), 400.0) * (0.25 + uBeat * 0.2);
  col += uHeat * pow(max(0.0, sd), 12.0) * 0.12;

  gl_FragColor = vec4(col, 1.0);
}
`;

const CITY_VERT = /* glsl */ `
uniform float uBands[16];
uniform vec3 uPlayerPos;
attribute float aBand;
attribute float aSeed;
attribute float aHeat;
varying vec3 vLocal;
varying float vSeed;
varying float vHeat;
varying float vDist;
varying float vHeight;
void main() {
  vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float d = distance(base, uPlayerPos);
  float rise = 1.0 - smoothstep(700.0, 1250.0, d);
  float amp = uBands[int(aBand)];
  vec3 p = position;
  float scaleY = rise * (0.55 + amp * 0.9);
  p.y *= scaleY;
  vLocal = position;
  vSeed = aSeed;
  vHeat = aHeat;
  vHeight = length(instanceMatrix[1].xyz) * scaleY;
  vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const CITY_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uEnergy;
${PALETTE_GLSL}
${FOG_GLSL}
varying vec3 vLocal;
varying float vSeed;
varying float vHeat;
varying float vDist;
varying float vHeight;
void main() {
  vec3 heat = heatColor(vHeat + (vSeed - 0.5) * 0.3);
  float top = smoothstep(0.965, 0.99, vLocal.y);
  float y = vLocal.y * vHeight;
  float rows = step(0.72, fract(y / 3.0));
  float cols = step(0.5, fract((vLocal.x + vLocal.z) * 3.0 + vSeed * 7.0));
  float lit = step(0.55, fract(sin(floor(y / 3.0) * 12.9898 + vSeed * 78.233) * 43758.5453));
  float edge = smoothstep(0.44, 0.5, max(abs(vLocal.x), abs(vLocal.z)));
  vec3 col = vec3(0.01, 0.008, 0.025);
  col += heat * rows * cols * lit * 0.28;
  col += heat * edge * 0.25;
  col += heat * top * (0.9 + uBeat * 0.7);
  gl_FragColor = vec4(applyFog(col, vDist * 0.6), 1.0);
}
`;

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
varying float vDist;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const GRID_FRAG = /* glsl */ `
uniform vec3 uHeat;
uniform float uBeat;
uniform float uBass;
varying vec3 vWorld;
varying float vDist;
float line(float c) {
  float d = abs(fract(c + 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, max(fwidth(c), 1e-4) * 1.5, d);
}
void main() {
  vec2 g = vWorld.xz / 60.0;
  float l = max(line(g.x), line(g.y));
  float fade = 1.0 - smoothstep(300.0, 2400.0, vDist);
  vec3 col = uHeat * l * (0.08 + uBass * 0.14 + uBeat * 0.06) * fade;
  gl_FragColor = vec4(col, 1.0);
}
`;

const fr = newFrame();

export class Environment {
  group = new THREE.Group();
  sky: THREE.Mesh;
  grid: THREE.Mesh;
  private city: THREE.InstancedMesh;
  private shapes: { obj: THREE.LineSegments; spin: THREE.Vector3; mat: THREE.LineBasicMaterial; heat: number }[] = [];
  private disposables: { dispose(): void }[] = [];

  constructor(tr: Track) {
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      uniforms: { ...shared, uSunDir: { value: new THREE.Vector3(0.15, 0.1, -1).normalize() } },
      side: THREE.BackSide, depthWrite: false,
    });
    const skyGeo = new THREE.SphereGeometry(100, 48, 24);
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);

    const gridGeo = new THREE.PlaneGeometry(6000, 6000, 1, 1);
    gridGeo.rotateX(-Math.PI / 2);
    const gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT, fragmentShader: GRID_FRAG, uniforms: shared,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.grid = new THREE.Mesh(gridGeo, gridMat);
    this.grid.frustumCulled = false;
    this.group.add(this.grid);
    this.disposables.push(skyGeo, skyMat, gridGeo, gridMat);

    this.city = this.buildCity(tr);
    this.group.add(this.city);
    this.buildShapes(tr);
  }

  private buildCity(tr: Track): THREE.InstancedMesh {
    const rng = mulberry32(hashString(tr.seed + ':city'));
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.ShaderMaterial({ vertexShader: CITY_VERT, fragmentShader: CITY_FRAG, uniforms: shared });
    const spacing = 11;
    const max = Math.ceil((tr.length + 800) / spacing) * 2;
    const mesh = new THREE.InstancedMesh(geo, mat, max);
    const band = new Float32Array(max);
    const seed = new Float32Array(max);
    const heat = new Float32Array(max);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    // Spatial grid of track samples: a building must clear *every* part of the ride, not
    // just the section it was placed next to (the track dives, turns and loops back).
    const CELL = 40;
    const grid = new Map<string, number[]>();
    for (let i = 0; i < tr.count; i += 4) {
      const key = `${Math.floor(tr.pos[i * 3] / CELL)},${Math.floor(tr.pos[i * 3 + 2] / CELL)}`;
      let list = grid.get(key);
      if (!list) grid.set(key, (list = []));
      list.push(i);
    }
    const clears = (x: number, z: number, radius: number, bottom: number, top: number) => {
      const r = Math.ceil((radius + 20) / CELL);
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gz = cz - r; gz <= cz + r; gz++) {
          for (const i of grid.get(`${gx},${gz}`) ?? []) {
            const tx = tr.pos[i * 3], ty = tr.pos[i * 3 + 1], tz = tr.pos[i * 3 + 2];
            // Track, fences, the camera above it and the curtain below it all need room.
            if (Math.hypot(tx - x, tz - z) < radius + 16 && ty + 14 > bottom && ty - 12 < top) return false;
          }
        }
      }
      return true;
    };

    let n = 0;
    for (let d = -200; d < tr.length + 400 && n < max - 2; d += spacing) {
      frameAt(tr, indexAtS(tr, d), fr);
      // Loops and corkscrews get open sky around them.
      if (fr.uy < 0.75) continue;
      for (const side of [-1, 1]) {
        if (rng() < 0.3) continue;
        const off = 30 + Math.pow(rng(), 1.6) * 150;
        const w = 4 + rng() * 10;
        const below = 25 + rng() * 60;
        // Near the track, buildings stay below it so nothing ever crosses the ride.
        const maxH = off < 90 ? (below - 8) / 1.45 : 1e9; // 1.45 = max audio stretch in CITY_VERT
        const h = Math.min(maxH, 20 + rng() * 90 + (off > 80 ? rng() * 80 : 0));
        if (h < 6) continue;
        // Flat right vector so buildings stand upright regardless of track banking.
        const rx = -fr.fz, rz = fr.fx;
        const rl = Math.hypot(rx, rz) || 1;
        p.set(fr.px + (rx / rl) * off * side, fr.py - below, fr.pz + (rz / rl) * off * side);
        const depth = w * (0.6 + rng());
        if (!clears(p.x, p.z, Math.hypot(w, depth) / 2, p.y, p.y + h * 1.45)) continue;
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(fr.fx, fr.fz) + (rng() - 0.5) * 0.3);
        s.set(w, h, depth);
        m.compose(p, q, s);
        mesh.setMatrixAt(n, m);
        band[n] = Math.min(15, Math.floor((off - 22) / 150 * 12 + rng() * 4));
        seed[n] = rng();
        heat[n] = tr.intensity[Math.round(indexAtS(tr, d))];
        n++;
      }
    }
    mesh.count = n;
    geo.setAttribute('aBand', new THREE.InstancedBufferAttribute(band, 1));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(heat, 1));
    mesh.frustumCulled = false;
    this.disposables.push(geo, mat);
    return mesh;
  }

  private buildShapes(tr: Track) {
    const rng = mulberry32(hashString(tr.seed + ':shapes'));
    const geos = [
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.OctahedronGeometry(1, 0),
      new THREE.TorusGeometry(1, 0.25, 6, 12),
      new THREE.DodecahedronGeometry(1, 0),
      new THREE.TorusKnotGeometry(0.8, 0.22, 64, 6),
    ].map((g) => new THREE.EdgesGeometry(g));
    this.disposables.push(...geos);
    const count = Math.max(10, Math.floor(tr.length / 450));
    for (let i = 0; i < count; i++) {
      const d = (i + rng() * 0.8) * (tr.length / count);
      const idx = indexAtS(tr, d);
      frameAt(tr, idx, fr);
      const side = rng() < 0.5 ? -1 : 1;
      const off = 160 + rng() * 280;
      const size = 30 + rng() * 70;
      const mat = new THREE.LineBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const obj = new THREE.LineSegments(geos[Math.floor(rng() * geos.length)], mat);
      obj.position.set(
        fr.px + fr.rx * off * side + fr.ux * (rng() * 160 - 40),
        fr.py + fr.ry * off * side + 40 + rng() * 120,
        fr.pz + fr.rz * off * side,
      );
      obj.scale.setScalar(size);
      obj.rotation.set(rng() * 6, rng() * 6, rng() * 6);
      this.group.add(obj);
      this.shapes.push({ obj, mat, spin: new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.5), heat: tr.intensity[Math.round(idx)] });
      this.disposables.push(mat);
    }
  }

  update(camera: THREE.Camera, dt: number, bass: number, beat: number) {
    this.sky.position.copy(camera.position);
    this.grid.position.set(camera.position.x, camera.position.y - 220, camera.position.z);
    const c = new THREE.Color();
    for (const s of this.shapes) {
      s.obj.rotation.x += s.spin.x * dt;
      s.obj.rotation.y += s.spin.y * dt;
      s.obj.rotation.z += s.spin.z * dt;
      intensityColor(s.heat, c).multiplyScalar(0.35 + bass * 0.4 + beat * 0.2);
      s.mat.color.copy(c);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
