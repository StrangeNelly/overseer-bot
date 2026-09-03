import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Stacking rules the render tests cannot see (docs/decisions.md round 21).
 *
 * `.row-hit` is an absolutely-positioned button covering the whole row head, so
 * every STATIC sibling inside that head paints — and hit-tests — underneath it.
 * RESTORE shipped that way and could not be pressed on any row surface: the
 * markup was right, the paint order was not. Markup assertions would have
 * passed all the way through, so the rule itself is pinned here.
 *
 * The ladder inside a row head: `.row-hit` (auto) < the verdict and bin
 * controls (1) < `.row-hoverlinks` (2).
 */

// Comments go first: they sit between rules, so a selector list read raw picks
// up the paragraph above it — and a declaration could be "found" in prose.
const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Every declaration block whose selector list contains exactly this selector. */
function declarationsFor(selector: string): string {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  const bodies: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rules.exec(CSS)) !== null) {
    const list = (match[1] ?? '').split(',').map((part) => part.trim());
    if (list.includes(selector)) bodies.push(match[2] ?? '');
  }
  return bodies.join('\n');
}

describe('row-head stacking', () => {
  it('finds the blocks it is asserting about', () => {
    // The matcher is the risk here: a selector that stopped existing (or was
    // renamed) would make every assertion below vacuously true.
    for (const selector of [
      '.row-hit',
      '.row-dead',
      '.rail-dead',
      '.bin-btn',
      '.row-hoverlinks',
      '.upc-actions',
    ]) {
      expect(declarationsFor(selector), selector).not.toBe('');
    }
  });

  it('keeps .row-hit unlayered, so a lifted sibling can beat it', () => {
    expect(declarationsFor('.row-hit')).toContain('position: absolute');
    expect(declarationsFor('.row-hit')).not.toContain('z-index');
  });

  it('lifts RESTORE above the row-wide tap target', () => {
    const dead = declarationsFor('.row-dead');
    expect(dead).toContain('position: relative');
    expect(dead).toContain('z-index: 1');
  });

  it('...on the died rail too', () => {
    const rail = declarationsFor('.rail-dead');
    expect(rail).toContain('position: relative');
    expect(rail).toContain('z-index: 1');
  });

  it('...and lifts BIN, which sits in the same head with the same problem', () => {
    const bin = declarationsFor('.bin-btn');
    expect(bin).toContain('position: relative');
    expect(bin).toContain('z-index: 1');
  });

  it('lifts the UPCOMING controls too — X and UNTRACK sit in a row head', () => {
    // Round 23: the head turns pointer events off for its children so the row is
    // one target elsewhere; these two are controls, so the container turns them
    // back on and lifts them out of the ladder's floor.
    const actions = declarationsFor('.upc-actions');
    expect(actions).toContain('position: relative');
    expect(actions).toContain('z-index: 1');
    expect(declarationsFor('.row-head > .upc-actions')).toContain('pointer-events: auto');
  });

  it('leaves the hover strip above both of them', () => {
    expect(declarationsFor('.row-hoverlinks')).toContain('z-index: 2');
  });
});

/**
 * The peak line's own row (the owner's "the peak marketcap is not visible, cut
 * off").
 *
 * The peak used to ride the subline, where the ellipsis ate it: the identity
 * column is 112px on the desktop FRESH rail and 126px on mobile against a
 * caller-plus-peak string of 196-261px. It has its own line now, and the round
 * trip — the one clause the row's live multiple already implies — is dropped by
 * a container query where that line cannot hold it. None of that is visible to
 * a render test: the markup is identical at every width.
 */
describe('the peak line', () => {
  it('finds the blocks it is asserting about', () => {
    for (const selector of ['.row-peak', '.row-peak-tail', '.row-id']) {
      expect(declarationsFor(selector), selector).not.toBe('');
    }
  });

  it('ellipses rather than wraps — the head must never take a second line', () => {
    const peak = declarationsFor('.row-peak');
    expect(peak).toContain('white-space: nowrap');
    expect(peak).toContain('overflow: hidden');
    expect(peak).toContain('text-overflow: ellipsis');
  });

  it('queries its own width, so one rule serves a 112px rail and a 345px zone', () => {
    expect(declarationsFor('.row-peak')).toContain('container-type: inline-size');
  });

  it('...and does NOT put that container on .row-id, which would restack it', () => {
    // container-type implies layout containment, i.e. a stacking context. Four
    // other components share `.row-id`, and `.pill-x` inside it escapes the
    // row-wide `.row-hit` overlay with z-index — an escape a new stacking
    // context on the column would swallow. `.row-peak` is the same width and
    // holds nothing positioned, so it carries the container instead.
    expect(declarationsFor('.row-id')).not.toContain('container-type');
    expect(declarationsFor('.pill-x')).toContain('z-index: 1');
  });

  it('hides the round trip inside a container query, not a media query', () => {
    expect(CSS).toContain('@container');
    expect(declarationsFor('.row-peak-tail')).toContain('display: none');
  });
});
