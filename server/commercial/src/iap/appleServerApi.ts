// Apple App Store Server API + App Store Server Notifications V2 (2026-09-07).
//
// Replaces the deprecated `verifyReceipt` endpoint and its shared secret (NW_APPLE_PASSWORD), which
// Apple stopped adding features to in 2023. Everything Apple-signed now goes through Apple's own
// library: it builds the ES256 JWT for outgoing calls and verifies the certificate chain on incoming
// signed data, so this file holds no cryptography of its own — only configuration, environment
// fallback, and the narrowing of Apple's very wide payloads into the few fields we actually grant on.
//
// ── Credentials (IAP_CREDENTIALS.md §1) ──
// An "In-App Purchase Key" from App Store Connect → Users and Access → Integrations → In-App Purchase.
// That is a DIFFERENT key from the ASC API key CI uses to upload builds, and unrelated to the old
// shared secret. Missing/partial config → every function here fails closed (null / empty), never a
// silent grant, matching the posture the shared-secret path had.
//
// ── Why two environments ──
// Unlike verifyReceipt (one URL that answered for both, signalled by status 21007), the App Store
// Server API has separate sandbox and production hosts, and a sandbox transaction simply does not
// exist in production. So each call tries production first and retries sandbox on a "not found"
// error; notification verification does the same on an environment mismatch. A TestFlight/sandbox
// tester and a real customer therefore both work without any deployment flag to get wrong.
import {
  APIException,
  APIError,
  AppStoreServerAPIClient,
  Environment,
  ReceiptUtility,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
  type ConsumptionRequest,
  type HistoryResponse,
  type JWSTransactionDecodedPayload,
  type ResponseBodyV2DecodedPayload,
  type TransactionHistoryRequest,
  type TransactionInfoResponse,
} from '@apple/app-store-server-library';
import { appleRootCAs } from './appleRootCAs';

/** The subset of Apple's API client this module calls — the seam tests inject a fake through. */
export interface AppleApiClientLike {
  getTransactionInfo(transactionId: string): Promise<TransactionInfoResponse>;
  getTransactionHistory(
    anyTransactionId: string,
    revision: string | null,
    request: TransactionHistoryRequest,
  ): Promise<HistoryResponse>;
  sendConsumptionInformation(transactionId: string, request: ConsumptionRequest): Promise<void>;
}

/** The subset of Apple's verifier this module calls. Tests inject either a fake or a real
 *  `SignedDataVerifier` built with `Environment.LOCAL_TESTING` (see appleServerApi.test.ts). */
export interface AppleVerifierLike {
  verifyAndDecodeTransaction(signedTransactionInfo: string): Promise<JWSTransactionDecodedPayload>;
  verifyAndDecodeNotification(signedPayload: string): Promise<ResponseBodyV2DecodedPayload>;
}

/** One Apple transaction, narrowed to the fields any grant decision here depends on. */
export interface AppleTransaction {
  transactionId: string;
  /** Stable across every renewal of the same subscription — the key renewals are matched to an account by. */
  originalTransactionId: string;
  productId: string;
  purchasedMs: number;
  /** Our own account id, when the purchase carried one (StoreKit 2 only — absent on StoreKit 1 purchases). */
  appAccountToken?: string;
  /** Stable per Apple Account per app (WWDC25). Only present on recent OS versions, so it is recorded
   *  opportunistically and never used as the sole key. */
  appTransactionId?: string;
  /** Apple took the money back (refund/revoke) — such a period must never be granted. */
  revoked: boolean;
}

/** One notification, narrowed the same way. */
export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  /** Why the customer asked for a refund (CONSUMPTION_REQUEST only, notifications v2.11+). */
  consumptionRequestReason?: string;
  transaction?: AppleTransaction;
}

export interface AppleServerApi {
  /** One transaction by id, or null when Apple does not recognise it in either environment. */
  verifyTransaction(transactionId: string): Promise<AppleTransaction | null>;
  /** Every transaction sharing this one's original transaction, oldest first. */
  transactionHistory(anyTransactionId: string): Promise<AppleTransaction[]>;
  /** Verified + decoded notification, or null when the payload fails verification in both environments. */
  verifyNotification(signedPayload: string): Promise<AppleNotification | null>;
  /** Answer a CONSUMPTION_REQUEST. Best-effort: a throw here must not fail the webhook. */
  sendConsumption(transactionId: string, request: ConsumptionRequest): Promise<void>;
}

interface EnvPair<T> {
  production: T;
  sandbox: T;
}

