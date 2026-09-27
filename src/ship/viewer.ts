import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Ship } from '../render/ship.ts';
import { ITEM_SLOTS, loadoutKey, type Loadout } from './catalog.ts';

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const GRID_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCenter;
varying vec3 vWorld;
float line(float c) {
  float d = abs(fract(c + 0.5) - 0.5);
  return 1.0 - smoothstep(0.0, max(fwidth(c), 1e-4) * 1.5, d);
}
void main() {
  vec2 g = vWorld.xz / 3.0;
  float l = max(line(g.x), line(g.y));
  float fade = 1.0 - smoothstep(6.0, 22.0, distance(vWorld.xz, uCenter.xz));
  gl_FragColor = vec4(uColor * l * fade * 0.5, 1.0);
}
`;

function makeScene(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07030f);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.8;
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(3, 6, 4);
  const rim = new THREE.DirectionalLight(0x8a5cff, 1.5);
  rim.position.set(-4, 2, -5);
  scene.add(key, rim, new THREE.HemisphereLight(0x8a7bff, 0x100820, 0.7));
  return scene;
}

const OPTS = { power: 0.6, hurt: false, bass: 0, overdrive: false };
const SIDE = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Live 3D ship showcase: the ship flies forward over a neon grid, leaving its trail,
 * while the camera orbits it. Drag to spin the view.
 */
export class ShipViewer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  private composer: EffectComposer;
  private ship: Ship | null = null;
  /** previous ships, disposed only after the next render so their shader programs get reused */
  private retired: Ship[] = [];
  private grid: THREE.Mesh;
  private gridMat: THREE.ShaderMaterial;
  private raf = 0;
  private last = 0;
  private time = 0;
  private yaw = 0.6;
  private drag: number | null = null;
  private resizeObs: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement) {
    // No MSAA: the image goes through the bloom chain, which would drop it anyway.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = makeScene(this.renderer);
    this.gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT, fragmentShader: GRID_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0x8a5cff) }, uCenter: { value: new THREE.Vector3() } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), this.gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.scene.add(this.grid);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.35, 0.85));
    this.composer.addPass(new OutputPass());
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.renderer.setClearColor(0x07030f, 1);
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.resize();
  }

  private onDown = (e: PointerEvent) => { this.drag = e.clientX; };
  private onMove = (e: PointerEvent) => {
    if (this.drag === null) return;
    this.yaw -= (e.clientX - this.drag) * 0.01;
    this.drag = e.clientX;
  };
  private onUp = () => { this.drag = null; };

  private resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setLoadout(l: Loadout) {
    // Same parts and finish: just repaint the existing ship.
    if (this.ship && ITEM_SLOTS.every((s) => this.ship!.loadout[s.key] === l[s.key])) {
      this.ship.recolor(l);
      this.gridMat.uniforms.uColor.value.set(l.neon);
      return;
    }
    const z = this.ship?.root.position.z ?? 0;
    if (this.ship) {
      this.ship.removeFrom(this.scene);
      this.retired.push(this.ship);
    }
    this.ship = new Ship(l);
    this.ship.setUnderglow(false);
    this.ship.root.position.set(0, 1.2, z);
    this.ship.addTo(this.scene);
    this.gridMat.uniforms.uColor.value.set(l.neon);
  }

  start() {
    cancelAnimationFrame(this.raf);
    this.last = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      // Our own clock: a frame's rAF timestamp can predate a long setup and go negative.
      const now = performance.now();
      const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
      this.last = now;
      this.frame(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  private frame(dt: number) {
    this.time += dt;
    const ship = this.ship;
    if (!ship) return;
    // Fly forward so the trail streams out behind; the camera orbits and follows.
    ship.root.position.z -= 38 * dt;
    ship.root.position.y = 1.2 + Math.sin(this.time * 2) * 0.12;
    const vx = Math.sin(this.time * 0.9) * 14;
    ship.animate(vx, this.time, dt, OPTS);
    ship.root.updateMatrixWorld(true);
    ship.emitTrails(OPTS, this.time, SIDE, UP);
    if (this.drag === null) this.yaw += dt * 0.35;
    const p = ship.root.position;
    this.camera.position.set(p.x + Math.sin(this.yaw) * 9.5, p.y + 3.2, p.z + Math.cos(this.yaw) * 9.5);
    this.camera.lookAt(p.x, p.y - 0.2, p.z);
    this.grid.position.set(p.x, 0, p.z);
    this.gridMat.uniforms.uCenter.value.copy(p);
    this.composer.render(dt);
    // The new ship has now taken over the programs: the old ones can go.
    for (const r of this.retired) r.dispose();
    this.retired = [];
  }

  dispose() {
    this.stop();
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    if (this.ship) {
      this.ship.removeFrom(this.scene);
      this.ship.dispose();
    }
    for (const r of this.retired) r.dispose();
    this.grid.geometry.dispose();
    this.gridMat.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Thumbnails: one small offscreen renderer, cached per loadout
// ---------------------------------------------------------------------------

let thumbRenderer: THREE.WebGLRenderer | null = null;
let thumbScene: THREE.Scene | null = null;
const thumbCamera = new THREE.PerspectiveCamera(32, 16 / 10, 0.1, 100);
const thumbs = new Map<string, string>();
let lastThumbShip: Ship | null = null;

/** Render a 3/4 portrait of a ship into the shared offscreen renderer; returns its canvas. */
function renderThumb(l: Loadout): HTMLCanvasElement {
  if (!thumbRenderer) {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    thumbRenderer.setClearColor(0x000000, 0);
    thumbScene = makeScene(thumbRenderer);
    thumbScene.background = null;
  }
  const ship = new Ship(l);
  ship.setUnderglow(false);
  ship.animate(0, 1, 0.016, OPTS);
  thumbScene!.add(ship.root);
  thumbCamera.position.set(5.6, 3.4, -5.2);
  thumbCamera.lookAt(0, -0.1, 0.2);
  thumbRenderer.render(thumbScene!, thumbCamera);
  thumbScene!.remove(ship.root);
  // Keep the last ship alive until the next render: its shader programs are reused.
  lastThumbShip?.dispose();
  lastThumbShip = ship;
  return thumbRenderer.domElement;
}

/** A ship portrait as a data URL, cached (lobby cards, podium, hangar button). */
export function shipThumb(l: Loadout): string {
  const key = loadoutKey(l);
  const hit = thumbs.get(key);
  if (hit) return hit;
  const url = renderThumb(l).toDataURL('image/png');
  thumbs.set(key, url);
  return url;
}

/** Draw a ship portrait straight into a canvas: no image encoding (hangar tiles). */
export function drawShipThumb(l: Loadout, target: HTMLCanvasElement) {
  const src = renderThumb(l);
  const ctx = target.getContext('2d')!;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(src, 0, 0, target.width, target.height);
}
