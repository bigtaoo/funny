// src/iap/appleServerApi.ts — the App Store Server API seam, below every fake the other Apple tests inject.
//
// This is the file `appleServerApi.ts:51` has been pointing at since it landed; until now it did not
// exist. `appleEnvFallback.test.ts` covers one half of one function here (the NOTIFICATION verifier's
// production→sandbox retry, written the day that retry shipped broken). The rest of the module — the
// two API calls the cold-start sync and /iap/verify are built on, the CLIENT-side environment
// fallback, and the transaction decoder both of them route through — had never been executed by any
// test in the repo.
//
// Why that matters more than a coverage number: the bug this module already shipped
// (INVALID_APP_IDENTIFIER, 2026-09-07) was not a wrong branch, it was a branch nobody could see was
// missing, because every other Apple test injects a fake `AppleServerApi` and a fake sits ABOVE the
// environment decision entirely. `withEnvFallback` is the same decision one layer over — "does Apple
// know this id, or did I just ask the wrong host" — and it fails the same way: silently, as "Apple has
// never heard of this transaction", i.e. a paying TestFlight/sandbox customer gets nothing and the
// server records no error at all.
//
// Two kinds of assertion here, and the split is deliberate:
//   • The decode is REAL. A throwaway ES256 key signs payloads that Apple's own `SignedDataVerifier`
//     accepts in `Environment.LOCAL_TESTING` (same technique as appleNotifications.e2e.test.ts, minus
//     the Mongo — nothing here touches a wallet). So the narrowing in `decodedPayloadToTransaction`
//     is checked against payloads Apple's library actually validated, not against our own idea of
//     their shape. What LOCAL_TESTING skips is the certificate chain, so nothing here claims a forged
//     payload is rejected — see appleRootCAs.test.ts for the roots that check is built on.
//   • The transport is FAKE, and its ERRORS are the subject. Apple's not-found and verification
//     failures are constructed as the real `APIException` / `VerificationException` types, because
//     `isNotFound` and `isWrongEnvironment` both start with an `instanceof` — a hand-rolled
//     `{ apiError }` object would pass every assertion below while proving nothing.
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import {
  APIError,
  APIException,
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type ConsumptionRequest,
} from '@apple/app-store-server-library';
import {
  createAppleServerApi,
  makeAppleServerApi,
  transactionIdFromReceipt,
  type AppleApiClientLike,
  type AppleVerifierLike,
} from '../src/iap/appleServerApi';

const BUNDLE = 'com.nw';
const APP_ID = 1234;

// ── Payloads Apple's verifier will accept in LOCAL_TESTING ────────────────────────────────────────
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const sign = (payload: object): string =>
  jwt.sign(JSON.stringify(payload), privateKey, { algorithm: 'ES256' });

function signedTx(over: Record<string, unknown> = {}): string {
  return sign({
    transactionId: 'tx-1',
    originalTransactionId: 'orig-1',
    bundleId: BUNDLE,
    productId: 'com.nw.coins.t099',
    purchaseDate: 1_700_000_000_000,
    type: 'Consumable',
    environment: 'LocalTesting',
    signedDate: 1_700_000_000_000,
    ...over,
  });
}

/** A real verifier, so every decode below runs Apple's own payload validation. */
const realVerifier = (): AppleVerifierLike =>
  new SignedDataVerifier([], false, Environment.LOCAL_TESTING, BUNDLE, APP_ID);

/**
 * A fake transport that answers per environment, recording which hosts were asked in order.
 *
 * `production`/`sandbox` are either a response to return or an error to throw. `asked` is what the
 * environment-fallback assertions are really about: "returned the right thing" is satisfiable by a
 * fallback that always asks both, which would double every call Apple rate-limits.
 */
function clientsWith(opts: {
  production: unknown;
  sandbox?: unknown;
}): { clients: { production: AppleApiClientLike; sandbox: AppleApiClientLike }; asked: string[] } {
  const asked: string[] = [];
  const make = (env: 'production' | 'sandbox', answer: unknown): AppleApiClientLike => {
    const respond = async () => {
      asked.push(env);
      if (answer instanceof Error) throw answer;
      return answer as never;
    };
    return {
      getTransactionInfo: respond,
      getTransactionHistory: respond,
      sendConsumptionInformation: respond,
    };
  };
  return {
    clients: {
      production: make('production', opts.production),
      sandbox: make('sandbox', opts.sandbox ?? new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND)),
    },
    asked,
  };
}

