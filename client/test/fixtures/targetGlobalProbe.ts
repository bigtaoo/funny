// Compile fixture for targetGlobalCompile.test.ts. Deliberately spells the read exactly the way
// app/appConstants.ts, analytics/index.ts and net/anomaly/reporter.ts do — a member expression on
// globalThis, which is the detail that decided whether DefinePlugin substituted anything at all.
// No imports, so the emitted bundle can be require()'d in Node and asked what it actually sees.
export const target = (globalThis as { TARGET?: string }).TARGET ?? 'NOT-SUBSTITUTED';
