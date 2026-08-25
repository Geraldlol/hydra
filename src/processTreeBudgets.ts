// Windows process launch and teardown share one ordered budget. A cold
// PowerShell Add-Type compile may consume the full bind window; termination
// must still have time to run its identity-bound helper before any caller's
// final unconfirmed-lifecycle backstop fires.
export const WINDOWS_PROCESS_TREE_JOB_BIND_TIMEOUT_MS = 10_000;
export const WINDOWS_PROCESS_TREE_TERMINATION_HELPER_TIMEOUT_MS = 5_000;
export const TERMINATION_FORCE_GRACE_MS = 1_000;
export const TERMINATION_CONFIRM_WINDOW_MS = 20_000;

