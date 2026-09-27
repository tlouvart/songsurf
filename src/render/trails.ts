import * as THREE from 'three';
import { frameAtS, holdLaneAt, laneX, newFrame, sAtTime, type Block, type Track } from '../track/track.ts';
import { FOG_GLSL, TIER_COLORS, shared } from './palette.ts';

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aS;
attribute float aU;
attribute float aState;
attribute float aEnd;
attribute float aWide;
varying vec3 vColor;
varying float vS;
varying float vU;
varying float vState;
varying float vEnd;
varying float vWide;
varying float vDist;
void main() {
  vColor = aColor; vS = aS; vU = aU; vState = aState; vEnd = aEnd; vWide = aWide;
  vec4 mv = viewMatrix * modelMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * States: 0 waiting, 1 being ridden, 2 completed, 3 broken/missed. The part of a trail you
 * have ridden over is "eaten", so the trail visibly drains into the ship.
 */
const FRAG = /* glsl */ `
uniform float uTime;
uniform float uPlayerS;
${FOG_GLSL}
varying vec3 vColor;
varying float vS;
varying float vU;
varying float vState;
varying float vEnd;
varying float vWide;
varying float vDist;
void main() {
  if (vState > 1.5 && vState < 2.5) discard;
  if (vState > 0.5 && vState < 1.5 && vS < uPlayerS + 0.5) discard;
  if (vS < uPlayerS - 25.0) discard;
  float x = abs(vU - 0.5) * 2.0;
  float edge = smoothstep(0.55, 0.95, x) * (1.0 - smoothstep(0.95, 1.0, x));
  float core = 1.0 - x;
  float k = vState < 0.5 ? 1.0 : vState < 1.5 ? 1.6 : 0.12;
  float flow = 0.75 + 0.25 * sin(vS * 0.45 - uTime * (vState > 0.5 && vState < 1.5 ? 16.0 : 5.0));
  float cap = smoothstep(vEnd - 2.5, vEnd, vS) * 0.8;
  vec3 c = (vColor * (core * 0.7 + edge * 1.5 + cap) + vec3(edge * 0.12)) * k * flow;
  if (vWide < 0.5) c = vColor * (0.4 + 0.6 * core) * (vState > 2.5 ? 0.12 : 0.9);
  gl_FragColor = vec4(c * fogFade(vDist), 1.0);
}
`;

const fr = newFrame();

/** Long-block trails and stream guide lines, as one merged, statically built mesh. */
export class TrailField {
  mesh: THREE.Mesh;
  private state: THREE.BufferAttribute;
  private holds: { block: Block; start: number; count: number; last: number }[] = [];
  private streams: { id: number; start: number; count: number; last: number }[] = [];

  constructor(private tr: Track) {
    const pos: number[] = [], col: number[] = [], sArr: number[] = [], uArr: number[] = [], endArr: number[] = [], wide: number[] = [];
    const idx: number[] = [];

    /** Sweep a ribbon along song time, following a (fractional) lane function. */
    const ribbon = (t0: number, t1: number, laneAt: (t: number) => number, width: number, h: number, color: THREE.Color, isWide: boolean) => {
      const first = pos.length / 3;
      const steps = Math.max(2, Math.ceil((t1 - t0) * 40));
      const endS = sAtTime(this.tr, t1);
      for (let k = 0; k <= steps; k++) {
        const t = t0 + ((t1 - t0) * k) / steps;
        const s = sAtTime(this.tr, t);
        frameAtS(this.tr, s, fr);
        const x = laneX(laneAt(t));
        for (const side of [-1, 1]) {
          const lx = x + (side * width) / 2;
          pos.push(fr.px + fr.rx * lx + fr.ux * h, fr.py + fr.ry * lx + fr.uy * h, fr.pz + fr.rz * lx + fr.uz * h);
          col.push(color.r, color.g, color.b);
          sArr.push(s);
          uArr.push(side < 0 ? 0 : 1);
          endArr.push(endS);
          wide.push(isWide ? 1 : 0);
        }
        if (k < steps) {
          const a = first + k * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }
      return { start: first, count: (steps + 1) * 2 };
    };

    for (const b of tr.blocks) {
      if (b.holdEnd === undefined) continue;
      const r = ribbon(b.time, b.holdEnd, (t) => holdLaneAt(b, t), 1.8, 0.1, TIER_COLORS[b.tier], true);
      this.holds.push({ block: b, ...r, last: -1 });
    }
    for (const st of tr.streams) {
      const pellets = tr.blocks.filter((b) => b.stream === st.id);
      // Lane between pellets: eased from one to the next, so the guide line snakes smoothly.
      const laneAt = (t: number) => {
        let i = 0;
        while (i + 1 < pellets.length && pellets[i + 1].time <= t) i++;
        const p = pellets[i], q = pellets[Math.min(i + 1, pellets.length - 1)];
        if (q === p) return p.lane;
        const u = Math.min(1, Math.max(0, (t - p.time) / (q.time - p.time)));
        return p.lane + (q.lane - p.lane) * u * u * (3 - 2 * u);
      };
      const r = ribbon(st.start, st.end, laneAt, 0.45, 0.07, TIER_COLORS[st.tier], false);
      this.streams.push({ id: st.id, ...r, last: -1 });
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aS', new THREE.Float32BufferAttribute(sArr, 1));
    g.setAttribute('aU', new THREE.Float32BufferAttribute(uArr, 1));
    g.setAttribute('aEnd', new THREE.Float32BufferAttribute(endArr, 1));
    g.setAttribute('aWide', new THREE.Float32BufferAttribute(wide, 1));
    this.state = new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1);
    this.state.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aState', this.state);
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(
      g,
      new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: shared,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Push state changes (riding / done / broken) to the GPU; cheap, only on change. */
  update() {
    let dirty = false;
    const set = (start: number, count: number, v: number) => {
      (this.state.array as Float32Array).fill(v, start, start + count);
      this.state.addUpdateRange(start, count);
      dirty = true;
    };
    for (const h of this.holds) {
      if (h.block.holdState !== h.last) {
        h.last = h.block.holdState;
        set(h.start, h.count, h.last);
      }
    }
    for (const st of this.streams) {
      const v = this.tr.streams[st.id].broken ? 3 : 0;
      if (v !== st.last) {
        st.last = v;
        set(st.start, st.count, v);
      }
    }
    if (dirty) this.state.needsUpdate = true;
  }

  reset() {
    for (const h of this.holds) h.last = -1;
    for (const st of this.streams) st.last = -1;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
