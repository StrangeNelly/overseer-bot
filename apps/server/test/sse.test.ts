import { describe, expect, it } from 'vitest';
import { changesRelevance, relevanceOf } from '../src/api/sse.js';
import type { GroupieEvent } from '../src/events.js';

/**
 * Which events a board's stream writes, decided before any query
 * (docs/decisions.md round 16 review).
 *
 * Round 16 made a watch on a coin the group never called a first-class thing:
 * the ON WATCH zone is the only place a member can free a slot, and every one
 * of its rows can be call-less. The old gate ran an EXISTS over `calls` on
 * EVERY event, so a watch_changed that already named this group was dropped for
 * exactly those coins — and the negative was cached for a minute behind it.
 */

const GROUP_ID = 1;
const OTHER_GROUP_ID = 2;
const TOKEN_ID = 7;

describe('relevanceOf', () => {
  it('writes a group-scoped event that names THIS group, without asking', () => {
    const events: GroupieEvent[] = [
      { type: 'watch_changed', tokenId: TOKEN_ID, groupId: GROUP_ID },
      { type: 'call_binned', tokenId: TOKEN_ID, callId: 5, groupId: GROUP_ID },
      {
        type: 'alert_fired',
        groupId: GROUP_ID,
        tokenId: TOKEN_ID,
        alertType: 'nuke',
        message: 'x',
      },
    ];
    for (const event of events) expect(relevanceOf(event, GROUP_ID)).toBe('write');
  });

  it('skips a group-scoped event belonging to another group', () => {
    const events: GroupieEvent[] = [
      { type: 'watch_changed', tokenId: TOKEN_ID, groupId: OTHER_GROUP_ID },
      { type: 'call_binned', tokenId: TOKEN_ID, callId: 5, groupId: OTHER_GROUP_ID },
    ];
    for (const event of events) expect(relevanceOf(event, GROUP_ID)).toBe('skip');
  });

  it('asks about token-only events — they belong to no group by themselves', () => {
    const events: GroupieEvent[] = [
      { type: 'price_update', tokenId: TOKEN_ID, mcapUsd: 1 },
      { type: 'token_resolved', tokenId: TOKEN_ID, symbol: 'TKN' },
      { type: 'new_call', tokenId: TOKEN_ID, address: '0xabc' },
      { type: 'token_died', tokenId: TOKEN_ID, reason: 'liquidity_floor' },
      { type: 'token_revived', tokenId: TOKEN_ID },
      { type: 'call_revived', tokenId: TOKEN_ID, callId: 5 },
      { type: 'rug_hidden', tokenId: TOKEN_ID },
      { type: 'rug_revived', tokenId: TOKEN_ID },
    ];
    for (const event of events) expect(relevanceOf(event, GROUP_ID)).toBe('ask');
  });
});

describe('changesRelevance — what invalidates a cached "no"', () => {
  it('includes a watch: round 16 made it a relevance source of its own', () => {
    expect(changesRelevance({ type: 'watch_changed', tokenId: TOKEN_ID, groupId: GROUP_ID })).toBe(
      true,
    );
  });

  it('...alongside the two events that could already make a token relevant', () => {
    expect(changesRelevance({ type: 'new_call', tokenId: TOKEN_ID, address: '0xabc' })).toBe(true);
    expect(changesRelevance({ type: 'call_revived', tokenId: TOKEN_ID, callId: 5 })).toBe(true);
  });

  it('leaves the cache alone for events that change no membership', () => {
    expect(changesRelevance({ type: 'price_update', tokenId: TOKEN_ID, mcapUsd: 1 })).toBe(false);
    expect(changesRelevance({ type: 'token_died', tokenId: TOKEN_ID, reason: 'rug_floor' })).toBe(
      false,
    );
  });
});