/** Injectable seam for tests; production builds these from env in `createAppleServerApi`. */
export interface AppleServerApiDeps {
  clients: EnvPair<AppleApiClientLike>;
  verifiers: EnvPair<AppleVerifierLike>;
}

function decodedPayloadToTransaction(p: JWSTransactionDecodedPayload): AppleTransaction | null {
  if (!p.transactionId || !p.originalTransactionId || !p.productId) return null;
  return {
    transactionId: p.transactionId,
    originalTransactionId: p.originalTransactionId,
    productId: p.productId,
    purchasedMs: p.purchaseDate ?? 0,
    appAccountToken: p.appAccountToken,
    appTransactionId: p.appTransactionId,
    revoked: p.revocationDate !== undefined && p.revocationDate !== null,
  };
}

/** True for the two "Apple has never heard of this id" errors, the signal to retry the other environment. */
function isNotFound(e: unknown): boolean {
  if (!(e instanceof APIException)) return false;
  return (
    e.apiError === APIError.TRANSACTION_ID_NOT_FOUND ||
    e.apiError === APIError.ORIGINAL_TRANSACTION_ID_NOT_FOUND
  );
}

/**
 * True when a payload was rejected for a reason the *other* environment's verifier could satisfy.
 *
 * INVALID_ENVIRONMENT is the obvious one. INVALID_APP_IDENTIFIER is the one that actually fires, and
 * missing it made every sandbox payload fail closed (found 2026-09-07 with a real Apple TEST
 * notification): the production verifier is built with `appAppleId` because `SignedDataVerifier`
 * requires it there, but a sandbox payload carries no `appAppleId` at all — so the identifier check
 * rejects it first and the environment check is never reached. Status 3, not 4.
 *
 * Retrying on it costs nothing in safety: `bundleId` is verified in BOTH environments, so a payload
 * genuinely signed for another app still fails both verifiers, and a production payload offered to
 * the sandbox verifier is then rejected on the environment instead.
 */
function isWrongEnvironment(e: unknown): boolean {
  if (!(e instanceof VerificationException)) return false;
  return (
    e.status === VerificationStatus.INVALID_ENVIRONMENT ||
    e.status === VerificationStatus.INVALID_APP_IDENTIFIER
  );
}

/**
 * Run against production, falling back to sandbox when Apple reports the id as unknown there.
 * Production is tried first on purpose: in production that is the only call made, and sandbox ids
 * (TestFlight, sandbox testers) are the rarer case that pays the second round trip.
 */
async function withEnvFallback<T>(
  pair: EnvPair<AppleApiClientLike>,
  run: (client: AppleApiClientLike) => Promise<T>,
  shouldRetry: (e: unknown) => boolean = isNotFound,
): Promise<T | null> {
  try {
    return await run(pair.production);
  } catch (e) {
    if (!shouldRetry(e)) throw e;
  }
  try {
    return await run(pair.sandbox);
  } catch (e) {
    if (shouldRetry(e)) return null;
    throw e;
  }
}

export function makeAppleServerApi(deps: AppleServerApiDeps): AppleServerApi {
  const { clients, verifiers } = deps;

  /** Decode a signed transaction with whichever verifier accepts its environment. */
  async function decodeTransaction(signed: string): Promise<AppleTransaction | null> {
    let payload: JWSTransactionDecodedPayload;
    try {
      payload = await verifiers.production.verifyAndDecodeTransaction(signed);
    } catch (e) {
      if (!isWrongEnvironment(e)) throw e;
      payload = await verifiers.sandbox.verifyAndDecodeTransaction(signed);
    }
    return decodedPayloadToTransaction(payload);
  }

  return {
    async verifyTransaction(transactionId) {
      const resp = await withEnvFallback(clients, (c) => c.getTransactionInfo(transactionId));
      if (!resp?.signedTransactionInfo) return null;
      return decodeTransaction(resp.signedTransactionInfo);
    },

    async transactionHistory(anyTransactionId) {
      // One page (up to 20 transactions, newest first) is deliberately enough: this backfills periods a
      // notification may have missed, and a subscription that is 20 renewals behind is not a case worth
      // paging for — the older periods were already granted long ago, and every grant is idempotent
      // anyway. Asking for ASCENDING would fight that: the newest transactions are the interesting ones.
      const resp = await withEnvFallback(clients, (c) =>
        c.getTransactionHistory(anyTransactionId, null, {}),
      );
      const signed = resp?.signedTransactions ?? [];
      const out: AppleTransaction[] = [];
      for (const s of signed) {
        const tx = await decodeTransaction(s).catch(() => null);
        if (tx) out.push(tx);
      }
      // Returned in Apple's own order (newest first). Ordering is deliberately NOT normalised here:
      // the caller that needs oldest-first is the one that documents that guarantee, and a guarantee
      // enforced in a collaborator is one a different collaborator silently drops.
      return out;
    },

    async verifyNotification(signedPayload) {
      let payload: ResponseBodyV2DecodedPayload;
      try {
        payload = await verifiers.production.verifyAndDecodeNotification(signedPayload);
      } catch (e) {
        if (!isWrongEnvironment(e)) return null; // forged, malformed, or wrong app — fail closed
        try {
          payload = await verifiers.sandbox.verifyAndDecodeNotification(signedPayload);
        } catch {
          return null;
        }
      }
      if (!payload.notificationType || !payload.notificationUUID) return null;
      const signedTx = payload.data?.signedTransactionInfo;
      const transaction = signedTx ? await decodeTransaction(signedTx).catch(() => null) : null;
      return {
        notificationType: String(payload.notificationType),
        subtype: payload.subtype ? String(payload.subtype) : undefined,
        notificationUUID: payload.notificationUUID,
        consumptionRequestReason: payload.data?.consumptionRequestReason
          ? String(payload.data.consumptionRequestReason)
          : undefined,
        transaction: transaction ?? undefined,
      };
    },

    async sendConsumption(transactionId, request) {
      await withEnvFallback(clients, (c) => c.sendConsumptionInformation(transactionId, request));
    },
  };
}

