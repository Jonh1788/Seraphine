import { useId } from 'react';

export interface WaterGlassProps {
  percent: number; // 0..100
  total: number; // ml already drank today
  goal: number; // ml goal
  size?: number; // rendered width in px
  label?: boolean; // show "1250 / 2500 ml" + % below the glass (default true)
}

/**
 * Animated SVG drinking glass. The water level is a clipped rect whose `y` and
 * `height` interpolate via CSS `transition`. Ripples on top of the water and
 * rising bubbles are driven by SMIL `<animateTransform>` / `<animate>` so they
 * render reliably across browsers (CSS transforms inside `<svg>` have quirky
 * coordinate behaviour across Chrome/Safari/Firefox).
 *
 * viewBox: 0..100 wide, 0..140 tall. The glass trapezoid walls live on the
 * X range [20..80] at the top and [28..72] at the bottom.
 */
export function WaterGlass({
  percent,
  total,
  goal,
  size = 180,
  label = true,
}: WaterGlassProps): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  // `useId()` returns strings like ":r5:" — the colons break url(#...) refs
  // in some SVG renderers, so strip them.
  const uid = useId().replace(/:/g, '');
  const clipId = `water-clip-${uid}`;
  const gradId = `water-grad-${uid}`;
  const wavePathId = `water-wave-${uid}`;

  // Inner drinkable area (inside the glass walls).
  // Top of water area at y=18 (below rim), bottom at y=128 (glass base).
  const yTop = 18;
  const yBottom = 128;
  const innerHeight = yBottom - yTop; // 110
  const waterHeight = (clamped / 100) * innerHeight;
  const waterY = yBottom - waterHeight;

  // Format ml / goal as "1,25L / 2,5L" when >= 1000, else raw ml.
  const fmt = (ml: number): string => {
    if (ml >= 1000) {
      const l = ml / 1000;
      return `${l.toFixed(l >= 10 ? 1 : 2).replace(/\.?0+$/, '').replace('.', ',')}L`;
    }
    return `${ml}ml`;
  };

  const height = size * (140 / 100);

  return (
    <div className="water-glass" style={{ width: size }}>
      <svg
        className="water-glass__svg"
        width={size}
        height={height}
        viewBox="0 0 100 140"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <defs>
          {/* Glass interior clip — trapezoid that matches the inside of the walls. */}
          <clipPath id={clipId}>
            <path d="M21 15 L79 15 L71 128 L29 128 Z" />
          </clipPath>
          {/* Water gradient. */}
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#67e8f9" />
            <stop offset="60%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#0891b2" />
          </linearGradient>
          {/* Repeating sine wave; drawn twice the visible width so we can
               translate it horizontally without seams. */}
          <path
            id={wavePathId}
            d="M 0 6
               Q 5 0 10 6 T 20 6 T 30 6 T 40 6 T 50 6 T 60 6 T 70 6 T 80 6
               L 80 12 L 0 12 Z"
          />
        </defs>

        {/* Outer glass outline — soft highlight + border. */}
        <path
          d="M20 12 L80 12 L72 132 L28 132 Z"
          fill="rgba(255,255,255,0.03)"
          stroke="rgba(255,255,255,0.18)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />

        {/* Water body + waves, both clipped to the inner trapezoid. */}
        <g clipPath={`url(#${clipId})`}>
          {/* Solid water rect — animated via CSS `transition` on y/height. */}
          <rect
            className="water-glass__fill"
            x="0"
            y={waterY}
            width="100"
            height={waterHeight}
            fill={`url(#${gradId})`}
          />

          {/* Wave strip sits on top of the water. Two waves offset create
              the illusion of ripples. Only rendered when there's any water. */}
          {clamped > 1 && (
            <g
              className="water-glass__waves"
              transform={`translate(0 ${waterY - 6})`}
            >
              <g className="water-glass__wave water-glass__wave--front">
                <use href={`#${wavePathId}`} fill="#22d3ee" fillOpacity="0.85" />
                <use
                  href={`#${wavePathId}`}
                  fill="#22d3ee"
                  fillOpacity="0.85"
                  transform="translate(80 0)"
                />
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  from="0 0"
                  to="-80 0"
                  dur="3s"
                  repeatCount="indefinite"
                />
              </g>
              <g className="water-glass__wave water-glass__wave--back">
                <use href={`#${wavePathId}`} fill="#67e8f9" fillOpacity="0.5" />
                <use
                  href={`#${wavePathId}`}
                  fill="#67e8f9"
                  fillOpacity="0.5"
                  transform="translate(80 0)"
                />
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  from="-80 0"
                  to="0 0"
                  dur="4.5s"
                  repeatCount="indefinite"
                />
              </g>
            </g>
          )}

          {/* Bubbles. Rendered only when there's enough water to see them.
              Each bubble rises from near the bottom up to just below the
              surface, then restarts. Using SMIL so animations are reliable
              regardless of CSS-on-SVG quirks. */}
          {clamped > 8 && (
            <g className="water-glass__bubbles">
              {[
                { cx: 40, r: 1.6, dur: 3.2, delay: 0 },
                { cx: 55, r: 1.1, dur: 2.6, delay: 0.8 },
                { cx: 48, r: 0.9, dur: 3.8, delay: 1.6 },
                { cx: 62, r: 1.3, dur: 3.0, delay: 2.2 },
              ].map((b, i) => {
                const startY = yBottom - 4;
                const endY = Math.max(waterY + 4, yTop + 2);
                return (
                  <circle
                    key={i}
                    cx={b.cx}
                    cy={startY}
                    r={b.r}
                    fill="rgba(255,255,255,0.55)"
                  >
                    <animate
                      attributeName="cy"
                      from={startY}
                      to={endY}
                      dur={`${b.dur}s`}
                      begin={`${b.delay}s`}
                      repeatCount="indefinite"
                    />
                    <animate
                      attributeName="opacity"
                      values="0;0.6;0.6;0"
                      keyTimes="0;0.15;0.85;1"
                      dur={`${b.dur}s`}
                      begin={`${b.delay}s`}
                      repeatCount="indefinite"
                    />
                  </circle>
                );
              })}
            </g>
          )}
        </g>

        {/* Glass rim highlight (above the water). */}
        <line
          x1="22"
          y1="13"
          x2="78"
          y2="13"
          stroke="rgba(255,255,255,0.25)"
          strokeWidth="1"
          strokeLinecap="round"
        />

        {/* Subtle inside-glass vertical highlight. */}
        <path
          d="M26 18 L30 120"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>

      {label && (
        <>
          <div className="water-glass__label">
            <span className="water-glass__label-big">{fmt(total)}</span>
            <span className="water-glass__label-sep"> / </span>
            <span>{fmt(goal)}</span>
          </div>
          <div className="water-glass__percent">{Math.round(clamped)}%</div>
        </>
      )}
    </div>
  );
}
