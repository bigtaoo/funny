// The production→sandbox verifier fallback in makeAppleServerApi.
//
// This seam had no test, and that is exactly how it shipped broken: every other Apple test injects a
// fake AppleServerApi, which sits ABOVE the verifiers and so never exercises the decision about which
// environment a payload belongs to. Verified against a real Apple TEST notification on 2026-09-07:
// the production verifier rejects a sandbox payload with INVALID_APP_IDENTIFIER (3), not
// INVALID_ENVIRONMENT (4), because it is built with appAppleId while a sandbox payload carries none.
// Only INVALID_ENVIRONMENT was retried, so every sandbox notification came back unverified while
// Apple recorded the delivery as a success.
import { describe, expect, it } from 'vitest';
import { VerificationException, VerificationStatus } from '@apple/app-store-server-library';
import { makeAppleServerApi } from '../src/iap/appleServerApi.js';

const NOTIFICATION = {
  notificationType: 'TEST',
  notificationUUID: 'a5306c74-927c-44ae-8cd4-ff495a1be73b',
  data: { bundleId: 'com.gamestao.nivara', environment: 'Sandbox' },
};

/** Verifiers that mimic Apple's library: production throws `status`, sandbox accepts. */
function apiWith(status: VerificationStatus) {
  const tried: string[] = [];
  const client = {
    getTransactionInfo: async () => ({}),
    getTransactionHistory: async () => ({}),
    sendConsumptionData: async () => undefined,
  };
  const api = makeAppleServerApi({
    clients: { production: client, sandbox: client } as never,
    verifiers: {
      production: {
        verifyAndDecodeNotification: async () => {
          tried.push('production');
          throw new VerificationException(status);
        },
        verifyAndDecodeTransaction: async () => {
          throw new VerificationException(status);
        },
      },
      sandbox: {
        verifyAndDecodeNotification: async () => {
          tried.push('sandbox');
          return NOTIFICATION;
        },
        verifyAndDecodeTransaction: async () => {
          throw new Error('not used here');
        },
      },
    } as never,
  });
  return { api, tried };
}

describe('makeAppleServerApi: production → sandbox verifier fallback', () => {
  // The regression. Before the fix this returned null and the webhook answered Apple 200 'unverified'.
  it('retries against sandbox when production rejects on INVALID_APP_IDENTIFIER', async () => {
    const { api, tried } = apiWith(VerificationStatus.INVALID_APP_IDENTIFIER);
    const n = await api.verifyNotification('signed.payload.here');
    expect(n?.notificationType).toBe('TEST');
    expect(tried).toEqual(['production', 'sandbox']);
  });

  it('retries against sandbox on INVALID_ENVIRONMENT too', async () => {
    const { api, tried } = apiWith(VerificationStatus.INVALID_ENVIRONMENT);
    const n = await api.verifyNotification('signed.payload.here');
    expect(n?.notificationType).toBe('TEST');
    expect(tried).toEqual(['production', 'sandbox']);
  });

  // The other half of the contract: broadening the retry must not turn a forged payload into a
  // second chance. A signature failure is not an environment question, so sandbox is never asked.
  it.each([
    ['VERIFICATION_FAILURE', VerificationStatus.VERIFICATION_FAILURE],
    ['INVALID_CERTIFICATE', VerificationStatus.INVALID_CERTIFICATE],
    ['INVALID_CHAIN_LENGTH', VerificationStatus.INVALID_CHAIN_LENGTH],
  ])('fails closed on %s without asking sandbox', async (_name, status) => {
    const { api, tried } = apiWith(status);
    expect(await api.verifyNotification('signed.payload.here')).toBeNull();
    expect(tried).toEqual(['production']);
  });
});
