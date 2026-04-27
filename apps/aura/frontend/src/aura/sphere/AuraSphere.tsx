import { Suspense, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  Color,
  Group,
  MathUtils,
  Vector2,
  type ShaderMaterial,
} from "three";
import {
  buildDust,
  buildSparkles,
  buildSphereGeometry,
  type SphereGeometry,
} from "./buildSphere";
import {
  AURA_VERTEX_HEADER as _AURA_VERTEX_HEADER,
  POINT_VERTEX,
  POINT_FRAGMENT,
  LINE_VERTEX,
  LINE_FRAGMENT,
  DUST_VERTEX,
  DUST_FRAGMENT,
  SPARKLE_VERTEX,
  SPARKLE_FRAGMENT,
} from "./shaders";
import { STATE_PRESETS, type AuraState } from "./states";

void _AURA_VERTEX_HEADER; // referenced inside POINT_VERTEX/LINE_VERTEX strings

export type AuraVariant = "hero" | "compact" | "mini";

export interface AuraSphereProps {
  variant?: AuraVariant;
  state?: AuraState;
  /** Audio RMS 0..1, used when state is "speaking" to modulate amplitude */
  audioLevel?: React.MutableRefObject<number>;
  className?: string;
  style?: CSSProperties;
  /** Disable dust + sparkle even on hero (cheap fallback) */
  minimal?: boolean;
  /** CSS opacity 0..1 applied to the entire canvas (sphere + dust + sparkle) */
  opacity?: number;
}

interface LODProfile {
  pointCount: number;
  radius: number;
  dustCount: number;
  sparkleCount: number;
  pointScale: number;
}

function detectLOD(variant: AuraVariant, minimal: boolean): LODProfile {
  if (variant === "mini") {
    return { pointCount: 140, radius: 1.92, dustCount: 0, sparkleCount: 0, pointScale: 0.55 };
  }
  if (variant === "compact") {
    return { pointCount: 240, radius: 1.92, dustCount: 0, sparkleCount: 0, pointScale: 0.7 };
  }
  // hero
  if (typeof window !== "undefined") {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth || 800;
    const lowEnd = dpr * w < 1500;
    if (minimal || lowEnd) {
      return {
        pointCount: 280,
        radius: 1.92,
        dustCount: 0,
        sparkleCount: 0,
        pointScale: 1,
      };
    }
  }
  return { pointCount: 520, radius: 1.92, dustCount: 460, sparkleCount: 180, pointScale: 1 };
}

function makeUniforms(pointScale: number) {
  return {
    uTime: { value: 0 },
    uMouse: { value: new Vector2(99, 99) },
    uHasMouse: { value: 0 },
    uMouseRadius: { value: 0.27 },
    uMouseStrength: { value: 0.16 },
    uWaveSpeed: { value: STATE_PRESETS.idle.waveSpeed },
    uWaveWidth: { value: STATE_PRESETS.idle.waveWidth },
    uWaveStrength: { value: STATE_PRESETS.idle.waveStrength },
    uPointColor: { value: STATE_PRESETS.idle.pointColor.clone() },
    uLineColor: { value: STATE_PRESETS.idle.lineColor.clone() },
    uRimColor: { value: STATE_PRESETS.idle.rimColor.clone() },
    uIntensity: { value: STATE_PRESETS.idle.intensity },
    uPointScale: { value: pointScale },
  };
}

function makeBackgroundUniforms(pointScale: number, color: number) {
  return {
    uTime: { value: 0 },
    uColor: { value: new Color(color) },
    uPointScale: { value: pointScale },
  };
}

interface SceneProps {
  geometry: SphereGeometry;
  dust: ReturnType<typeof buildDust> | null;
  sparkle: ReturnType<typeof buildSparkles> | null;
  state: AuraState;
  audioLevel?: React.MutableRefObject<number>;
  pointScale: number;
  interactive: boolean;
}

