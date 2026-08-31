import type { BoardResponse } from '@groupie/shared';

export type SectionKey = keyof BoardResponse['sections'];

export const SECTIONS = [
  { key: 'fresh', label: 'Fresh' },
  { key: 'runners', label: 'Runners' },
  { key: 'retraced', label: 'Retraced' },
  { key: 'died', label: 'Died' },
] as const satisfies readonly { key: SectionKey; label: string }[];

interface SectionTabsProps {
  value: SectionKey;
  counts: Record<SectionKey, number>;
  onChange: (next: SectionKey) => void;
}

export function SectionTabs({ value, counts, onChange }: SectionTabsProps) {
  return (
    <nav className="tabs" role="tablist" aria-label="Board sections">
      {SECTIONS.map((section) => (
        <button
          key={section.key}
          type="button"
          role="tab"
          aria-selected={section.key === value}
          className={`tab${section.key === value ? ' is-active' : ''}`}
          onClick={() => onChange(section.key)}
        >
          <span className="tab-label">{section.label}</span>
          <span className="tab-count">{counts[section.key]}</span>
        </button>
      ))}
    </nav>
  );
}
