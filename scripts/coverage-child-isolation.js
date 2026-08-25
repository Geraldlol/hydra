"use strict";

// Node initializes this worker's V8 coverage hooks before loading --require
// modules. Removing the variable here leaves worker coverage active while
// preventing child_process from forcing the same output directory into test
// fixture grandchildren. Those helpers may be killed intentionally; keeping
// them out of the parent collector avoids partial coverage JSON without
// excluding any production module executed by the test worker itself.
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  delete process.env.NODE_V8_COVERAGE;
}