function SphereScene({
  geometry,
  dust,
  sparkle,
  state,
  audioLevel,
  pointScale,
  interactive,
}: SceneProps) {
  const groupRef = useRef<Group>(null);
  const dustRef = useRef<Group>(null);
  const sparkleRef = useRef<Group>(null);
  const pointMatRef = useRef<ShaderMaterial>(null);
  const lineMatRef = useRef<ShaderMaterial>(null);
  const dustMatRef = useRef<ShaderMaterial>(null);
  const sparkleMatRef = useRef<ShaderMaterial>(null);

  const targetMouse = useRef(new Vector2(99, 99));
  const hasMouse = useRef(0);

  const { gl } = useThree();

  const uniforms = useMemo(() => makeUniforms(pointScale), [pointScale]);
  const dustUniforms = useMemo(() => makeBackgroundUniforms(pointScale, 0x1b87a5), [pointScale]);
  const sparkleUniforms = useMemo(() => makeBackgroundUniforms(pointScale, 0xb9fbff), [pointScale]);

  useEffect(() => {
    if (!interactive) {
      hasMouse.current = 0;
      targetMouse.current.set(99, 99);
      return;
    }
    const dom = gl.domElement;
    const onMove = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      targetMouse.current.set(x, y);
      hasMouse.current = 1;
    };
    const onLeave = () => {
      targetMouse.current.set(99, 99);
      hasMouse.current = 0;
    };
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", onLeave);
    return () => {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
    };
  }, [gl, interactive]);

  useFrame((threeState, delta) => {
    const t = threeState.clock.getElapsedTime();
    const preset = STATE_PRESETS[state];

    uniforms.uTime.value = t;
    dustUniforms.uTime.value = t;
    sparkleUniforms.uTime.value = t;

    const m = uniforms.uMouse.value as Vector2;
    m.lerp(targetMouse.current, 0.12);
    uniforms.uHasMouse.value = MathUtils.lerp(
      uniforms.uHasMouse.value as number,
      hasMouse.current ? 1 : preset.ambientMouseRadius > 0 ? 1 : 0,
      0.12,
    );

    if (!hasMouse.current && preset.ambientMouseRadius > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.9);
      const radius = preset.ambientMouseRadius * (0.6 + pulse * 0.4);
      uniforms.uMouseRadius.value = MathUtils.lerp(uniforms.uMouseRadius.value, radius, 0.08);
      m.lerp(new Vector2(0, 0), 0.04);
    } else {
      uniforms.uMouseRadius.value = MathUtils.lerp(uniforms.uMouseRadius.value, 0.27, 0.08);
    }

    const audio = audioLevel?.current ?? 0;
    const audioBoost = preset.audioReactivity * audio;

    uniforms.uWaveSpeed.value = MathUtils.lerp(
      uniforms.uWaveSpeed.value,
      preset.waveSpeed * (1 + audioBoost * 1.2),
      0.08,
    );
    uniforms.uWaveStrength.value = MathUtils.lerp(
      uniforms.uWaveStrength.value,
      preset.waveStrength + audioBoost,
      0.1,
    );
    uniforms.uWaveWidth.value = MathUtils.lerp(uniforms.uWaveWidth.value, preset.waveWidth, 0.08);
    uniforms.uIntensity.value = MathUtils.lerp(
      uniforms.uIntensity.value,
      preset.intensity + audioBoost * 0.6,
      0.12,
    );

    const pc = uniforms.uPointColor.value as Color;
    const lc = uniforms.uLineColor.value as Color;
    const rc = uniforms.uRimColor.value as Color;
    pc.lerp(preset.pointColor, 0.06);
    lc.lerp(preset.lineColor, 0.06);
    rc.lerp(preset.rimColor, 0.06);

    if (groupRef.current) {
      const speedMul = preset.rotationSpeed;
      groupRef.current.rotation.y += delta * 0.045 * speedMul;
      groupRef.current.rotation.x = Math.sin(t * 0.18) * 0.035;
      groupRef.current.rotation.z = Math.sin(t * 0.12) * 0.025;
    }
    if (dustRef.current) {
      dustRef.current.rotation.y += delta * 0.01;
      dustRef.current.rotation.x = Math.sin(t * 0.07) * 0.025;
    }
    if (sparkleRef.current) {
      sparkleRef.current.rotation.y += delta * 0.006;
      sparkleRef.current.rotation.x = Math.sin(t * 0.05) * 0.018;
    }

    if (pointMatRef.current) pointMatRef.current.uniforms = uniforms;
    if (lineMatRef.current) lineMatRef.current.uniforms = uniforms;
    if (dustMatRef.current) dustMatRef.current.uniforms = dustUniforms;
    if (sparkleMatRef.current) sparkleMatRef.current.uniforms = sparkleUniforms;
  });

  return (
    <>
      <group ref={groupRef}>
        <points frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[geometry.positions, 3]}
              count={geometry.pointCount}
              itemSize={3}
            />
            <bufferAttribute
              attach="attributes-aPhase"
              args={[geometry.phase, 1]}
              count={geometry.pointCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aPhase2"
              args={[geometry.phase2, 1]}
              count={geometry.pointCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aPhase3"
              args={[geometry.phase3, 1]}
              count={geometry.pointCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aSpeed"
              args={[geometry.speed, 1]}
              count={geometry.pointCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aAmplitude"
              args={[geometry.amplitude, 1]}
              count={geometry.pointCount}
              itemSize={1}
            />
          </bufferGeometry>
          <shaderMaterial
            ref={pointMatRef}
            uniforms={uniforms}
            vertexShader={POINT_VERTEX}
            fragmentShader={POINT_FRAGMENT}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </points>

        <lineSegments frustumCulled={false}>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[geometry.linePositions, 3]}
              count={geometry.lineVertexCount}
              itemSize={3}
            />
            <bufferAttribute
              attach="attributes-aPhase"
              args={[geometry.linePhase, 1]}
              count={geometry.lineVertexCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aPhase2"
              args={[geometry.linePhase2, 1]}
              count={geometry.lineVertexCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aPhase3"
              args={[geometry.linePhase3, 1]}
              count={geometry.lineVertexCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aSpeed"
              args={[geometry.lineSpeed, 1]}
              count={geometry.lineVertexCount}
              itemSize={1}
            />
            <bufferAttribute
              attach="attributes-aAmplitude"
              args={[geometry.lineAmplitude, 1]}
              count={geometry.lineVertexCount}
              itemSize={1}
            />
          </bufferGeometry>
          <shaderMaterial
            ref={lineMatRef}
            uniforms={uniforms}
            vertexShader={LINE_VERTEX}
            fragmentShader={LINE_FRAGMENT}
            transparent
            depthWrite={false}
            blending={AdditiveBlending}
          />
        </lineSegments>
      </group>

      {dust && (
        <group ref={dustRef}>
          <points frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[dust.positions, 3]}
                count={dust.count}
                itemSize={3}
              />
              <bufferAttribute
                attach="attributes-aPhase"
                args={[dust.phase, 1]}
                count={dust.count}
                itemSize={1}
              />
            </bufferGeometry>
            <shaderMaterial
              ref={dustMatRef}
              uniforms={dustUniforms}
              vertexShader={DUST_VERTEX}
              fragmentShader={DUST_FRAGMENT}
              transparent
              depthWrite={false}
              blending={AdditiveBlending}
            />
          </points>
        </group>
      )}

      {sparkle && sparkle.size && (
        <group ref={sparkleRef}>
          <points frustumCulled={false}>
            <bufferGeometry>
              <bufferAttribute
                attach="attributes-position"
                args={[sparkle.positions, 3]}
                count={sparkle.count}
                itemSize={3}
              />
              <bufferAttribute
                attach="attributes-aPhase"
                args={[sparkle.phase, 1]}
                count={sparkle.count}
                itemSize={1}
              />
              <bufferAttribute
                attach="attributes-aSize"
                args={[sparkle.size, 1]}
                count={sparkle.count}
                itemSize={1}
              />
            </bufferGeometry>
            <shaderMaterial
              ref={sparkleMatRef}
              uniforms={sparkleUniforms}
              vertexShader={SPARKLE_VERTEX}
              fragmentShader={SPARKLE_FRAGMENT}
              transparent
              depthWrite={false}
              blending={AdditiveBlending}
            />
          </points>
        </group>
      )}
    </>
  );
}

export function AuraSphere({
  variant = "hero",
  state = "idle",
  audioLevel,
  className = "",
  style,
  minimal = false,
  opacity = 1,
}: AuraSphereProps) {
  const lod = useMemo(() => detectLOD(variant, minimal), [variant, minimal]);

  const sphere = useMemo(
    () =>
      buildSphereGeometry({
        pointCount: lod.pointCount,
        radius: lod.radius,
        seed: 1,
      }),
    [lod.pointCount, lod.radius],
  );

  const dust = useMemo(
    () => (lod.dustCount > 0 ? buildDust(lod.dustCount, 7) : null),
    [lod.dustCount],
  );
  const sparkle = useMemo(
    () => (lod.sparkleCount > 0 ? buildSparkles(lod.sparkleCount, 13) : null),
    [lod.sparkleCount],
  );

  const interactive = variant === "hero";
  const distance = variant === "hero" ? 9.24 : variant === "compact" ? 5.0 : 4.6;

  return (
    <div
      className={["relative w-full h-full pointer-events-none", className].join(" ")}
      style={{ opacity, ...style }}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 45, position: [0, 0, distance], near: 0.1, far: 100 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{
          width: "100%",
          height: "100%",
          pointerEvents: interactive ? "auto" : "none",
        }}
        frameloop="always"
      >
        <Suspense fallback={null}>
          <SphereScene
            geometry={sphere}
            dust={dust}
            sparkle={sparkle}
            state={state}
            audioLevel={audioLevel}
            pointScale={lod.pointScale}
            interactive={interactive}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
