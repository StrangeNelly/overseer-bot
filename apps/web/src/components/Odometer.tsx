import { useEffect, useState } from 'react';
import { useReducedMotion } from '../motion';

/** Design: ~120ms per digit, rolling from the right. */
const STAGGER_MS = 22;

interface OdometerProps {
  /** Already formatted — the roll is presentation, the value stays the board's. */
  value: string;
  className?: string;
  title?: string;
}

interface State {
  value: string;
  prev: string;
  /** Bumped per change so a repeated digit still restarts its animation. */
  seq: number;
}

/**
 * Numbers that tick over roll their changed characters vertically, odometer
 * style. Unchanged characters never move, so `$609K -> $612K` rolls two digits
 * and nothing else. Reduced motion renders plain text.
 */
export function Odometer({ value, className, title }: OdometerProps) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<State>({ value, prev: value, seq: 0 });

  useEffect(() => {
    setState((current) =>
      current.value === value ? current : { value, prev: current.value, seq: current.seq + 1 },
    );
  }, [value]);

  if (reduced) {
    return (
      <span className={className} title={title}>
        {value}
      </span>
    );
  }

  const chars = [...state.value];
  const prevChars = [...state.prev];

  return (
    <span className={className} title={title}>
      {chars.map((char, index) => {
        const rolled = state.seq > 0 && prevChars[index] !== char;
        return (
          <span
            key={rolled ? `${index}-${state.seq}` : index}
            className={rolled ? 'odo-char odo-roll' : 'odo-char'}
            style={rolled ? { animationDelay: `${(chars.length - 1 - index) * STAGGER_MS}ms` } : undefined}
          >
            {char}
          </span>
        );
      })}
    </span>
  );
}
