import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** Replaces NaN/Inf pixels (and clamps extremes) so bloom can never smear them into black frames. */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 32.0), 1.0);
    }
  `,
};

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0.002 },
    uZoomBlur: { value: 0 },
    uFlash: { value: new THREE.Vector4(1, 1, 1, 0) },
    uVignette: { value: 0.9 },
    uGlitch: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAberration;
    uniform float uZoomBlur;
    uniform vec4 uFlash;
    uniform float uVignette;
    uniform float uGlitch;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      if (uGlitch > 0.0) {
        float row = floor(uv.y * 40.0);
        float j = step(1.0 - uGlitch * 0.5, rand(vec2(row, floor(uTime * 30.0))));
        uv.x += j * (rand(vec2(row, uTime)) - 0.5) * 0.08 * uGlitch;
      }
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);
      vec2 dir = c * (uAberration + uGlitch * 0.01) * (0.5 + r2 * 4.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;
      // Radial zoom blur toward the edges for the sense of speed.
      if (uZoomBlur > 0.0) {
        vec3 acc = col;
        for (int i = 1; i < 8; i++) {
          float k = 1.0 - float(i) * uZoomBlur * 0.012 * (0.3 + r2 * 6.0);
          acc += texture2D(tDiffuse, 0.5 + c * k).rgb;
        }
        col = mix(col, acc / 8.0, smoothstep(0.0, 0.12, r2));
      }
      col = mix(col, uFlash.rgb, uFlash.a);
      col *= 1.0 - uVignette * smoothstep(0.15, 0.75, r2 * 1.6);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Post {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  final: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.composer.addPass(new ShaderPass(SanitizeShader));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.8, 0.42, 0.62);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
  }

  get u() {
    return this.final.uniforms as unknown as {
      uTime: { value: number };
      uAberration: { value: number };
      uZoomBlur: { value: number };
      uFlash: { value: THREE.Vector4 };
      uVignette: { value: number };
      uGlitch: { value: number };
    };
  }

  setSize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w / 2, h / 2);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
