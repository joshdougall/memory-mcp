import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    // These are integration tests: each spawns a server process and talks to a
    // real Valkey, so they are far slower than unit tests. `timeout` is not a
    // vitest option and was silently ignored, leaving the 5s default in place.
    testTimeout: 30000,
    // waitReady() polls /health for up to 10s, which is also the default
    // hookTimeout. Raise it so a slow server start surfaces waitReady's own
    // error rather than racing an unrelated hook timeout.
    hookTimeout: 30000,
    // Agent worktrees under .claude/ are full checkouts of this repo, so they
    // contain their own copy of tests/. Without this, a bare `npm test` in the
    // main checkout discovers every copy and runs them concurrently against the
    // same Valkey, which fails in ways that look like real regressions. Spread
    // the defaults rather than replacing them, or node_modules stops being
    // excluded.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})
