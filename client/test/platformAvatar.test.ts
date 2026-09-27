// Portal profile pictures as `url:` avatar ids (render/avatar.ts; CRAZYGAMES_LAUNCH.md §4.1). The id
// arrives from another player's account, so only allowlisted https hosts may ever be loaded, and only
// on a platform that opts in — every other platform keeps drawing the letter initial it always drew
// for an id it does not know.
import { describe, it, expect, afterEach } from 'vitest';
import { platformAvatarUrl, parseAvatarId, setRemoteAvatarsEnabled } from '../src/render/avatar';
import { WebPlatform } from '../src/platform/web/WebPlatform';
import { WechatPlatform } from '../src/platform/wechat/WechatPlatform';
import { CrazyGamesPlatform } from '../src/platform/crazygames/CrazyGamesPlatform';

const PIC = 'https://images.crazygames.com/userportal/avatars/1.png';

describe('platformAvatarUrl', () => {
  afterEach(() => setRemoteAvatarsEnabled(false));

  it('accepts the CrazyGames avatar host over https', () => {
    expect(platformAvatarUrl(`url:${PIC}`)).toBe(PIC);
  });

  it.each([
    ['http (not https)', 'url:http://images.crazygames.com/a.png'],
    ['another host', 'url:https://evil.example/a.png'],
    ['a look-alike host', 'url:https://images.crazygames.com.evil.example/a.png'],
    ['credentials in the URL', 'url:https://x@images.crazygames.com/a.png'],
    ['an explicit port', 'url:https://images.crazygames.com:8443/a.png'],
    ['not a URL', 'url:not a url'],
    ['a normal avatar id', 'preset:cat'],
  ])('rejects %s', (_label, id) => {
    expect(platformAvatarUrl(id)).toBeNull();
  });

  it('is not an equippable category (nothing can pick it; the portal account imposes it)', () => {
    expect(parseAvatarId(`url:${PIC}`)).toBeNull();
  });
});

describe('who draws remote avatars', () => {
  it('only CrazyGames follows portal sign-ins (Web and WeChat have no portal account)', () => {
    const onProto = (P: unknown): boolean =>
      'onPortalSignIn' in (P as { prototype: object }).prototype;
    expect(onProto(CrazyGamesPlatform)).toBe(true);
    expect(onProto(WebPlatform)).toBe(false);
    expect(onProto(WechatPlatform)).toBe(false);
  });
});
