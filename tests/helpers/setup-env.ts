/**
 * Test-wide defaults. The one-call fast path is on by default in production;
 * suites that script the agent loop turn by turn run without it. Fast-path
 * tests opt in explicitly with `fastPath: true`.
 */
process.env.VIBERON_FAST_PATH ??= "0";
