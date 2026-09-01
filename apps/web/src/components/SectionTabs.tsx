import type { BoardResponse } from '@groupie/shared';

/** The sections that come straight off /board. */
export type BoardSectionKey = keyof BoardResponse['sections'];
/**
 * Ranging and Sleepers each have their own endpoint and their own controls, but
 * they ride the same tab strip.
 */
export type SectionKey = BoardSectionKey | 'ranging' | 'sleepers';

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
// distance from Fresh is part of saying so.
export const SECTIONS = [
  ...BOARD_SECTIONS,
  { key: 'ranging', label: 'Ranging', short: 'RNG' },
  { key: 'sleepers', label: 'Sleepers', short: 'SLPRS' },
] as const satisfies readonly { key: SectionKey; label: string; short: string }[];

interface SectionTabsProps {
  value: SectionKey;
  /** null = not loaded yet; the tab shows an em dash rather than a wrong zero. */
  counts: Record<SectionKey, number | null>;
  onChange: (next: SectionKey) => void;
}

export function SectionTabs({ value, counts, onChange }: SectionTabsProps) {
  return (
    <nav className="tabs" role="tablist" aria-label="Board sections">
      {SECTIONS.map((section) => {
        const count = counts[section.key];
        // Reviving is the one cyan tab: cyan is the comeback state colour.
        const cyan = section.key === 'reviving';
        return (
          <button
            key={section.key}
            type="button"
            role="tab"
            aria-selected={section.key === value}
            aria-label={section.label}
            className={`tab${section.key === value ? ' is-active' : ''}${cyan ? ' tab-cyan' : ''}`}
            onClick={() => onChange(section.key)}
          >
            <span className="tab-label">{section.short}</span>
            <span className="tab-count">{count === null ? '—' : count}</span>
          </button>
        );
      })}
    </nav>
  );
}
