// Vitest globalSetup: a real Mongo for this package's tests — no Docker, no manual install.
// auctionsvc only does single-document atomic operations, so a standalone mongod is enough.
// The harness itself (pinned binary, URI handshake, shutdown sequencing) is shared:
// server/scripts/testMongoHarness.ts.
import { createMongoHarness } from '../../scripts/testMongoHarness';

export const { setup, teardown } = createMongoHarness({ pkg: 'auctionsvc', replSet: false });
