import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { frameAt, frameAtS, indexAtTime, laneX, newFrame, valueAt, type Block, type Track } from '../track/track.ts';
import type { RaceEvent, RaceSim } from '../game/sim.ts';
import { BlockField } from './blocks.ts';
import { Particles, Shockwaves, SpeedLines } from './effects.ts';
import { Environment } from './environment.ts';
import { Post } from './post.ts';
import { GEM_COLOR, GREY_COLOR, TIER_COLORS, intensityColor, shared } from './palette.ts';
import { Ship } from './ship.ts';
import { TrackMesh } from './trackMesh.ts';
import { TrailField } from './trails.ts';
import { DEFAULT_LOADOUT, type Loadout } from '../ship/catalog.ts';

export interface FrameInput {
  time: number;
  dt: number;
  bands: Float32Array;
  bass: number;
  energy: number;
}

const f0 = newFrame();
const f1 = newFrame();
const f2 = newFrame();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const v3 = new THREE.Vector3();
const tmpColor = new THREE.Color();
const HURT = new THREE.Color(1, 0.15, 0.2);
const MULT_COLOR = new THREE.Color(1, 0.82, 0.3);

export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 4000);
  post: Post;
  private track: Track | null = null;
  private trackMesh: TrackMesh | null = null;
  private blocks: BlockField | null = null;
  private trails: TrailField | null = null;
  private env: Environment | null = null;
  private ship: Ship | null = null;
  private particles = new Particles();
  private waves = new Shockwaves();
  private speedLines = new SpeedLines();
  private camUp = new THREE.Vector3(0, 1, 0);
  private lastTime = 0;
  private camX = 0;
  private fov = 70;
  private shake = 0;
  private flash = new THREE.Vector4(1, 1, 1, 0);
  private kick = 0;
  private bloomKick = 0;
  private nextDrop = 0;
  private lastBeatIdx = -1;
  private beatAge = 10;
  private beat = 0;
  private carry = new THREE.Vector3();
  private basePixelRatio = Math.min(window.devicePixelRatio, 1.5);
  private covered = false;
  /** camera shake, FOV punches, blur, aberration and flashes (a setting) */
  effects = true;
  playerS = 0;
  playerSpeed = 0;
  heat = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;
    this.scene.background = new THREE.Color(0x020106);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(0.3, 1, 0.4);
    this.scene.add(key, key.target, new THREE.HemisphereLight(0x8a7bff, 0x100820, 0.8));
    this.camera.add(this.speedLines.lines);
    this.scene.add(this.camera, this.particles.points, this.waves.group);
    this.post = new Post(this.renderer, this.scene, this.camera);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * While a menu covers the scene it keeps running (same motion, same look through the
   * panels) but at a lower internal resolution, leaving the browser room to stay snappy.
   */
  /** Graphics quality: internal resolution and bloom. */
  setQuality(q: 'high' | 'medium' | 'low') {
    const dpr = window.devicePixelRatio;
    this.basePixelRatio = q === 'high' ? Math.min(dpr, 1.5) : q === 'medium' ? 1 : 0.75;
    this.post.bloom.enabled = q !== 'low';
    const covered = this.covered;
    this.covered = !covered; // force a refresh
    this.setCovered(covered);
  }

  setCovered(covered: boolean) {
    if (covered === this.covered) return;
    this.covered = covered;
    const pr = covered ? Math.max(0.5, this.basePixelRatio * 0.6) : this.basePixelRatio;
    this.renderer.setPixelRatio(pr);
    this.post.composer.setPixelRatio(pr);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
  }

  load(track: Track, loadout: Loadout = DEFAULT_LOADOUT) {
    this.unload();
    this.track = track;
    this.trackMesh = new TrackMesh(track);
    this.blocks = new BlockField(track);
    this.trails = new TrailField(track);
    this.env = new Environment(track);
    this.scene.add(this.env.group, this.trackMesh.group, this.blocks.group, this.trails.mesh);
    this.ship = new Ship(loadout);
    this.ship.addTo(this.scene);
    this.nextDrop = 0;
    this.lastBeatIdx = -1;
    this.particles.clear();
    // Compile every shader now rather than on first sight mid-ride (that is a visible hitch).
    this.renderer.compile(this.scene, this.camera);
  }

  unload() {
    if (!this.track) return;
    this.scene.remove(this.env!.group, this.trackMesh!.group, this.blocks!.group, this.trails!.mesh);
    this.trails!.dispose();
    this.trackMesh!.dispose();
    this.blocks!.dispose();
    this.env!.dispose();
    this.ship?.removeFrom(this.scene);
    this.ship?.dispose();
    this.ship = null;
    this.track = null;
  }

  /** World position of a block (for effects). */
  private blockPos(b: Block, h: number, out: THREE.Vector3) {
    frameAtS(this.track!, b.s, f2);
    return out.set(f2.px + f2.rx * laneX(b.lane) + f2.ux * h, f2.py + f2.ry * laneX(b.lane) + f2.uy * h, f2.pz + f2.rz * laneX(b.lane) + f2.uz * h);
  }

  onEvent(e: RaceEvent, sim: RaceSim) {
    if (!this.track) return;
    const up = v3.set(f0.ux, f0.uy, f0.uz);
    const shipPos = this.ship ? this.ship.root.position : v2.set(f0.px, f0.py, f0.pz);
    if (e.type === 'catch') {
      // Local, punchy feedback: burst + ring at the block, a streak down its lane, the ship
      // flaring in its colour and a small camera punch. Nothing covers the whole screen.
      const c = TIER_COLORS[e.block.tier];
      const p = this.blockPos(e.block, 1.1, v1);
      const combo = Math.min(1, sim.racer.combo / 60);
      this.particles.burst(p, this.carry, c, 18 + e.block.tier * 3 + Math.round(combo * 14), 12 + combo * 8, 0.55, 1.05, up);
      this.waves.spawn(p, up, this.carry, c, 3.5 + e.block.tier * 0.4, 0.28);
      this.ship?.pulse(c, 0.7 + combo * 0.3);
      shared.uHitX.value = laneX(e.block.lane);
      shared.uHitAge.value = 0;
      shared.uHitColor.value.copy(c);
      this.kick = Math.max(this.kick, 0.3 + combo * 0.25);
    } else if (e.type === 'grey') {
      const p = this.blockPos(e.block, 1.1, v1);
      this.particles.burst(p, this.carry, GREY_COLOR, 30, 14, 0.6, 1.1);
      this.ship?.pulse(HURT, 1);
      this.shake += 0.45;
    } else if (e.type === 'gem') {
      const p = this.blockPos(e.block, 1.9, v1);
      this.particles.burst(p, this.carry, GEM_COLOR, 40, 16, 0.8, 1.2);
      this.waves.spawn(p, up, this.carry, GEM_COLOR, 7, 0.5);
      this.kick = Math.max(this.kick, 0.4);
    } else if (e.type === 'multiplier' && e.mult > 1) {
      // Reaching a new multiplier: a soft ring and a gentle surge, growing with the level.
      const col = MULT_COLOR;
      this.waves.spawn(shipPos, up, this.carry, col, 7 + e.mult * 1.2, 0.6);
      this.waves.spawn(shipPos, up, this.carry, tmpColor.setHex(sim.racer.color), 4 + e.mult, 0.45);
      this.particles.burst(shipPos, this.carry, col, 24 + e.mult * 6, 16, 0.9, 1.2);
      this.ship?.pulse(col, 1);
      this.kick = Math.max(this.kick, 0.8 + e.mult * 0.12);
    } else if (e.type === 'holdTick') {
      // Riding a trail: energy keeps streaming down the lane and into the ship.
      const c = TIER_COLORS[e.block.tier];
      this.particles.burst(shipPos, this.carry, c, 5, 7, 0.4, 0.8, up);
      this.ship?.pulse(c, 0.55);
      shared.uHitX.value = sim.racer.x;
      shared.uHitAge.value = 0.05;
      shared.uHitColor.value.copy(c);
    } else if (e.type === 'holdDone') {
      const c = TIER_COLORS[e.block.tier];
      this.waves.spawn(shipPos, up, this.carry, c, 8, 0.5);
      this.particles.burst(shipPos, this.carry, c, 36, 16, 0.8, 1.2);
      this.ship?.pulse(c, 1);
      this.kick = Math.max(this.kick, 0.6);
    } else if (e.type === 'holdBreak') {
      this.particles.burst(shipPos, this.carry, GREY_COLOR, 10, 8, 0.5, 0.8);
    } else if (e.type === 'pellet') {
      // On top of the normal catch feedback, the chain builds up toward its end.
      this.kick = Math.max(this.kick, 0.2 + 0.4 * (e.index / e.total));
    } else if (e.type === 'streamDone' && e.caught === e.total) {
      const c = TIER_COLORS[this.track.streams[e.id].tier];
      this.waves.spawn(shipPos, up, this.carry, MULT_COLOR, 9, 0.55);
      this.waves.spawn(shipPos, up, this.carry, c, 6, 0.4);
      this.particles.burst(shipPos, this.carry, c, 40, 18, 0.9, 1.2);
      this.ship?.pulse(MULT_COLOR, 1);
      this.kick = Math.max(this.kick, 0.7);
    } else if (e.type === 'overdrive') {
      const col = tmpColor.setHex(sim.racer.color);
      this.waves.spawn(shipPos, up, this.carry, col, 9, 0.8);
      this.particles.burst(shipPos, this.carry, col, 50, 20, 1, 1.3);
      this.kick = 0.8;
      this.bloomKick = 0.3;
    }
  }

  frame(sim: RaceSim, input: FrameInput) {
    const tr = this.track;
    if (!tr) return;
    const { time, dt } = input;
    const local = sim.racer;

    // --- beat clock --------------------------------------------------------
    const beats = tr.beats;
    let bi = this.lastBeatIdx;
    while (bi + 1 < beats.length && beats[bi + 1].time <= time) bi++;
    while (bi >= 0 && beats[bi].time > time) bi--;
    if (bi !== this.lastBeatIdx && bi >= 0) this.lastBeatIdx = bi;
    this.beatAge = bi >= 0 ? time - beats[bi].time : 10;
    const downbeat = bi >= 0 && beats[bi].downbeat;
    // A soft swell rather than a strobe.
    this.beat = Math.exp(-this.beatAge * 3.5) * (downbeat ? 0.6 : 0.35);

    // --- drops ---------------------------------------------------------------
    while (this.nextDrop < tr.drops.length && tr.drops[this.nextDrop].time <= time) {
      const late = time - tr.drops[this.nextDrop].time;
      this.nextDrop++;
      if (late < 0.5) this.onDrop();
    }

    // --- player frame + speed ---------------------------------------------------
    const idx = indexAtTime(tr, time);
    frameAt(tr, idx, f0);
    this.playerS = valueAt(tr.s, idx);
    this.playerSpeed = valueAt(tr.speed, idx);
    this.heat = valueAt(tr.intensity, idx);
    this.carry.set(f0.fx, f0.fy, f0.fz).multiplyScalar(this.playerSpeed);
    const overdrive = sim.overdriveActive(local);

    // --- shared uniforms -----------------------------------------------------------
    shared.uTime.value = time;
    shared.uBeat.value = this.beat;
    shared.uBeatAge.value = this.beatAge;
    shared.uEnergy.value = input.energy;
    shared.uBass.value = input.bass;
    shared.uPlayerS.value = this.playerS;
    shared.uPlayerX.value = local.x;
    shared.uSpeed.value = this.playerSpeed;
    intensityColor(this.heat, shared.uHeat.value);
    if (overdrive) shared.uHeat.value.lerp(tmpColor.setHex(local.color), 0.35);
    shared.uBands.value.set(input.bands);

    // --- ship ----------------------------------------------------------------------
    this.ship?.update(f0, local.x, local.vx, time, dt, {
      power: THREE.MathUtils.clamp((this.playerSpeed - 55) / 80, 0, 1),
      hurt: time - local.hurtAt < 0.6,
      bass: input.bass,
      overdrive,
    });

    this.blocks!.update(this.playerS);
    this.trails!.update();

    // --- camera --------------------------------------------------------------------
    // 0 when cruising, ~1.6 flat out: drives FOV, camera, lines and blur.
    const speedK = THREE.MathUtils.clamp((this.playerSpeed - 60) / 130, 0, 1.7);
    const back = 11.5 + speedK * 2.2;
    const height = 5.4 - speedK * 1.1;
    frameAtS(tr, this.playerS - back, f1);
    frameAtS(tr, this.playerS + 32, f2);
    // The camera drifts after the ship lazily, so lane changes don't jerk the whole view.
    this.camX += (local.x - this.camX) * (1 - Math.exp(-dt * 3));
    const px = this.camX;
    v1.set(
      f1.px + f1.rx * px * 0.45 + f1.ux * height,
      f1.py + f1.ry * px * 0.45 + f1.uy * height,
      f1.pz + f1.rz * px * 0.45 + f1.uz * height,
    );
    v2.set(
      f2.px + f2.rx * px * 0.3 + f2.ux * 1.4,
      f2.py + f2.ry * px * 0.3 + f2.uy * 1.4,
      f2.pz + f2.rz * px * 0.3 + f2.uz * 1.4,
    );
    // In tight curvature (loops) looking far down the track would lose the ship: look along
    // the ship's own heading instead.
    const bend = THREE.MathUtils.clamp((1 - (f0.fx * f2.fx + f0.fy * f2.fy + f0.fz * f2.fz)) * 5, 0, 1);
    if (bend > 0) {
      v3.set(
        f0.px + f0.fx * 24 + f0.rx * px * 0.3 + f0.ux * 1.4,
        f0.py + f0.fy * 24 + f0.ry * px * 0.3 + f0.uy * 1.4,
        f0.pz + f0.fz * 24 + f0.rz * px * 0.3 + f0.uz * 1.4,
      );
      v2.lerp(v3, bend);
    }
    this.shake = this.effects ? Math.max(0, this.shake - dt * 2) : 0;
    if (!this.effects) this.kick = 0;
    // Flat out, the camera hums: a smooth low wobble, never per-frame jitter.
    const hum = Math.max(0, speedK - 0.9) * 0.08;
    const sh = this.shake * this.shake * 0.5;
    v1.x += Math.sin(time * 31) * hum;
    v1.y += Math.sin(time * 23 + 1.3) * hum;
    v1.x += (Math.random() - 0.5) * sh;
    v1.y += (Math.random() - 0.5) * sh;
    v1.z += (Math.random() - 0.5) * sh;
    this.camera.position.copy(v1);
    // Camera up follows the banking, partially, and lazily.
    // The camera rolls with the track: loops and corkscrews turn the whole world over.
    v3.set(f1.ux + f0.ux, f1.uy + f0.uy, f1.uz + f0.uz).normalize();
    // Smoothed on song time, not frame time, so a slow frame can't leave the camera behind.
    const sdt = THREE.MathUtils.clamp(time - this.lastTime, 0, 0.25);
    this.lastTime = time;
    this.camUp.lerp(v3, 1 - Math.exp(-sdt * 10)).normalize();
    this.camera.up.copy(this.camUp);
    this.camera.lookAt(v2);

    // FOV breathes with speed; catches give a quick punch that eases back.
    this.kick = Math.max(0, this.kick - dt * 2.2);
    const targetFov = 64 + speedK * 19 + (overdrive ? 6 : 0) + this.kick * 4.5;
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-dt * 7));
    shared.uHitAge.value += dt;
    this.fov = THREE.MathUtils.clamp(this.fov, 50, 104);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();

    // --- effects -------------------------------------------------------------------
    this.particles.update(dt, this.carry);
    this.waves.update(dt);
    intensityColor(this.heat, tmpColor);
    this.speedLines.update(dt, this.playerSpeed, tmpColor, (overdrive ? 0.8 : 0) + this.kick * 0.4);
    this.env!.update(this.camera, dt, input.bass, this.beat);

    // Ambient sparks streaming off the track edges in intense parts.
    if (this.heat > 0.55 && Math.random() < this.heat * 0.9) {
      const side = Math.random() < 0.5 ? -1 : 1;
      frameAtS(tr, this.playerS + 40 + Math.random() * 120, f1);
      const x = side * (8.6 + Math.random() * 0.4);
      v1.set(f1.px + f1.rx * x + f1.ux * 0.5, f1.py + f1.ry * x + f1.uy * 0.5, f1.pz + f1.rz * x + f1.uz * 0.5);
      this.particles.burst(v1, v2.set(0, 0, 0), intensityColor(this.heat, tmpColor), 3, 10, 0.6, 1.2, v3.set(f1.ux, f1.uy, f1.uz));
    }

    // --- post ------------------------------------------------------------------------
    this.flash.w = this.effects ? Math.min(0.15, Math.max(0, this.flash.w - dt * 0.9)) : 0;
    this.kick = Math.min(this.kick, 1.6);
    this.bloomKick = Math.max(0, this.bloomKick - dt * 1.2);
    const u = this.post.u;
    u.uTime.value = time;
    u.uFlash.value.copy(this.flash);
    u.uGlitch.value = 0;
    u.uAberration.value = this.effects ? 0.0008 + speedK * 0.0014 : 0;
    u.uZoomBlur.value = this.effects ? speedK * 0.55 + (overdrive ? 0.5 : 0) : 0;
    this.post.bloom.strength = 0.6 + this.heat * 0.08 + this.bloomKick * 0.25;
    this.post.render(dt);
  }

  private onDrop() {
    intensityColor(1, tmpColor);
    this.kick = 1;
    this.bloomKick = 0.4;
    const up = v3.set(f0.ux, f0.uy, f0.uz);
    const p = v1.set(f0.px + f0.ux * 1.5, f0.py + f0.uy * 1.5, f0.pz + f0.uz * 1.5);
    this.waves.spawn(p, up, this.carry, intensityColor(0.8, tmpColor), 12, 0.9);
    this.particles.burst(p, this.carry, intensityColor(0.9, tmpColor), 60, 30, 1.1, 1.3);
  }

  /** Project the ship to screen space (for popups). */
  shipScreen(out: { x: number; y: number; visible: boolean }) {
    if (!this.ship) { out.visible = false; return out; }
    v1.copy(this.ship.root.position).addScaledVector(this.camUp, 2.2).project(this.camera);
    out.visible = v1.z < 1 && Math.abs(v1.x) < 1.2 && Math.abs(v1.y) < 1.2;
    out.x = (v1.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-v1.y * 0.5 + 0.5) * window.innerHeight;
    return out;
  }

  get beatPulse() {
    return this.beat;
  }
}
