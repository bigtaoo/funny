// src/iap/appleRootCAs.ts — the three pinned Apple roots every Apple signature chains to.
//
// `appleRootCAs()` had never been called by any test in this repo. That is the worst possible file to
// leave unexercised, because a wrong byte in it cannot be seen from anywhere else in the system:
// `SignedDataVerifier` would still construct, every notification would still arrive, and every one of
// them would fail verification with INVALID_CERTIFICATE — which the webhook answers 200 to on
// purpose (a bad payload does not get better on redelivery). So the whole iOS subscription channel
// stops working while Apple records every delivery as a success and nothing turns red.
//
// The file's own provenance comment already anticipates this: it records the SHA-256 fingerprints
// "so a future update can be audited rather than trusted". These cases are that audit, run every
// time — the same `openssl x509 -sha256 -fingerprint` values, checked mechanically. A future
// certificate rotation must update the fingerprint here in the same commit as the blob, which is the
// point: the diff then says which certificate changed, instead of showing 2 KB of base64 nobody can
// read.
//
// Nothing here talks to Apple, and nothing here proves the chain check itself works — that is Apple's
// code, driven for real (minus the chain) in appleNotifications.e2e.test.ts. This proves only that we
// hand it the certificates we think we do.
import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { appleRootCAs } from '../src/iap/appleRootCAs';

/**
 * The three roots, in the order `appleRootCAs()` returns them, with the identity recorded in that
 * file's doc comments. Kept as data rather than folded into a loop over the certificates so a
 * reordering, a duplicate, or a dropped entry fails too — not just a corrupted one.
 */
const EXPECTED = [
  {
    name: 'Apple Root CA',
    subjectCN: 'Apple Root CA',
    fingerprint256:
      'B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24',
    expires: '2035-02-09',
  },
  {
    name: 'Apple Root CA - G2',
    subjectCN: 'Apple Root CA - G2',
    fingerprint256:
      'C2:B9:B0:42:DD:57:83:0E:7D:11:7D:AC:55:AC:8A:E1:94:07:D3:8E:41:D8:8F:32:15:BC:3A:89:04:44:A0:50',
    expires: '2039-04-30',
  },
  {
    // The one App Store JWS signatures actually chain to. The other two are kept so a chain rooted
    // elsewhere in Apple's PKI still verifies rather than failing closed on a technicality.
    name: 'Apple Root CA - G3',
    subjectCN: 'Apple Root CA - G3',
    fingerprint256:
      '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79',
    expires: '2039-04-30',
  },
] as const;

const roots = appleRootCAs();

describe('appleRootCAs', () => {
  it('returns exactly the three roots, as DER buffers', () => {
    expect(roots).toHaveLength(EXPECTED.length);
    // DER, not PEM: Apple's verifier takes the raw bytes, and a base64 blob that decoded to PEM text
    // would parse as a certificate here yet be rejected there.
    for (const der of roots) {
      expect(Buffer.isBuffer(der)).toBe(true);
      expect(der.length).toBeGreaterThan(500);
      expect(der[0]).toBe(0x30); // ASN.1 SEQUENCE — the first byte of every DER certificate
    }
  });

  describe.each(EXPECTED.map((e, i) => [e.name, i, e] as const))('%s', (_name, index, expected) => {
    const cert = new X509Certificate(roots[index]!);

    it('matches the recorded SHA-256 fingerprint', () => {
      // The load-bearing assertion. This is the value `openssl x509 -inform DER -noout -sha256
      // -fingerprint` printed when the certificate was downloaded from Apple's PKI site.
      expect(cert.fingerprint256).toBe(expected.fingerprint256);
    });

    it('is issued by Apple to itself (a root, not an intermediate)', () => {
      expect(cert.subject).toContain(`CN=${expected.subjectCN}`);
      expect(cert.subject).toContain('O=Apple Inc.');
      // Self-issued is what makes it usable as a trust anchor at all; an intermediate pasted in by
      // mistake would look plausible in every other respect.
      expect(cert.issuer).toBe(cert.subject);
      expect(cert.ca).toBe(true);
    });

    it('has not expired, and is the generation whose expiry was recorded', () => {
      // Apple's expired "Apple Computer, Inc. Root Certificate" is deliberately not in the list; this
      // is what keeps it (or any other lapsed root) from being added back unnoticed.
      const notAfter = new Date(cert.validTo);
      expect(notAfter.getTime()).toBeGreaterThan(Date.now());
      expect(notAfter.toISOString().slice(0, 10)).toBe(expected.expires);
    });
  });

  it("is accepted by Apple's SignedDataVerifier as a trust store", () => {
    // The consumer's own validation: `SignedDataVerifier` parses the roots in its constructor and
    // throws on anything it cannot use, so this is the closest thing to an integration assertion that
    // does not require a real Apple-signed payload.
    expect(
      () => new SignedDataVerifier(appleRootCAs(), false, Environment.PRODUCTION, 'com.nw', 1234),
    ).not.toThrow();
  });

  it('hands out a fresh array each call, so a caller cannot mutate the trust store', () => {
    const again = appleRootCAs();
    expect(again).not.toBe(roots);
    expect(again.map((b) => b.toString('base64'))).toEqual(roots.map((b) => b.toString('base64')));
  });
});
