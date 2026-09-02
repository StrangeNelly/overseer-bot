import { DISCOVERY_DEFAULTS, DISCOVERY_LIMITS, type DiscoverySettings } from '@groupie/shared';

/**
 * Per-group discovery settings (`groups.settings.discovery`), read the same way
 * the watchlist's are read in poller/alertLogic.ts: untrusted jsonb, every key
 * type-checked and clamped on its own, so one bad key cannot discard the rest
 * or turn the chat into a firehose.
 *
 * `bundleMaxPct` is deliberately not here — it is a shared filter constant, not
 * a group's taste (docs/decisions.md round 20: "tunable later").
 */

/** Clamps into range; a non-finite value falls back to the default. */
export function clampDiscoverySetting(
  key: keyof typeof DISCOVERY_LIMITS,
  value: number,
): number {
  if (!Number.isFinite(value)) return DISCOVERY_DEFAULTS[key];
  const { min, max } = DISCOVERY_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

/**
 * `launchMinEth` has one value outside its clamp that is legal: 0, the mute.
 * Everything between 0 and the floor rounds UP to the floor rather than down to
 * silence — a member typing 0.01 wants a low threshold, not an off switch, and
 * the off switch has its own documented value.
 */
export function clampLaunchMinEth(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DISCOVERY_DEFAULTS.launchMinEth;
  if (value === 0) return 0;
  return clampDiscoverySetting('launchMinEth', value);
}

export function mergeDiscoverySettings(partial: unknown): DiscoverySettings {
  const overrides =
    typeof partial === 'object' && partial !== null && !Array.isArray(partial)
      ? (partial as Record<string, unknown>)
      : {};
  const out: DiscoverySettings = {
    launchMinEth: DISCOVERY_DEFAULTS.launchMinEth,
    gradsOn: DISCOVERY_DEFAULTS.gradsOn,
    alertsPerHour: DISCOVERY_DEFAULTS.alertsPerHour,
  };
  if (typeof overrides.launchMinEth === 'number') {
    out.launchMinEth = clampLaunchMinEth(overrides.launchMinEth);
  }
  if (typeof overrides.gradsOn === 'boolean') out.gradsOn = overrides.gradsOn;
  if (typeof overrides.alertsPerHour === 'number') {
    out.alertsPerHour = Math.round(clampDiscoverySetting('alertsPerHour', overrides.alertsPerHour));
  }
  return out;
}

/** Effective discovery settings for a group, from its whole `settings` jsonb. */
export function discoverySettingsOf(groupSettings: unknown): DiscoverySettings {
  const root =
    typeof groupSettings === 'object' && groupSettings !== null && !Array.isArray(groupSettings)
      ? (groupSettings as Record<string, unknown>)
      : {};
  return mergeDiscoverySettings(root.discovery);
}
