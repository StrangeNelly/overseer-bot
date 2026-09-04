import { XWATCH } from '@groupie/shared';
import type { XRule } from './client.js';

/**
 * Sharding the tracked handles into provider rules (docs/research-x-monitor.md
 * §3, correcting docs/research-x-monitoring.md).
 *
 * A twitterapi.io filter rule's `value` is capped at 255 CHARACTERS — verified
 * against their API reference on 2026-09-03, on add_rule, update_rule and
 * get_rules alike — which is about twelve to fourteen `from:` handles, not the
 * ~100 the earlier memo assumed. So the handle set is split into shards that
 * each fit, and the shard is the unit everything above counts in: cost steps
 * with the number of rules, and a monitor records which shard it is polled in.
 *
 * TWO GRAMMARS since round 25. `from:` is the account's own posts, and the
 * reason it is not the only one is measured: X hides some accounts from the
 * Latest index (`from:legsdotfun` returned zero posts for every window and for
 * all time on 2026-09-04, while the account was posting), and `to:` returned
 * every reply to that same account within seconds. So the same handle set is
 * sharded twice, with the same code and the same cap: once to ask what the
 * accounts said, once to ask what was said TO them.
 *
 * Pure and deterministic: the same handle set always produces the same shards,
 * in the same order, with the same ids — so a sync that changed nothing writes
 * nothing. The two grammars produce DIFFERENT ids for the same handles, which
 * is what keeps a monitor's recorded shard the from: one.
 */

const JOINER = ' OR ';

/** How one handle becomes one search term. */
export type TermBuilder = (handle: string) => string;

/** `from:legsdotfun` — the account's own posts, and what a monitor records. */
export const fromTerm: TermBuilder = (handle) => `from:${handle}`;

/** `to:legsdotfun` — replies TO the account, the recovery path's shard. */
export const toTerm: TermBuilder = (handle) => `to:${handle}`;

/**
 * A stable id for a shard's contents. Not the provider's rule id (poll mode
 * never registers one) — it is what `launch_monitors.provider_rule_id` records,
 * and it has to survive a restart unchanged or every boot would look like a
 * rule change.
 */
export function shardId(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return `shard:${hash.toString(16)}`;
}

/**
 * Split handles into rule-sized shards. Handles are de-duplicated and sorted so
 * the sharding is stable under insertion order; a handle longer than a whole
 * rule (impossible at X's 15-character limit, but not assumed) gets its own
 * shard rather than being dropped.
 *
 * `term` is the grammar (from: by default, to: for reply recovery) — the length
 * arithmetic below reads it rather than assuming a prefix, so a shorter or
 * longer term packs correctly against the same cap.
 */
export function shardHandles(
  handles: readonly string[],
  maxChars: number = XWATCH.ruleValueMaxChars,
  term: TermBuilder = fromTerm,
): XRule[] {
  const unique = [...new Set(handles.map((h) => h.trim().toLowerCase()).filter((h) => h !== ''))];
  unique.sort();
  const rules: XRule[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const value = current.map(term).join(JOINER);
    rules.push({ id: shardId(value), value, handles: [...current] });
    current = [];
    length = 0;
  };
  for (const handle of unique) {
    const cost = term(handle).length + (current.length === 0 ? 0 : JOINER.length);
    if (current.length > 0 && length + cost > maxChars) flush();
    current.push(handle);
    length += current.length === 1 ? term(handle).length : cost;
  }
  flush();
  return rules;
}

/** Which shard each handle landed in — the map the runner writes to the rows. */
export function ruleIdByHandle(rules: readonly XRule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of rules) {
    for (const handle of rule.handles) out.set(handle, rule.id);
  }
  return out;
}
