import { defineConfig } from 'drizzle-kit'

// `pnpm db:generate` only reads the schema; the database URL is used by drizzle-kit studio/push.
export default defineConfig({
  dialect: 'turso',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: 'file:../../data/harness.db',
  },
  strict: true,
  verbose: true,
})
