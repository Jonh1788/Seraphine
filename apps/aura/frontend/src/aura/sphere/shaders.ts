export const AURA_VERTEX_HEADER = /* glsl */ `
uniform float uTime;
uniform vec2 uMouse;
uniform float uHasMouse;
uniform float uMouseRadius;
uniform float uMouseStrength;
uniform float uWaveSpeed;
uniform float uWaveWidth;
uniform float uWaveStrength;

attribute float aPhase;
attribute float aPhase2;
attribute float aPhase3;
attribute float aSpeed;
attribute float aAmplitude;

varying float vRim;
varying float vMouseInfluence;
varying float vEdgeWave;
varying float vDepthFade;

float saturate(float v) { return clamp(v, 0.0, 1.0); }

float circularDistance(float a, float b) {
  float d = abs(a - b);
  return min(d, 1.0 - d);
}

vec3 displaceAura(vec3 basePosition) {
  vec3 normalDir = normalize(basePosition);

  float waveA = sin(uTime * aSpeed + aPhase);
  float waveB = sin(uTime * (aSpeed * 0.63) + aPhase2);
  float waveC = sin(uTime * 0.11 + aPhase3 + normalDir.y * 2.8);

  float displacement = (waveA * 0.55 + waveB * 0.30 + waveC * 0.15) * aAmplitude;
  vec3 displaced = basePosition + normalDir * displacement;

  vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
  vec3 viewDir = normalize(-mv.xyz);
  vec3 viewNormal = normalize(normalMatrix * normalDir);

  vRim = smoothstep(0.67, 0.94, 1.0 - abs(dot(viewNormal, viewDir)));

  float angle = atan(mv.y, mv.x);
  float angle01 = (angle + 3.14159265) / 6.2831853;
  float progress = fract(uTime * uWaveSpeed);
  float edgeDistance = circularDistance(angle01, progress);
  float waveBand = smoothstep(uWaveWidth, 0.0, edgeDistance);
  vEdgeWave = waveBand * vRim;
  displaced += normalDir * vEdgeWave * uWaveStrength;

  vec4 clip = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  vec2 screenPos = clip.xy / clip.w;
  float mouseDistance = distance(screenPos, uMouse);
  vMouseInfluence = smoothstep(uMouseRadius, 0.0, mouseDistance) * uHasMouse;
  displaced += normalDir * vMouseInfluence * uMouseStrength;

  vec4 finalMv = modelViewMatrix * vec4(displaced, 1.0);
  vDepthFade = 0.72 + smoothstep(12.0, 2.0, -finalMv.z) * 0.28;

  return displaced;
}
`;

export const POINT_VERTEX = /* glsl */ `
${AURA_VERTEX_HEADER}

uniform float uPointScale;

void main() {
  vec3 displaced = displaceAura(position);
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float highlight = vRim * 0.65 + vEdgeWave * 1.25 + vMouseInfluence * 1.45;
  gl_PointSize = (30.0 + highlight * 52.0) * uPointScale * (1.0 / -mvPosition.z);
}
`;

export const POINT_FRAGMENT = /* glsl */ `
uniform vec3 uPointColor;
uniform vec3 uLineColor;
uniform vec3 uRimColor;
uniform float uIntensity;

varying float vRim;
varying float vMouseInfluence;
varying float vEdgeWave;
varying float vDepthFade;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float circle = smoothstep(0.5, 0.0, d);
  float core = smoothstep(0.16, 0.0, d);

  vec3 color = mix(uPointColor, uRimColor, clamp(vRim + vEdgeWave + vMouseInfluence, 0.0, 1.0));
  float alpha = circle * (0.72 + vRim * 0.58 + vEdgeWave * 0.85 + vMouseInfluence * 0.95) * vDepthFade;

  gl_FragColor = vec4(color * (1.15 + core * 1.15) * uIntensity, alpha);
}
`;

export const LINE_VERTEX = /* glsl */ `
${AURA_VERTEX_HEADER}

varying float vLineAlpha;

void main() {
  vec3 displaced = displaceAura(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  vLineAlpha = (0.24 + vRim * 0.24 + vEdgeWave * 0.52 + vMouseInfluence * 0.38) * vDepthFade;
}
`;

export const LINE_FRAGMENT = /* glsl */ `
uniform vec3 uPointColor;
uniform vec3 uLineColor;
uniform vec3 uRimColor;

varying float vRim;
varying float vMouseInfluence;
varying float vEdgeWave;
varying float vDepthFade;
varying float vLineAlpha;

void main() {
  vec3 color = mix(uLineColor, uRimColor, clamp(vRim + vEdgeWave + vMouseInfluence, 0.0, 1.0));
  gl_FragColor = vec4(color * 1.35, vLineAlpha);
}
`;

export const DUST_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uPointScale;
attribute float aPhase;
varying float vAlpha;

void main() {
  vec3 p = position;
  p.y += sin(uTime * 0.16 + aPhase) * 0.035;
  p.x += cos(uTime * 0.11 + aPhase) * 0.025;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = 18.0 * uPointScale * (1.0 / -mvPosition.z);
  vAlpha = 0.44 + sin(uTime * 0.8 + aPhase) * 0.14;
}
`;

export const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  float circle = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(uColor, circle * vAlpha);
}
`;

export const SPARKLE_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uPointScale;

attribute float aPhase;
attribute float aSize;

varying float vAlpha;
varying float vPulse;

void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.07 + aPhase) * 0.035;
  p.y += cos(uTime * 0.09 + aPhase * 1.3) * 0.03;

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float pulse = 0.5 + 0.5 * sin(uTime * 1.8 + aPhase);
  float blink = smoothstep(0.55, 1.0, pulse);

  vPulse = blink;
  vAlpha = 0.16 + blink * 0.72;

  gl_PointSize = (9.0 + aSize * 9.0 + blink * 13.0) * uPointScale * (1.0 / -mvPosition.z);
}
`;

export const SPARKLE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;

varying float vAlpha;
varying float vPulse;

void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);

  float softDot = smoothstep(0.5, 0.0, d);
  float hotCore = smoothstep(0.12, 0.0, d);

  float cross = max(
    smoothstep(0.045, 0.0, abs(uv.x)) * smoothstep(0.42, 0.0, abs(uv.y)),
    smoothstep(0.045, 0.0, abs(uv.y)) * smoothstep(0.42, 0.0, abs(uv.x))
  );

  float alpha = (softDot * 0.52 + hotCore * 0.82 + cross * 0.55 * vPulse) * vAlpha;
  vec3 color = uColor * (1.0 + hotCore * 1.7 + cross * 0.8);

  gl_FragColor = vec4(color, alpha);
}
`;
