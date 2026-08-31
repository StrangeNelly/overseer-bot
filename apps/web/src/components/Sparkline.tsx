import type { SparkPoint } from '@groupie/shared';

interface SparklineProps {
  points: SparkPoint[];
  width?: number;
  height?: number;
}

/**
 * Last-24h mcap trace. Stroke colour is decided by first-vs-last only — no
 * axes, no fill; this is a glance, not a chart.
 */
export function Sparkline({ points, width = 64, height = 24 }: SparklineProps) {
  const usable = points.filter((p) => typeof p.mcap === 'number' && Number.isFinite(p.mcap));
  if (usable.length < 2) return null;

  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const values = usable.map((p) => p.mcap);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // No synthesized span: a flat series must sit mid-height, not on the floor,
  // where it would read as a crash to zero.
  const span = max - min;

  const pad = 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const coords = usable
    .map((p, i) => {
      const x = pad + (i / (usable.length - 1)) * innerW;
      const norm = span === 0 ? 0.5 : (p.mcap - min) / span;
      const y = pad + innerH - norm * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  // A flat series is neither rising nor falling: leave it the base (dim)
  // stroke rather than colouring it "up".
  const trend = span === 0 ? '' : last.mcap >= first.mcap ? ' spark-up' : ' spark-down';

  return (
    <svg
      className={`spark${trend}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={coords}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
