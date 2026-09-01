import type { SparkPoint } from '@groupie/shared';

/** The visible high must be this close to the reported peak to earn the peak dot. */
const PEAK_MATCH = 0.02;

export type SparkTone = 'up' | 'down' | 'cyan' | 'dead' | 'flat';

interface SparklineProps {
  points: SparkPoint[];
  /** The 1x line: the dotted baseline the whole story is told against. */
  mcapAtCall: number | null;
  /** peakMcapSinceCall — decides whether the visible high IS the peak. */
  peak?: number | null;
  width?: number;
  height?: number;
  /** `hero` stretches to its container and draws heavier. */
  variant?: 'row' | 'hero';
  tone?: SparkTone;
  /** Shade the retrace between the peak and now (translucent red). */
  drawdown?: boolean;
  /** Hero runners fill the area under the trace. */
  fill?: boolean;
  className?: string;
}

/**
 * The call-story sparkline: dotted baseline at mcap-at-call, the trace relative
 * to it, a dot at the peak, an end dot at now, and drawdown shading between the
 * two on a retraced card. Above the baseline is green territory, below is red;
 * a flat line ON the baseline reads "unchanged", and a dead token is a dimmed
 * line that simply ends.
 */
export function Sparkline({
  points,
  mcapAtCall,
  peak,
  width = 44,
  height = 18,
  variant = 'row',
  tone,
  drawdown = false,
  fill = false,
  className,
}: SparklineProps) {
  const usable = points.filter((p) => typeof p.mcap === 'number' && Number.isFinite(p.mcap));
  if (usable.length < 2) return null;

  const first = usable[0]!;
  const last = usable[usable.length - 1]!;
  const values = usable.map((p) => p.mcap);
  const baseValue =
    typeof mcapAtCall === 'number' && Number.isFinite(mcapAtCall) && mcapAtCall > 0
      ? mcapAtCall
      : first.mcap;

  // The baseline is part of the domain: it must always be on canvas, or the
  // trace has nothing to be "relative to".
  const min = Math.min(...values, baseValue);
  const max = Math.max(...values, baseValue);
  const span = max - min;

  const hero = variant === 'hero';
  const pad = hero ? 4 : 2;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  // No synthesized span: a flat series sits mid-height, not on the floor, where
  // it would read as a crash to zero.
  const y = (value: number) => pad + innerH - (span === 0 ? 0.5 : (value - min) / span) * innerH;
  const x = (index: number) => pad + (index / (usable.length - 1)) * innerW;

  const coords = usable.map((p, i) => `${x(i).toFixed(1)},${y(p.mcap).toFixed(1)}`);
  const baselineY = y(baseValue);

  const resolvedTone: SparkTone =
    tone ?? (span === 0 || last.mcap === baseValue ? 'flat' : last.mcap > baseValue ? 'up' : 'down');
  const dead = resolvedTone === 'dead';

  // The peak dot only appears when the visible high really is the peak: a peak
  // set outside the sparkline window must not be claimed by a lesser high.
  let peakIndex = 0;
  for (let i = 1; i < usable.length; i++) if (usable[i]!.mcap > usable[peakIndex]!.mcap) peakIndex = i;
  const visiblePeak = usable[peakIndex]!.mcap;
  const peakKnown = typeof peak === 'number' && Number.isFinite(peak) && peak > 0;
  const peakIsVisible =
    !peakKnown || Math.abs(visiblePeak - (peak as number)) <= (peak as number) * PEAK_MATCH;
  const showPeak = peakIsVisible && visiblePeak > baseValue && peakIndex < usable.length - 1;

  const peakX = x(peakIndex);
  const peakY = y(visiblePeak);
  const lastX = x(usable.length - 1);
  const lastY = y(last.mcap);
  const showDrawdown = drawdown && showPeak && lastY > peakY;

  return (
    <svg
      className={`spark spark-${resolvedTone}${hero ? ' spark-hero' : ''}${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${width} ${height}`}
      width={hero ? '100%' : width}
      height={height}
      preserveAspectRatio={hero ? 'none' : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {fill ? (
        <polygon
          className="spark-area"
          points={`${coords.join(' ')} ${lastX.toFixed(1)},${(height - pad).toFixed(1)} ${x(0).toFixed(1)},${(height - pad).toFixed(1)}`}
        />
      ) : null}
      {showDrawdown ? (
        <polygon
          className="spark-drawdown"
          points={`${peakX.toFixed(1)},${peakY.toFixed(1)} ${lastX.toFixed(1)},${peakY.toFixed(1)} ${lastX.toFixed(1)},${lastY.toFixed(1)}`}
        />
      ) : null}
      <line
        className="spark-base"
        x1={pad}
        y1={baselineY.toFixed(1)}
        x2={width - pad}
        y2={baselineY.toFixed(1)}
        strokeDasharray={hero ? '3 3' : '2 2'}
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        className="spark-line"
        points={coords.join(' ')}
        fill="none"
        strokeWidth={hero ? 2 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {showPeak ? (
        <circle className="spark-peak" cx={peakX.toFixed(1)} cy={peakY.toFixed(1)} r={hero ? 3 : 1.9} />
      ) : null}
      {dead ? null : (
        <circle className="spark-end" cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r={hero ? 3 : 1.8} />
      )}
    </svg>
  );
}
