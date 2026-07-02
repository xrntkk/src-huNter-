import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to the code under src/**/__tests__ or *.test.ts.
    include: ['src/**/*.test.ts'],
    // setup.ts points DATABASE_URL at a throwaway sqlite file BEFORE any
    // module imports @src-agent/db (the db handle is a module-level singleton,
    // so the env var must be set first).
    setupFiles: ['./src/test/setup.ts'],
    // Agent-loop tests drive a mock model and assert ordering; keep them serial
    // and give generous time since some exercise multi-iteration loops.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
