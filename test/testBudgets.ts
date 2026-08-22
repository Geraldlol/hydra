/**
 * Shared timeout budgets for tests that drive real child processes.
 *
 * Why this exists: every flaky failure investigated in this suite had the same
 * shape. A test spawns a real process, passes a `timeoutMs` intended purely as
 * a hang net, and picks a value that looks generous against a single suite
 * running alone — 2s, 4s, 5s. Under `--test-concurrency` those same budgets are
 * short enough to expire mid-scenario, and the run then reports the timeout
 * classification instead of the one the test exists to check. The symptom is a
 * test that passes in isolation and fails a few runs in three under load.
 *
 * The distinction the constants encode:
 *
 * - **A hang net must never fire.** It exists so a wedged child cannot hang the
 *   whole suite, and nothing about the scenario should approach it. Use
 *   {@link HANG_NET_TIMEOUT_MS} and never tune it down to "about how long this
 *   takes" — that reintroduces the race.
 * - **A scenario budget must fire**, because the timeout is the behaviour under
 *   test. Those stay local, small and explicit at their call site, where the
 *   assertion that depends on them is visible. They are deliberately not
 *   centralised here: load only makes them more likely to fire, so they are
 *   safe, and a shared name would invite someone to "fix" them by raising it.
 */

/**
 * A budget no scenario in this suite should ever reach.
 *
 * Thirty seconds is far past the slowest observed spawn-plus-protocol handshake
 * under a loaded parallel run (worst seen: ~7s), while still bounding a genuine
 * hang well inside the runner's own per-test timeout.
 */
export const HANG_NET_TIMEOUT_MS = 30_000;
