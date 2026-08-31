import { Hono } from 'hono';
import type { Db } from '@groupie/db';

/**
 * M1: health only. M3 adds initData auth, board endpoints, SSE, and serving
 * the built Mini App.
 */
export function createApi(_db: Db) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}
