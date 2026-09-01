import type { BoardResponse } from '@groupie/shared';
import type { ZoneTone } from './Zone';

/** The sections that come straight off /board. */
export type BoardSectionKey = keyof BoardResponse['sections'];
/**
 * ON WATCH is its own surface (round 16): it renders from the group's whole
 * watchlist, not from a board section, because a watch set in the chat or from
 * a Sleepers row has no call to file under. Ranging and Sleepers each have their
 * own endpoint and their own controls, but they ride the same strip.
 */
export type SectionKey = BoardSectionKey | 'watch' | 'ranging' | 'sleepers';

// Reviving sits SECOND, right after Fresh: the owner asked for a comeback
// banner, and a coin that just clawed its way out of rug probation is the most
// perishable thing on the board — it does not belong down by Died.
export const BOARD_SECTIONS = [
  { key: 'fresh', label: 'Fresh', short: 'FRESH' },
  { key: 'reviving', label: 'Reviving', short: 'REVIVING' },
  { key: 'runners', label: 'Runners', short: 'RUNNERS' },
  { key: 'retraced', label: 'Retraced', short: 'RETR' },
  { key: 'died', label: 'Died', short: 'DIED' },
] as const satisfies readonly { key: BoardSectionKey; label: string; short: string }[];

// Sleepers sits LAST, after the group's own surfaces: it is the one tab that is
// not about the group's calls at all (docs/decisions.md round 9), and its
// distance from Fresh is part of saying so. ON WATCH sits between the board's
// zones and the analytical views — it is the group's, but it is a state, not a
// section.
export const SECTIONS = [
  { key: 'fresh', label: 'Fresh', short: 'FRESH', tone: 'fresh' },
  { key: 'reviving', label: 'Reviving', short: 'REVIVING', tone: 'reviving' },
  { key: 'runners', label: 'Runners', short: 'RUNNERS', tone: 'runners' },
  { key: 'retraced', label: 'Retraced', short: 'RETR', tone: 'retraced' },
  { key: 'watch', label: 'On watch', short: 'ON WATCH', tone: 'watch' },
  { key: 'died', label: 'Died', short: 'DIED', tone: 'died' },
  { key: 'ranging', label: 'Ranging', short: 'RNG', tone: 'cyan' },
  { key: 'sleepers', label: 'Sleepers', short: 'SLPRS', tone: 'cyan' },
] as const satisfies readonly {
  key: SectionKey;
  label: string;
  short: string;
  tone: ZoneTone;
}[];

interface SectionTabsProps {
  value: SectionKey;
  /** null = not loaded yet; the chip shows an em dash rather than a wrong zero. */
  counts: Record<SectionKey, number | null>;
  onChange: (next: SectionKey) => void;
}

/**
 * Design pass 2 (3F): the tab row became a strip of zone CHIPS — bordered
 * boxes carrying the same tone their zone band wears, so the active tab and the
 * region it opens are the same colour idea. The strip scrolls sideways under a
 * fade rather than wrapping.
 */
export function SectionTabs({ value, counts, onChange }: SectionTabsProps) {
  return (
    <div className="zchips-wrap">
      <nav className="zchips" role="tablist" aria-label="Board sections">
        {SECTIONS.map((section) => {
          const count = counts[section.key];
          const active = section.key === value;
          return (
            <button
              key={section.key}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={section.label}
              className={`zchip zchip-${section.tone}${active ? ' is-active' : ''}`}
              onClick={() => onChange(section.key)}
            >
              <span className="zchip-label">{section.short}</span>
              <span className="zchip-count">{count === null ? '—' : count}</span>
            </button>
          );
        })}
      </nav>
      <span className="zchips-fade" aria-hidden="true" />
    </div>
  );
}
