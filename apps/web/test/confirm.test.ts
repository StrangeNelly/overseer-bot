import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, confirmStep, pressedOutside } from '../src/confirm';
import type { ConfirmEvent, ConfirmState } from '../src/confirm';

/**
 * The two-tap guard behind MARK DEAD and RESTORE (docs/decisions.md round 21).
 *
 * Both actions are group-wide and instant, and both sit on a pill the size of
 * WATCH — inside a hover strip a thumb crosses on its way somewhere else. This
 * app has no DOM test environment, so the guard lives in `confirm.ts` as pure
 * functions and the whole rule is asserted here rather than through a rendered
 * button: every transition the component wires up has a case below.
 */
describe('confirmStep', () => {
  it('arms on the first press and fires on the second', () => {
    const armed = confirmStep('idle', 'press');
    expect(armed).toEqual({ state: 'armed', fire: false });
    expect(confirmStep(armed.state, 'press')).toEqual({ state: 'idle', fire: true });
  });

  it('never fires on the first press — that is the whole point', () => {
    expect(confirmStep('idle', 'press').fire).toBe(false);
  });

  it('reverts on the timeout, without firing', () => {
    expect(confirmStep('armed', 'timeout')).toEqual({ state: 'idle', fire: false });
  });

  it('reverts when something else is tapped, without firing', () => {
    expect(confirmStep('armed', 'outside')).toEqual({ state: 'idle', fire: false });
  });

  it('reverts when focus leaves the pill, without firing', () => {
    expect(confirmStep('armed', 'blur')).toEqual({ state: 'idle', fire: false });
  });

  it('reverts when the pill goes into flight — a disabled pill is never armed', () => {
    expect(confirmStep('armed', 'disable')).toEqual({ state: 'idle', fire: false });
  });

  it('is a no-op for a pill that is already at rest', () => {
    expect(confirmStep('idle', 'timeout')).toEqual({ state: 'idle', fire: false });
    expect(confirmStep('idle', 'outside')).toEqual({ state: 'idle', fire: false });
    expect(confirmStep('idle', 'blur')).toEqual({ state: 'idle', fire: false });
    expect(confirmStep('idle', 'disable')).toEqual({ state: 'idle', fire: false });
  });

  it('re-arms after a completed fire, so the pill stays usable', () => {
    const fired = confirmStep('armed', 'press');
    expect(fired.state).toBe('idle');
    expect(confirmStep(fired.state, 'press')).toEqual({ state: 'armed', fire: false });
  });

  it('needs two fresh presses again after a disarm — one is never enough', () => {
    for (const revoke of ['timeout', 'outside', 'blur', 'disable'] as const) {
      const back = confirmStep(confirmStep('idle', 'press').state, revoke);
      expect(back.state).toBe('idle');
      expect(confirmStep(back.state, 'press').fire).toBe(false);
    }
  });

  it('fires on exactly one transition, over the whole state/event table', () => {
    const states: ConfirmState[] = ['idle', 'armed'];
    const events: ConfirmEvent[] = ['press', 'timeout', 'outside', 'blur', 'disable'];
    const firing = states.flatMap((state) =>
      events.filter((event) => confirmStep(state, event).fire).map((event) => `${state}/${event}`),
    );
    expect(firing).toEqual(['armed/press']);
  });

  it('gives the second tap a window a human can hit', () => {
    expect(CONFIRM_MS).toBeGreaterThanOrEqual(2_000);
    expect(CONFIRM_MS).toBeLessThanOrEqual(10_000);
  });
});

/**
 * The capture-phase listener's own question. It sees the arming press and the
 * firing one too, so "inside" has to mean "leave this alone" — otherwise the
 * pill would disarm itself on the way to firing.
 */
describe('pressedOutside', () => {
  const inside = { id: 'inside' };
  const pill = { contains: (node: unknown) => node === inside };

  it('leaves the pill armed when the tap landed on it', () => {
    expect(pressedOutside(pill, inside)).toBe(false);
  });

  it('disarms on a tap anywhere else', () => {
    expect(pressedOutside(pill, { id: 'elsewhere' })).toBe(true);
  });

  it('disarms when there is nothing to be inside of, or nothing was hit', () => {
    expect(pressedOutside(null, inside)).toBe(true);
    expect(pressedOutside(undefined, inside)).toBe(true);
    expect(pressedOutside(pill, null)).toBe(true);
    expect(pressedOutside(pill, undefined)).toBe(true);
  });
});
