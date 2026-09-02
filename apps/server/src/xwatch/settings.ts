import { XWATCH_DEFAULTS, type XWatchSettings } from '@groupie/shared';

/**
 * Per-group X-monitor settings (`groups.settings.xwatch`), read exactly the way
 * the alert and discovery settings are: untrusted jsonb, every key type-checked
 * on its own, so a hand-edited blob cannot turn the ping into something else.
 *
 * One knob for now — round 23 ships with the launch ping ON, and
 * `/overseer set launchping off` leaves the board row and takes the message
 * away.
 */
export function mergeXWatchSettings(partial: unknown): XWatchSettings {
  const overrides =
    typeof partial === 'object' && partial !== null && !Array.isArray(partial)
      ? (partial as Record<string, unknown>)
      : {};
  const out: XWatchSettings = { launchPing: XWATCH_DEFAULTS.launchPing };
  if (typeof overrides.launchPing === 'boolean') out.launchPing = overrides.launchPing;
  return out;
}

/** Effective X-monitor settings for a group, from its whole `settings` jsonb. */
export function xwatchSettingsOf(groupSettings: unknown): XWatchSettings {
  const root =
    typeof groupSettings === 'object' && groupSettings !== null && !Array.isArray(groupSettings)
      ? (groupSettings as Record<string, unknown>)
      : {};
  return mergeXWatchSettings(root.xwatch);
}