/** The module under test, with a real decoder and the given transport. */
function apiWith(opts: { production: unknown; sandbox?: unknown }) {
  const { clients, asked } = clientsWith(opts);
  const verifier = realVerifier();
  return {
    api: makeAppleServerApi({ clients, verifiers: { production: verifier, sandbox: verifier } }),
    asked,
  };
}

const notFound = () => new APIException(404, APIError.TRANSACTION_ID_NOT_FOUND);
const origNotFound = () => new APIException(404, APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND);

describe('verifyTransaction', () => {
  it('narrows a production transaction to the fields a grant depends on', async () => {
    const { api, asked } = apiWith({ production: { signedTransactionInfo: signedTx() } });
    expect(await api.verifyTransaction('tx-1')).toEqual({
      transactionId: 'tx-1',
      originalTransactionId: 'orig-1',
      productId: 'com.nw.coins.t099',
      purchasedMs: 1_700_000_000_000,
      appAccountToken: undefined,
      appTransactionId: undefined,
      revoked: false,
    });
    // Production only: sandbox is a second round trip against a rate-limited API, and in production
    // it is the call that never needs to happen.
    expect(asked).toEqual(['production']);
  });

  it('carries appAccountToken and appTransactionId through when Apple sends them', async () => {
    // appAccountToken is how a StoreKit 2 purchase names OUR account (appleAccountTokens); dropping
    // it here makes every later renewal notification for that subscription unroutable, permanently.
    const { api } = apiWith({
      production: {
        signedTransactionInfo: signedTx({
          appAccountToken: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
          appTransactionId: 'apptx-9',
        }),
      },
    });
    const tx = await api.verifyTransaction('tx-1');
    expect(tx?.appAccountToken).toBe('6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(tx?.appTransactionId).toBe('apptx-9');
  });

  it('reports a revoked transaction as revoked, so no period is granted for it', async () => {
    const { api } = apiWith({
      production: { signedTransactionInfo: signedTx({ revocationDate: 1_700_000_500_000 }) },
    });
    expect((await api.verifyTransaction('tx-1'))?.revoked).toBe(true);
  });

  // The TestFlight / sandbox-tester case. A sandbox transaction does not exist in production at all,
  // so this fallback is the whole reason no deployment flag decides which host to ask.
  it('retries sandbox when production has never heard of the id', async () => {
    const { api, asked } = apiWith({
      production: notFound(),
      sandbox: { signedTransactionInfo: signedTx({ environment: 'LocalTesting' }) },
    });
    expect((await api.verifyTransaction('tx-1'))?.transactionId).toBe('tx-1');
    expect(asked).toEqual(['production', 'sandbox']);
  });

  it('retries sandbox on ORIGINAL_TRANSACTION_ID_NOT_FOUND too', async () => {
    const { api, asked } = apiWith({
      production: origNotFound(),
      sandbox: { signedTransactionInfo: signedTx() },
    });
    expect(await api.verifyTransaction('tx-1')).not.toBeNull();
    expect(asked).toEqual(['production', 'sandbox']);
  });

  it('is null when neither environment knows the id', async () => {
    const { api, asked } = apiWith({ production: notFound(), sandbox: notFound() });
    expect(await api.verifyTransaction('tx-1')).toBeNull();
    expect(asked).toEqual(['production', 'sandbox']);
  });

  // The important half of the fallback's contract. "Our credentials are wrong" and "Apple is down"
  // must NOT collapse into the same null as "no such transaction": null means "there was no
  // purchase", and a caller that grants nothing on it is right, while a caller that grants nothing
  // on an expired signing key has silently stopped honouring real purchases.
  it.each([
    ['unauthenticated (bad In-App Purchase Key)', new APIException(401)],
    ['rate limited', new APIException(429, APIError.RATE_LIMIT_EXCEEDED)],
    ['a plain transport failure', new Error('ECONNRESET')],
  ])('rethrows %s instead of reporting "no such transaction"', async (_name, err) => {
    const { api, asked } = apiWith({ production: err });
    await expect(api.verifyTransaction('tx-1')).rejects.toThrow();
    expect(asked).toEqual(['production']); // and does not ask sandbox — the other host has the same key
  });

  it('rethrows a real failure the SANDBOX host reports, after production said not-found', async () => {
    // The asymmetric half of the retry: production genuinely does not know a sandbox id, so the
    // second call is the only one whose answer means anything — and if THAT one fails for a real
    // reason, swallowing it to null would report "this TestFlight tester never bought anything".
    const { api, asked } = apiWith({ production: notFound(), sandbox: new APIException(401) });
    await expect(api.verifyTransaction('tx-1')).rejects.toThrow(APIException);
    expect(asked).toEqual(['production', 'sandbox']);
  });

  it('is null when Apple answers without a signedTransactionInfo', async () => {
    const { api } = apiWith({ production: {} });
    expect(await api.verifyTransaction('tx-1')).toBeNull();
  });

  // decodedPayloadToTransaction's guard. Apple's decoded payload types make every field optional, so
  // this is the difference between "no transaction" and a grant keyed on `undefined`.
  it.each(['transactionId', 'originalTransactionId', 'productId'])(
    'is null when the decoded payload has no %s',
    async (field) => {
      const { api } = apiWith({
        production: { signedTransactionInfo: signedTx({ [field]: undefined }) },
      });
      expect(await api.verifyTransaction('tx-1')).toBeNull();
    },
  );

  it('reads a payload with no purchaseDate as epoch rather than NaN', async () => {
    const { api } = apiWith({
      production: { signedTransactionInfo: signedTx({ purchaseDate: undefined }) },
    });
    expect((await api.verifyTransaction('tx-1'))?.purchasedMs).toBe(0);
  });
});

describe('transactionHistory', () => {
  it('decodes every page entry, in Apple newest-first order', async () => {
    // Ordering is asserted because the module documents that it deliberately does NOT normalise it —
    // a caller that needs oldest-first sorts for itself. If this ever silently started sorting, the
    // comment promising otherwise would be the only thing left saying so.
    const { api } = apiWith({
      production: {
        signedTransactions: [
          signedTx({ transactionId: 'tx-3', purchaseDate: 3_000 }),
          signedTx({ transactionId: 'tx-2', purchaseDate: 2_000 }),
          signedTx({ transactionId: 'tx-1', purchaseDate: 1_000 }),
        ],
      },
    });
    expect((await api.transactionHistory('tx-1')).map((t) => t.transactionId)).toEqual([
      'tx-3',
      'tx-2',
      'tx-1',
    ]);
  });

  it('drops the entries it cannot decode and keeps the rest', async () => {
    // One unreadable period must not cost the player every other period in the same history — this is
    // the call the cold-start sync backfills missed renewals from.
    const { api } = apiWith({
      production: {
        signedTransactions: [signedTx({ transactionId: 'tx-2' }), 'not.a.jws', signedTx({ transactionId: 'tx-1' })],
      },
    });
    expect((await api.transactionHistory('orig-1')).map((t) => t.transactionId)).toEqual(['tx-2', 'tx-1']);
  });

  it('is empty when Apple returns no transactions', async () => {
    const { api } = apiWith({ production: {} });
    expect(await api.transactionHistory('orig-1')).toEqual([]);
  });

  it('is empty — not a throw — when neither environment knows the id', async () => {
    const { api, asked } = apiWith({ production: origNotFound(), sandbox: origNotFound() });
    expect(await api.transactionHistory('orig-1')).toEqual([]);
    expect(asked).toEqual(['production', 'sandbox']);
  });

  it('retries sandbox for a sandbox subscription', async () => {
    const { api, asked } = apiWith({
      production: origNotFound(),
      sandbox: { signedTransactions: [signedTx({ transactionId: 'tx-7' })] },
    });
    expect((await api.transactionHistory('orig-1')).map((t) => t.transactionId)).toEqual(['tx-7']);
    expect(asked).toEqual(['production', 'sandbox']);
  });
});

describe('decodeTransaction: the verifier fallback under the API calls', () => {
  /** Verifiers that mimic Apple's library: production throws `status`, sandbox decodes. */
  function verifiersWith(status: VerificationStatus) {
    const tried: string[] = [];
    const sandbox = realVerifier();
    const verifiers = {
      production: {
        verifyAndDecodeTransaction: async () => {
          tried.push('production');
          throw new VerificationException(status);
        },
        verifyAndDecodeNotification: async () => {
          throw new VerificationException(status);
        },
      } as AppleVerifierLike,
      sandbox: {
        verifyAndDecodeTransaction: async (signed: string) => {
          tried.push('sandbox');
          return sandbox.verifyAndDecodeTransaction(signed);
        },
        verifyAndDecodeNotification: sandbox.verifyAndDecodeNotification.bind(sandbox),
      } as AppleVerifierLike,
    };
    return { verifiers, tried };
  }

  function apiWithVerifiers(status: VerificationStatus, response: unknown) {
    const { clients, asked } = clientsWith({ production: response });
    const { verifiers, tried } = verifiersWith(status);
    return { api: makeAppleServerApi({ clients, verifiers }), tried, asked };
  }

  // The same regression appleEnvFallback.test.ts pins for notifications, on the transaction path:
  // /iap/verify and the cold-start sync both decode through here, and a sandbox payload is rejected
  // by the production verifier on the APP IDENTIFIER (status 3) rather than the environment (4),
  // because the production verifier is the only one built with appAppleId.
  it('decodes a sandbox transaction after production rejects on INVALID_APP_IDENTIFIER', async () => {
    const { api, tried } = apiWithVerifiers(VerificationStatus.INVALID_APP_IDENTIFIER, {
      signedTransactionInfo: signedTx(),
    });
    expect((await api.verifyTransaction('tx-1'))?.transactionId).toBe('tx-1');
    expect(tried).toEqual(['production', 'sandbox']);
  });

  it('decodes a sandbox transaction on INVALID_ENVIRONMENT too', async () => {
    const { api, tried } = apiWithVerifiers(VerificationStatus.INVALID_ENVIRONMENT, {
      signedTransactionInfo: signedTx(),
    });
    expect(await api.verifyTransaction('tx-1')).not.toBeNull();
    expect(tried).toEqual(['production', 'sandbox']);
  });

  // The other half: broadening the retry must not turn a signature failure into a second chance.
  // verifyTransaction has no catch, so this surfaces as a rejection — deliberately, because the
  // caller must not read "this payload is not trustworthy" as "this player did not buy anything".
  it.each([
    ['VERIFICATION_FAILURE', VerificationStatus.VERIFICATION_FAILURE],
    ['INVALID_CERTIFICATE', VerificationStatus.INVALID_CERTIFICATE],
  ])('rejects on %s without asking the sandbox verifier', async (_name, status) => {
    const { api, tried } = apiWithVerifiers(status, { signedTransactionInfo: signedTx() });
    await expect(api.verifyTransaction('tx-1')).rejects.toThrow(VerificationException);
    expect(tried).toEqual(['production']);
  });

  it('does not treat a non-verification error as an environment question', async () => {
    // `isWrongEnvironment` starts with an instanceof for this reason: an out-of-memory, a bug in
    // Apple's library, or anything else that is not a VerificationException says nothing about which
    // environment the payload belongs to, and retrying the other host would just fail twice.
    const { clients } = clientsWith({ production: { signedTransactionInfo: signedTx() } });
    const tried: string[] = [];
    const boom = (env: string): AppleVerifierLike => ({
      verifyAndDecodeTransaction: async () => {
        tried.push(env);
        throw new TypeError('cannot read properties of undefined');
      },
      verifyAndDecodeNotification: async () => {
        throw new TypeError('cannot read properties of undefined');
      },
    });
    const api = makeAppleServerApi({
      clients,
      verifiers: { production: boom('production'), sandbox: boom('sandbox') },
    });
    await expect(api.verifyTransaction('tx-1')).rejects.toThrow(TypeError);
    expect(tried).toEqual(['production']);
  });

  it('a history entry that fails verification is dropped, not fatal to the page', async () => {
    // transactionHistory catches per entry where verifyTransaction does not: one bad period out of
    // twenty must not cost the other nineteen.
    const { clients } = clientsWith({
      production: { signedTransactions: [signedTx(), signedTx({ transactionId: 'tx-2' })] },
    });
    const reject: AppleVerifierLike = {
      verifyAndDecodeTransaction: async () => {
        throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE);
      },
      verifyAndDecodeNotification: async () => {
        throw new VerificationException(VerificationStatus.VERIFICATION_FAILURE);
      },
    };
    const api = makeAppleServerApi({ clients, verifiers: { production: reject, sandbox: reject } });
    expect(await api.transactionHistory('orig-1')).toEqual([]);
  });
});

