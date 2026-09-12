// Unit tests for the parts of server/scripts/provisionMongoUsers.mjs that are wrong-or-right without any
// network in sight — which is exactly where this script can hurt: a mis-built connection string or a
// mis-ordered digest field fails at 3am against a live cluster and looks like "bad credentials".
//
// Lives in commercial's suite for the same reason as check-db-isolation.test.ts: the database this whole
// mechanism exists to fence off is commercial's.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
// Both are plain .mjs ops scripts with no type declarations by design — they are tooling, not a package.
// @ts-expect-error — see above.
import { authDbFor, buildServiceUri, digestHeader, parseChallenge, parseEnvFile } from '../../scripts/provisionMongoUsers.mjs';
// @ts-expect-error — see above.
import { MONGO_SERVICES } from '../../scripts/mongoDbMap.mjs';

interface ServiceRow { service: string; user: string; db: string; uriEnv: string; dbEnv: string }
const SERVICES = MONGO_SERVICES as ServiceRow[];

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

describe('buildServiceUri', () => {
  const atlas = 'mongodb+srv://gamestao:secret@cluster0.example.mongodb.net/?retryWrites=true&w=majority&maxPoolSize=50';

  it('replaces the credentials and keeps every option the operator set', () => {
    const uri = buildServiceUri(atlas, 'nw_commercial', 'pw', 'admin');
    expect(uri).toContain('mongodb+srv://nw_commercial:pw@cluster0.example.mongodb.net/');
    expect(uri).not.toContain('gamestao');
    expect(uri).not.toContain('secret');
    // maxPoolSize is what keeps 7 processes under the cluster's connection cap — dropping it would take
    // the deployment down at the worst possible moment (right after a credential switch).
    expect(uri).toContain('maxPoolSize=50');
    expect(uri).toContain('retryWrites=true');
    expect(uri).toContain('w=majority');
  });

  it('percent-encodes credentials so a generated password cannot break the URI', () => {
    const uri = buildServiceUri('mongodb://host:27017/', 'nw_x', 'a/b@c:d?e', 'admin');
    expect(uri).toContain('a%2Fb%40c%3Ad%3Fe');
    expect(uri.split('@')).toHaveLength(2);
  });

  it('works on a string that carries no credentials and no options at all', () => {
    expect(buildServiceUri('mongodb://mongo:27017', 'u', 'p', 'notebook_wars')).toBe(
      'mongodb://u:p@mongo:27017/?authSource=notebook_wars',
    );
  });

  it('rejects something that is not a Mongo URI rather than emitting a broken one', () => {
    expect(() => buildServiceUri('https://example.com', 'u', 'p', 'admin')).toThrowError(/unrecognised/);
  });
});

describe('authDbFor', () => {
  it('is the service database when the user was created there (self-hosted)', () => {
    for (const row of SERVICES) expect(authDbFor(row, false)).toBe(row.db);
  });

  it('is always admin on Atlas — its SCRAM users live there, only the ROLE names the database', () => {
    // Getting this backwards authenticates against a database the user does not exist in, so every service
    // fails to start with "Authentication failed" right after a provisioning run that reported success.
    for (const row of SERVICES) expect(authDbFor(row, true)).toBe('admin');
  });

  it('the two routes disagree for every service, which is why the flag exists', () => {
    expect(SERVICES.every((r) => authDbFor(r, true) !== authDbFor(r, false))).toBe(true);
  });
});

describe('digest auth (Atlas Admin API)', () => {
  const challenge = {
    realm: 'MMS Public API',
    nonce: 'abc123',
    qop: 'auth',
    algorithm: 'MD5',
    opaque: 'op4que',
  };

  it('computes the RFC 2617 qop=auth response hash', () => {
    const header = digestHeader({
      user: 'pub', pass: 'priv', method: 'POST', uri: '/api/atlas/v2/groups/g1/databaseUsers',
      challenge, cnonce: 'deadbeef',
    });
    const ha1 = md5('pub:MMS Public API:priv');
    const ha2 = md5('POST:/api/atlas/v2/groups/g1/databaseUsers');
    const expected = md5(`${ha1}:abc123:00000001:deadbeef:auth:${ha2}`);
    expect(header).toContain(`response="${expected}"`);
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
    expect(header).toContain('cnonce="deadbeef"');
    expect(header).toContain('opaque="op4que"');
  });

  it('hashes the URI it is actually sent to — a path mismatch is a silent 401', () => {
    const a = digestHeader({ user: 'p', pass: 's', method: 'GET', uri: '/api/atlas/v2/groups', challenge, cnonce: 'c' });
    const b = digestHeader({ user: 'p', pass: 's', method: 'GET', uri: '/api/atlas/v2/groups/x', challenge, cnonce: 'c' });
    expect(a).not.toBe(b);
  });

  it('falls back to the qop-less form when the server does not offer qop', () => {
    const { qop: _drop, ...noQop } = challenge;
    const header = digestHeader({ user: 'p', pass: 's', method: 'GET', uri: '/x', challenge: noQop, cnonce: 'c' });
    const expected = md5(`${md5('p:MMS Public API:s')}:abc123:${md5('GET:/x')}`);
    expect(header).toContain(`response="${expected}"`);
    expect(header).not.toContain('qop=');
  });
});

describe('parseChallenge', () => {
  it('reads a real cloud.mongodb.com challenge, quoted and bare values alike', () => {
    const c = parseChallenge('Digest realm="MMS Public API", domain="", nonce="xYz", algorithm=MD5, qop="auth", stale=false');
    expect(c).toMatchObject({ realm: 'MMS Public API', nonce: 'xYz', algorithm: 'MD5', qop: 'auth', stale: 'false' });
  });

  it('returns an empty object for a missing header instead of throwing', () => {
    expect(parseChallenge(undefined)).toEqual({});
  });
});

describe('parseEnvFile', () => {
  it('reads the lines this script itself prints, and skips comments and blanks', () => {
    const env = parseEnvFile(
      ['# a comment', '', 'NW_MONGO_URI=mongodb://u:p@h/?authSource=admin', 'NW_COMM_MONGO_URI="mongodb://c:p@h/"'].join('\n'),
    );
    expect(env.NW_MONGO_URI).toBe('mongodb://u:p@h/?authSource=admin');
    // Quotes around a compose-style value are shell syntax, not part of the connection string.
    expect(env.NW_COMM_MONGO_URI).toBe('mongodb://c:p@h/');
    expect(Object.keys(env)).toHaveLength(2);
  });
});
