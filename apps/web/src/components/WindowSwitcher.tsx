import type { BoardWindow } from '@groupie/shared';

/** Mirrors BOARD_WINDOWS from the contract; `satisfies` keeps it honest. */
export const WINDOWS = ['6h', '12h', '24h', '3d', '7d', '30d'] as const satisfies readonly BoardWindow[];

interface WindowSwitcherProps {
  value: BoardWindow;
  onChange: (next: BoardWindow) => void;
  disabled?: boolean;
}

export function WindowSwitcher({ value, onChange, disabled }: WindowSwitcherProps) {
  return (
    <div className="windows" role="group" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button
          key={w}
          type="button"
          className={`window-btn${w === value ? ' is-active' : ''}`}
          aria-pressed={w === value}
          disabled={disabled}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}
