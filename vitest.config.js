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
    // Under CI the suite passes in about 16 seconds and then never exits:
    // every file reports, no summary line is printed, and the job sits until
    // it is killed. The orphans reaped at that point are the vitest workers
    // themselves, so the files are done and the pool never closes. Running
    // every file in one fork sidesteps that. It costs roughly 13 seconds
    // locally, which is why it is not on everywhere. vitest is pinned at
    // ^2.0.0 and resolves to 2.1.9; upgrading it is the real fix and is
    // tracked separately.
    pool: 'forks',
    poolOptions: { forks: { singleFork: Boolean(process.env.CI) } },
  },
})
