// Server-side allowlist for platform avatars (shared/src/platformAvatar.ts, CRAZYGAMES_LAUNCH.md §4.1).
// The stored URL is relayed to every other player's client, which loads it as an image, so this check
// is the only thing between an account write and an arbitrary URL in someone else's texture loader.
// The client keeps its own copy of the rule (client/test/platformAvatar.test.ts); this pins the server's.
import { describe, it, expect } from 'vitest';
import { PLATFORM_AVATAR_PREFIX, effectiveAvatarId, isAllowedPlatformAvatarUrl } from '../src/platformAvatar';

const PIC = 'https://images.crazygames.com/userportal/avatars/1.png';

describe('isAllowedPlatformAvatarUrl', () => {
  it('accepts an https URL on the allowlisted host', () => {
    expect(isAllowedPlatformAvatarUrl(PIC)).toBe(true);
    expect(isAllowedPlatformAvatarUrl('https://images.crazygames.com/a.png?size=64#x')).toBe(true);
  });

  it.each([
    ['plain http', 'http://images.crazygames.com/a.png'],
    ['another host', 'https://evil.example/a.png'],
    ['a subdomain of the host', 'https://x.images.crazygames.com/a.png'],
    ['the host as a suffix of another', 'https://images.crazygames.com.evil.example/a.png'],
    ['the host only in the path', 'https://evil.example/images.crazygames.com/a.png'],
    ['an explicit port', 'https://images.crazygames.com:8443/a.png'],
    ['a username', 'https://user@images.crazygames.com/a.png'],
    ['a username and password', 'https://user:pw@images.crazygames.com/a.png'],
    ['a data URL', 'data:image/png;base64,AAAA'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a relative path', '/userportal/avatars/1.png'],
    ['an empty string', ''],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedPlatformAvatarUrl(url)).toBe(false);
  });

  it('rejects a URL longer than 512 characters, accepts one at exactly 512', () => {
    const head = 'https://images.crazygames.com/';
    const at512 = head + 'a'.repeat(512 - head.length);
    expect(at512).toHaveLength(512);
    expect(isAllowedPlatformAvatarUrl(at512)).toBe(true);
    expect(isAllowedPlatformAvatarUrl(at512 + 'a')).toBe(false);
  });

  it.each([undefined, null, 42, {}, ['https://images.crazygames.com/a.png']])('rejects a non-string (%j)', (v) => {
    expect(isAllowedPlatformAvatarUrl(v)).toBe(false);
  });
});

describe('effectiveAvatarId', () => {
  it('an allowlisted platform picture outranks the equipped avatar, carried as a url: id', () => {
    expect(effectiveAvatarId(PIC, 'preset:cat')).toBe(`${PLATFORM_AVATAR_PREFIX}${PIC}`);
  });

  it('falls back to the equipped avatar when there is no platform picture', () => {
    expect(effectiveAvatarId(undefined, 'preset:cat')).toBe('preset:cat');
    expect(effectiveAvatarId(undefined, undefined)).toBeUndefined();
  });

  it('a stored URL that fails the allowlist is never relayed, the equipped avatar is used instead', () => {
    expect(effectiveAvatarId('https://evil.example/a.png', 'preset:cat')).toBe('preset:cat');
    expect(effectiveAvatarId('http://images.crazygames.com/a.png', undefined)).toBeUndefined();
  });
});
