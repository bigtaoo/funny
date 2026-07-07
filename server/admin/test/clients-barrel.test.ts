// Guards the 2026-07-07 split of clients.ts (956→16) into per-service files under clients/* behind an
// `export *` barrel. If a service file stops being re-exported (dropped barrel line, renamed file),
// the corresponding Http* client vanishes from './clients' and this test fails — before index.ts,
// which wires all of them into AdminService, breaks at runtime.
import { describe, it, expect } from 'vitest';
import * as clients from '../src/clients';

// The 13 target-service HTTP clients (one per backend the admin backend talks to).
const EXPECTED_CLIENTS = [
  'HttpStatsClient',
  'HttpPlayerClient',
  'HttpAntiCheatClient',
  'HttpMismatchClient',
  'HttpSuspiciousPveClient',
  'HttpAnalyticsClient',
  'HttpMailDispatcher',
  'HttpWorldClient',
  'HttpAuctionClient',
  'HttpLadderClient',
  'HttpEventsClient',
  'HttpGachaPoolsClient',
  'HttpPromoClient',
] as const;

describe('admin clients barrel', () => {
  it('re-exports every Http* client as a constructor', () => {
    const bag = clients as Record<string, unknown>;
    for (const name of EXPECTED_CLIENTS) {
      expect(typeof bag[name], name).toBe('function');
    }
  });

  it('re-exports EventsClientError (thrown across service clients)', () => {
    expect(typeof (clients as Record<string, unknown>).EventsClientError).toBe('function');
  });
});