// The production→sandbox NOTIFICATION retry, and which statuses do or do not earn it, belong to
// appleEnvFallback.test.ts — that file exists because that exact decision shipped broken. What is
// left here is the narrowing that happens after a successful decode, and the case where the retry
// itself runs out of hosts.
describe('verifyNotification', () => {
  function signedNotification(over: Record<string, unknown> = {}): string {
    return sign({
      notificationType: 'CONSUMPTION_REQUEST',
      subtype: 'UPGRADE',
      notificationUUID: 'a5306c74-927c-44ae-8cd4-ff495a1be73b',
      version: '2.0',
      signedDate: 1_700_000_000_000,
      data: {
        environment: 'LocalTesting',
        bundleId: BUNDLE,
        consumptionRequestReason: 'UNINTENDED_PURCHASE',
        signedTransactionInfo: signedTx(),
      },
      ...over,
    });
  }

  it('narrows a notification to the fields the webhook routes on', async () => {
    const { api } = apiWith({ production: {} });
    expect(await api.verifyNotification(signedNotification())).toEqual({
      notificationType: 'CONSUMPTION_REQUEST',
      subtype: 'UPGRADE',
      notificationUUID: 'a5306c74-927c-44ae-8cd4-ff495a1be73b',
      // The refund reason arrived with notifications v2.11; it is the one field of the consumption
      // answer that comes from Apple rather than from our own ledger.
      consumptionRequestReason: 'UNINTENDED_PURCHASE',
      transaction: {
        transactionId: 'tx-1',
        originalTransactionId: 'orig-1',
        productId: 'com.nw.coins.t099',
        purchasedMs: 1_700_000_000_000,
        appAccountToken: undefined,
        appTransactionId: undefined,
        revoked: false,
      },
    });
  });

  it('is null when both verifiers reject the payload', async () => {
    // Neither host will take it — forged, or signed for a different app. Fails closed with no
    // notificationUUID to log, which is why the webhook has nothing to record for this case.
    const reject = (): AppleVerifierLike => ({
      verifyAndDecodeTransaction: async () => {
        throw new VerificationException(VerificationStatus.INVALID_APP_IDENTIFIER);
      },
      verifyAndDecodeNotification: async () => {
        throw new VerificationException(VerificationStatus.INVALID_APP_IDENTIFIER);
      },
    });
    const { clients } = clientsWith({ production: {} });
    const api = makeAppleServerApi({
      clients,
      verifiers: { production: reject(), sandbox: reject() },
    });
    expect(await api.verifyNotification('signed.payload.here')).toBeNull();
  });

  it.each(['notificationType', 'notificationUUID'])(
    'is null when the decoded payload carries no %s',
    async (field) => {
      // Not shaped like a notification at all. Both fields are load-bearing downstream: the type
      // decides whether anything is granted, and the UUID is the idempotency key of the log row.
      const { api } = apiWith({ production: {} });
      expect(await api.verifyNotification(signedNotification({ [field]: undefined }))).toBeNull();
    },
  );

  it('reports a notification whose transaction fails to decode as one with no transaction', async () => {
    // 'unlinked'/'ignored' territory rather than a throw: the webhook still gets to record the event.
    const { api } = apiWith({ production: {} });
    const n = await api.verifyNotification(
      sign({
        notificationType: 'DID_RENEW',
        notificationUUID: 'uuid-1',
        version: '2.0',
        signedDate: 1_700_000_000_000,
        data: { environment: 'LocalTesting', bundleId: BUNDLE, signedTransactionInfo: 'not.a.jws' },
      }),
    );
    expect(n?.notificationType).toBe('DID_RENEW');
    expect(n?.transaction).toBeUndefined();
  });
});

