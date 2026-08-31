import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Load the repo-root .env regardless of cwd (drizzle-kit runs from packages/db).
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // `generate` never connects; `migrate`/`push` fail fast if this is unset.
    url: process.env.DATABASE_URL ?? '',
  },
});
