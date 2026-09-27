// The platform's "chat off" setting (ui/chatPolicy.ts; CrazyGames `disableChat`, CRAZYGAMES_LAUNCH.md
// §4.2) removes the world tab — it is nothing but chat — while friends/family/sect/mail stay.
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { drawSocialTabRail, type SocialTab } from '../../src/ui/widgets/socialTabRail';
import { setChatDisabled } from '../../src/ui/chatPolicy';

function selectable(): SocialTab[] {
  const picked: SocialTab[] = [];
  const hits = drawSocialTabRail(new PIXI.Container(), 1920, 1080, 100, true, 'mail', {}, (tab) => picked.push(tab));
  for (const hit of hits) hit.fn();
  return picked;
}

describe('socialTabRail — platform chat setting', () => {
  afterEach(() => setChatDisabled(false));

  it('offers the world tab while chat is on', () => {
    expect(selectable()).toContain('world');
  });

  it('drops only the world tab while chat is off', () => {
    setChatDisabled(true);
    expect(selectable()).toEqual(['friends', 'family', 'sect']); // mail is the active cell (no hit)
  });
});
