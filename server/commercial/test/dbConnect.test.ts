// db.ts's connection-failure path: the one branch in the file no e2e file reaches, because every one of
// them connects successfully (or skips itself when Mongo is down before ever calling this).
//
// Worth pinning for one reason: the diagnostic it logs is built by redacting the URI, and a commercial
// deployment's NW_COMM_MONGO_URI carries `user:password@host` credentials. If that redaction ever breaks,
// the database password lands in the startup logs — which are shipped to Loki and readable by anyone with
// ops console access. The rethrow matters too: a startup that cannot reach its wallet database must fail
// loudly rather than come up and start answering wallet requests against nothing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommercialMongo } from '../src/db';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createCommercialMongo — unreachable database', () => {
  it('rethrows and logs the URI with its credentials redacted', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Port 1 is never a mongod; a short server-selection timeout keeps this fast.
    await expect(
      createCommercialMongo('mongodb://wallet_user:sup3r-s3cret@127.0.0.1:1/', 'nw_commercial_unreachable', {
        serverSelectionTimeoutMS: 200,
        connectTimeoutMS: 200,
      }),
    ).rejects.toThrow();

    expect(err).toHaveBeenCalledTimes(1);
    const logged = String(err.mock.calls[0]![0]);
    expect(logged).toContain('mongodb://<redacted>@127.0.0.1:1/');
    expect(logged).not.toContain('sup3r-s3cret');
    expect(logged).not.toContain('wallet_user');
    // Names the db and points at the env vars to check, so the failure is actionable from the log alone.
    expect(logged).toContain('nw_commercial_unreachable');
    expect(logged).toContain('NW_COMM_MONGO_URI');
  });
});