describe('sendConsumption', () => {
  const REQUEST: ConsumptionRequest = {
    customerConsented: true,
    consumptionStatus: undefined,
    deliveryStatus: 'DELIVERED',
    sampleContentProvided: false,
  } as unknown as ConsumptionRequest;

  it('posts to production and stops there', async () => {
    const { api, asked } = apiWith({ production: undefined });
    await api.sendConsumption('tx-1', REQUEST);
    expect(asked).toEqual(['production']);
  });

  it('retries sandbox for a sandbox transaction', async () => {
    // A refund request from a sandbox tester is how this path gets exercised before release at all.
    const { api, asked } = apiWith({ production: notFound(), sandbox: undefined });
    await api.sendConsumption('tx-1', REQUEST);
    expect(asked).toEqual(['production', 'sandbox']);
  });

  it('resolves quietly when neither environment knows the transaction', async () => {
    const { api } = apiWith({ production: notFound(), sandbox: notFound() });
    await expect(api.sendConsumption('tx-1', REQUEST)).resolves.toBeUndefined();
  });

  it('rejects on a real failure, leaving the caller to decide it was best-effort', async () => {
    const { api } = apiWith({ production: new APIException(500) });
    await expect(api.sendConsumption('tx-1', REQUEST)).rejects.toThrow();
  });
});

