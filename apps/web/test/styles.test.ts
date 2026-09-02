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
    for (const selector of ['.row-hit', '.row-dead', '.rail-dead', '.bin-btn', '.row-hoverlinks']) {
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

  it('leaves the hover strip above both of them', () => {
    expect(declarationsFor('.row-hoverlinks')).toContain('z-index: 2');
  });
});
