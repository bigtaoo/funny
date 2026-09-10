// Vitest globalSetup: a real Mongo for this package's tests — no Docker, no manual install.
// @nw/shared's mongo helpers only issue createIndex calls, never transactions, so a standalone mongod is enough.
// The harness itself (pinned binary, URI handshake, shutdown sequencing) is shared:
// server/scripts/testMongoHarness.ts.
import { createMongoHarness } from '../../scripts/testMongoHarness';

export const { setup, teardown } = createMongoHarness({ pkg: 'shared', replSet: false });
