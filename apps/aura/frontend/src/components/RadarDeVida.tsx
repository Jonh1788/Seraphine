interface RadarDeVidaProps {
  /** 5 values in 0-100 order: Produtividade, Finanças, Conhecimento, Planejamento, Equilíbrio */
  values: number[];
  /** Optional central number displayed over the chart (e.g. a score). */
  centerValue?: string;
  /** Optional caption under the center value. */
  centerLabel?: string;
}

const LABELS = ["Produt.", "Finanças", "Conhec.", "Planej.", "Equilíb."];
const SIZE = 180;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 22;
const LEVELS = 4;

function polar(angleDeg: number, r: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: CENTER + Math.cos(rad) * r, y: CENTER + Math.sin(rad) * r };
}

export function RadarDeVida({ values, centerValue, centerLabel }: RadarDeVidaProps) {
  const normalized = values.slice(0, 5);
  while (normalized.length < 5) normalized.push(0);

  const angleStep = 360 / 5;
  const axisPoints = Array.from({ length: 5 }, (_, i) => polar(i * angleStep, RADIUS));
  const valuePoints = normalized.map((v, i) => {
    const clamped = Math.max(0, Math.min(100, v));
    return polar(i * angleStep, (RADIUS * clamped) / 100);
  });

  const polygonPts = valuePoints.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-44 w-44"
        role="img"
        aria-label="Radar de Vida"
      >
        {/* Concentric rings */}
        {Array.from({ length: LEVELS }, (_, i) => {
          const r = (RADIUS * (i + 1)) / LEVELS;
          const pts = Array.from({ length: 5 }, (_, k) => polar(k * angleStep, r))
            .map((p) => `${p.x},${p.y}`)
            .join(" ");
          return (
            <polygon
              key={i}
              points={pts}
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={1}
            />
          );
        })}

        {/* Axes */}
        {axisPoints.map((p, i) => (
          <line
            key={i}
            x1={CENTER}
            y1={CENTER}
            x2={p.x}
            y2={p.y}
            stroke="rgba(255,255,255,0.06)"
            strokeWidth={1}
          />
        ))}

        {/* Value polygon */}
        <polygon
          points={polygonPts}
          fill="rgba(167,139,250,0.25)"
          stroke="#a78bfa"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />

        {/* Value dots */}
        {valuePoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={2.5} fill="#a78bfa" />
        ))}

        {/* Labels */}
        {LABELS.map((label, i) => {
          const outer = polar(i * angleStep, RADIUS + 12);
          return (
            <text
              key={i}
              x={outer.x}
              y={outer.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="7"
              fill="#64748b"
            >
              {label}
            </text>
          );
        })}

        {/* Center label */}
        {centerValue ? (
          <>
            <text
              x={CENTER}
              y={CENTER - 4}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="16"
              fontWeight="700"
              fill="#e5e7eb"
            >
              {centerValue}
            </text>
            {centerLabel ? (
              <text
                x={CENTER}
                y={CENTER + 10}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="7"
                fill="#64748b"
              >
                {centerLabel}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
    </div>
  );
}