describe('createAppleServerApi', () => {
  const ENV_KEYS = [
    'NW_APPLE_IAP_KEY_ID',
    'NW_APPLE_IAP_ISSUER_ID',
    'NW_APPLE_IAP_PRIVATE_KEY_BASE64',
    'NW_IAP_BUNDLE',
    'NW_APPLE_APP_ID',
  ] as const;

  // A real EC key, base64'd exactly the way IAP_CREDENTIALS.md §1 says the .p8 is carried — this is
  // what proves the base64→PEM step, which is the one link a .env file or compose interpolation can
  // break without anyone noticing until Apple rejects the JWT.
  const { privateKey: p8 } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const FULL: Record<string, string> = {
    NW_APPLE_IAP_KEY_ID: 'ABCD1234EF',
    NW_APPLE_IAP_ISSUER_ID: '57246542-96fe-1a63-e053-0824d011072a',
    NW_APPLE_IAP_PRIVATE_KEY_BASE64: Buffer.from(p8.toString(), 'utf8').toString('base64'),
    NW_IAP_BUNDLE: BUNDLE,
    NW_APPLE_APP_ID: String(APP_ID),
  };

  const saved = new Map<string, string | undefined>();
  function setEnv(vars: Record<string, string | undefined>): void {
    for (const k of ENV_KEYS) {
      if (!saved.has(k)) saved.set(k, process.env[k]);
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it('builds a working API from a full configuration', () => {
    setEnv(FULL);
    // Apple's client and verifier both validate their arguments in the constructor, so "did not
    // throw" here is the assertion that the five values are shaped the way Apple wants them.
    expect(createAppleServerApi()).not.toBeNull();
  });

  // Fail CLOSED, one variable at a time: a half-configured deployment must behave exactly like an
  // unconfigured one (nothing granted), never like a configured one that trusts everything.
  it.each(ENV_KEYS)('is null when %s is missing', (missing) => {
    setEnv({ ...FULL, [missing]: undefined });
    expect(createAppleServerApi()).toBeNull();
  });

  it.each(['', 'not-a-number', '0', '-1'])(
    'is null when NW_APPLE_APP_ID is %j — the verifier cannot confirm the app without it',
    (appId) => {
      setEnv({ ...FULL, NW_APPLE_APP_ID: appId });
      expect(createAppleServerApi()).toBeNull();
    },
  );
});

describe('transactionIdFromReceipt', () => {
  it.each([
    ['empty', ''],
    ['not base64 at all', 'hello world'],
    ['base64 of something that is not a receipt', Buffer.from('nope').toString('base64')],
  ])('is null for %s rather than throwing', (_name, receipt) => {
    // The StoreKit 1 bridge off verifyReceipt: this input arrives straight from a client, so the only
    // acceptable answer to garbage is null — a throw here would 500 the verify endpoint.
    expect(transactionIdFromReceipt(receipt)).toBeNull();
  });
});
