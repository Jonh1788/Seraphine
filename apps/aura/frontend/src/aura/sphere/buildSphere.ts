import { Vector3 } from "three";

export interface SphereGeometry {
  pointCount: number;
  positions: Float32Array;
  phase: Float32Array;
  phase2: Float32Array;
  phase3: Float32Array;
  speed: Float32Array;
  amplitude: Float32Array;
  lineVertexCount: number;
  linePositions: Float32Array;
  linePhase: Float32Array;
  linePhase2: Float32Array;
  linePhase3: Float32Array;
  lineSpeed: Float32Array;
  lineAmplitude: Float32Array;
}

export interface BuildOptions {
  pointCount: number;
  radius: number;
  maxLinksPerPoint?: number;
  maxLinkDistance?: number;
  jitter?: number;
  seed?: number;
}

const DEFAULTS = {
  maxLinksPerPoint: 5,
  maxLinkDistance: 0.49,
  jitter: 0.13,
  seed: 1,
};

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fibonacciPoint(index: number, total: number, radius: number, out: Vector3): Vector3 {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (index / (total - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const theta = goldenAngle * index;
  out.set(Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius);
  return out;
}

export function buildSphereGeometry(opts: BuildOptions): SphereGeometry {
  const o = { ...DEFAULTS, ...opts };
  const rng = mulberry32(o.seed);
  const total = o.pointCount;

  const bases: Vector3[] = new Array(total);
  const phaseArr = new Float32Array(total);
  const phase2Arr = new Float32Array(total);
  const phase3Arr = new Float32Array(total);
  const speedArr = new Float32Array(total);
  const ampArr = new Float32Array(total);
  const positions = new Float32Array(total * 3);

  const tmpNormal = new Vector3();
  const tmpTangentA = new Vector3();
  const tmpTangentB = new Vector3();

  for (let i = 0; i < total; i++) {
    const p = new Vector3();
    fibonacciPoint(i, total, o.radius, p);

    tmpNormal.copy(p).normalize();
    tmpTangentA.set(-tmpNormal.z, 0, tmpNormal.x);
    if (tmpTangentA.lengthSq() < 0.0001) tmpTangentA.set(1, 0, 0);
    tmpTangentA.normalize();
    tmpTangentB.crossVectors(tmpNormal, tmpTangentA).normalize();

    p.addScaledVector(tmpTangentA, (rng() - 0.5) * o.jitter);
    p.addScaledVector(tmpTangentB, (rng() - 0.5) * o.jitter);
    p.normalize().multiplyScalar(o.radius * (0.975 + rng() * 0.05));

    bases[i] = p;
    const i3 = i * 3;
    positions[i3] = p.x;
    positions[i3 + 1] = p.y;
    positions[i3 + 2] = p.z;

    phaseArr[i] = rng() * Math.PI * 2;
    phase2Arr[i] = rng() * Math.PI * 2;
    phase3Arr[i] = rng() * Math.PI * 2;
    speedArr[i] = 0.18 + rng() * 0.26;
    ampArr[i] = 0.025 + rng() * 0.055;
  }

  const connections: Array<[number, number]> = [];
  const seen = new Set<string>();
  const maxDistSq = o.maxLinkDistance * o.maxLinkDistance;

  for (let i = 0; i < total; i++) {
    const candidates: Array<{ idx: number; d2: number }> = [];
    for (let j = 0; j < total; j++) {
      if (i === j) continue;
      const d2 = bases[i].distanceToSquared(bases[j]);
      if (d2 < maxDistSq) candidates.push({ idx: j, d2 });
    }
    candidates.sort((a, b) => a.d2 - b.d2);
    const take = Math.min(o.maxLinksPerPoint, candidates.length);
    for (let k = 0; k < take; k++) {
      const a = i;
      const b = candidates[k].idx;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      connections.push(a < b ? [a, b] : [b, a]);
    }
  }

  const lineVertexCount = connections.length * 2;
  const linePositions = new Float32Array(lineVertexCount * 3);
  const linePhase = new Float32Array(lineVertexCount);
  const linePhase2 = new Float32Array(lineVertexCount);
  const linePhase3 = new Float32Array(lineVertexCount);
  const lineSpeed = new Float32Array(lineVertexCount);
  const lineAmplitude = new Float32Array(lineVertexCount);

  for (let c = 0; c < connections.length; c++) {
    const [a, b] = connections[c];
    const wa = c * 2;
    const wb = c * 2 + 1;
    const pa = bases[a];
    const pb = bases[b];
    linePositions[wa * 3] = pa.x;
    linePositions[wa * 3 + 1] = pa.y;
    linePositions[wa * 3 + 2] = pa.z;
    linePositions[wb * 3] = pb.x;
    linePositions[wb * 3 + 1] = pb.y;
    linePositions[wb * 3 + 2] = pb.z;
    linePhase[wa] = phaseArr[a];
    linePhase[wb] = phaseArr[b];
    linePhase2[wa] = phase2Arr[a];
    linePhase2[wb] = phase2Arr[b];
    linePhase3[wa] = phase3Arr[a];
    linePhase3[wb] = phase3Arr[b];
    lineSpeed[wa] = speedArr[a];
    lineSpeed[wb] = speedArr[b];
    lineAmplitude[wa] = ampArr[a];
    lineAmplitude[wb] = ampArr[b];
  }

  return {
    pointCount: total,
    positions,
    phase: phaseArr,
    phase2: phase2Arr,
    phase3: phase3Arr,
    speed: speedArr,
    amplitude: ampArr,
    lineVertexCount,
    linePositions,
    linePhase,
    linePhase2,
    linePhase3,
    lineSpeed,
    lineAmplitude,
  };
}

export interface BackgroundCloud {
  count: number;
  positions: Float32Array;
  phase: Float32Array;
  size?: Float32Array;
}

export function buildDust(count: number, seed: number): BackgroundCloud {
  const rng = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] = (rng() - 0.5) * 8.8;
    positions[i3 + 1] = (rng() - 0.5) * 6.4;
    positions[i3 + 2] = (rng() - 0.5) * 5.8;
    phase[i] = rng() * Math.PI * 2;
  }
  return { count, positions, phase };
}

export function buildSparkles(count: number, seed: number): BackgroundCloud {
  const rng = mulberry32(seed);
  const positions = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] = (rng() - 0.5) * 9.5;
    positions[i3 + 1] = (rng() - 0.5) * 6.8;
    positions[i3 + 2] = (rng() - 0.5) * 6.2;
    phase[i] = rng() * Math.PI * 2;
    size[i] = 0.75 + rng() * 1.6;
  }
  return { count, positions, phase, size };
}