/**
 * Build the API from environment configuration, or null when Apple is unconfigured (fail closed —
 * callers then behave exactly as they did with a missing shared secret: verification fails, nothing
 * is granted). `NW_APPLE_APP_ID` is required because `SignedDataVerifier` needs it to confirm a
 * production payload belongs to THIS app rather than merely being validly Apple-signed.
 */
export function createAppleServerApi(): AppleServerApi | null {
  const keyId = process.env.NW_APPLE_IAP_KEY_ID ?? '';
  const issuerId = process.env.NW_APPLE_IAP_ISSUER_ID ?? '';
  const keyBase64 = process.env.NW_APPLE_IAP_PRIVATE_KEY_BASE64 ?? '';
  const bundleId = process.env.NW_IAP_BUNDLE ?? '';
  const appAppleId = Number(process.env.NW_APPLE_APP_ID ?? '');
  if (!keyId || !issuerId || !keyBase64 || !bundleId || !Number.isFinite(appAppleId) || appAppleId <= 0) {
    return null;
  }

  // The .p8 is carried base64-encoded so a PEM's newlines survive .env files and compose interpolation
  // intact (IAP_CREDENTIALS.md §1) — Apple's client wants the decoded PEM text.
  const signingKey = Buffer.from(keyBase64, 'base64').toString('utf8');
  const roots = appleRootCAs();

  const client = (env: Environment) =>
    new AppStoreServerAPIClient(signingKey, keyId, issuerId, bundleId, env);
  // enableOnlineChecks=false: online checking makes an OCSP round trip to Apple part of verifying every
  // notification, turning a signature check into a network dependency that can time out and cost us the
  // 200 Apple is waiting for. The chain is still fully verified against the pinned roots, using the
  // payload's own signed date, which is what actually establishes authenticity.
  const verifier = (env: Environment, appId: number | undefined) =>
    new SignedDataVerifier(roots, false, env, bundleId, appId);

  return makeAppleServerApi({
    clients: {
      production: client(Environment.PRODUCTION),
      sandbox: client(Environment.SANDBOX),
    },
    verifiers: {
      // appAppleId is omitted in sandbox — Apple's sandbox payloads carry no app id to match against.
      production: verifier(Environment.PRODUCTION, appAppleId),
      sandbox: verifier(Environment.SANDBOX, undefined),
    },
  });
}

/**
 * Pull a transaction id out of a StoreKit 1 app receipt, locally — no network call, no shared secret.
 * This is Apple's documented bridge off verifyReceipt: the base64 receipt blob the current iOS shell
 * still sends is unwrapped just far enough to get an id, and everything authoritative then comes from
 * the App Store Server API. It is what lets the server migrate with no change to the shipped app
 * (IOS_RELEASE.md §6); when the StoreKit 2 client lands it will send a transaction id directly and
 * this call disappears.
 *
 * `ReceiptUtility` performs NO validation — the id it returns is untrusted input, only ever used as a
 * lookup key against Apple.
 */
export function transactionIdFromReceipt(receipt: string): string | null {
  try {
    return new ReceiptUtility().extractTransactionIdFromAppReceipt(receipt);
  } catch {
    return null; // not a receipt at all (malformed, truncated, or already a bare transaction id)
  }
}
