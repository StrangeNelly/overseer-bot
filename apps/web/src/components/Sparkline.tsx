import { useEffect, useState } from 'react';
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
  /**
   * Reviving cards mark the revival instant with a hollow dot on the trace
   * (design pass 2, 3D): the comeback has a moment, and the trace is where it
   * happened. ISO instant; ignored when it falls outside the window.
   */
  revivedAt?: string | null;
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
  revivedAt = null,
  className,
}: SparklineProps) {
  const hero = variant === 'hero';
  /**
   * A hero spark fills its container, so the drawing has to happen in the
   * container's own pixels: with a fixed 600-wide viewBox stretched to fit,
   * `preserveAspectRatio="none"` squashes every <circle> into an ellipse (the
   * strokes are protected by vector-effect, the dots are not). Measure, then
   * draw 1:1 — until the first measurement lands, the nominal width is used.
   */
  // A state-held element rather than a ref: the first render can return null
  // (fewer than two usable points), and an effect keyed on a ref would never
  // see the svg that mounts later. Both axes are measured — the mobile
  // spotlight sets the hero's height from CSS, and a viewBox drawn at the
  // nominal height would squash the dots vertically just as the width did.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    if (!hero || !svgEl || typeof ResizeObserver !== 'function') return;
    const sync = () => {
      const rect = svgEl.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w > 0 && h > 0) setMeasured((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(svgEl);
    return () => observer.disconnect();
  }, [hero, svgEl]);

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

  const drawWidth = hero ? (measured?.w ?? width) : width;
  const drawHeight = hero ? (measured?.h ?? height) : height;
  const pad = hero ? 4 : 2;
  const innerW = drawWidth - pad * 2;
  const innerH = drawHeight - pad * 2;
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

  // The revival marker sits on the sample nearest the revival instant — and
  // only when that instant is genuinely inside the window we drew, so a coin
  // revived before the trace begins does not get a dot on its first point.
  let revivalIndex: number | null = null;
  if (revivedAt) {
    const at = Date.parse(revivedAt);
    if (!Number.isNaN(at) && at >= first.t && at <= last.t) {
      let nearest = 0;
      for (let i = 1; i < usable.length; i++) {
        if (Math.abs(usable[i]!.t - at) < Math.abs(usable[nearest]!.t - at)) nearest = i;
      }
      if (nearest < usable.length - 1) revivalIndex = nearest;
    }
  }

  return (
    <svg
      className={`spark spark-${resolvedTone}${hero ? ' spark-hero' : ''}${className ? ` ${className}` : ''}`}
      ref={setSvgEl}
      viewBox={`0 0 ${drawWidth} ${drawHeight}`}
      width={hero ? '100%' : width}
      height={height}
      preserveAspectRatio={hero ? 'none' : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {fill ? (
        <polygon
          className="spark-area"
          points={`${coords.join(' ')} ${lastX.toFixed(1)},${(drawHeight - pad).toFixed(1)} ${x(0).toFixed(1)},${(drawHeight - pad).toFixed(1)}`}
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
        x2={drawWidth - pad}
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
      {revivalIndex === null ? null : (
        <circle
          className="spark-revival"
          cx={x(revivalIndex).toFixed(1)}
          cy={y(usable[revivalIndex]!.mcap).toFixed(1)}
          r={hero ? 3 : 2}
          fill="none"
        />
      )}
      {dead ? null : (
        <circle className="spark-end" cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r={hero ? 3 : 1.8} />
      )}
    </svg>
  );
}
