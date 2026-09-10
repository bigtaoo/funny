// Vitest globalSetup: a real Mongo for this package's tests — no Docker, no manual install.
// worldsvc uses multi-document transactions, so it needs a single-node rs0 replica set.
// The harness itself (pinned binary, URI handshake, shutdown sequencing) is shared:
// server/scripts/testMongoHarness.ts.
import { createMongoHarness } from '../../scripts/testMongoHarness';

export const { setup, teardown } = createMongoHarness({ pkg: 'worldsvc', replSet: true });
