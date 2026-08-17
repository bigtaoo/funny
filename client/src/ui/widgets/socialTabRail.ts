// Shared 5-tab social nav (friends/family/sect/world/mail). Landscape draws it as a vertical
// rail left of the notebook binding line; portrait draws it as a bottom nav bar instead
// (LOBBY_IA_REDESIGN.md §18 — portrait's short edge is the whole screen width, so a left rail
// there eats too much of it). Used by FriendsScene and by FamilyScene/SectScene — the latter two
// used to render with no rail at all, so navigating into them (auto-jump once a family/sect
// already exists) made the other 4 tabs appear to "vanish". Rendering the same nav in all
// three keeps the social hub feeling like one persistent screen.
//
// Landscape delegates cell drawing to HubTabs.drawSidebarTabs so width/height match every other
// left-edge tab rail in the game (sidebarNavW/sidebarItemHeight) instead of the narrower
// notebook-margin gutter this rail used to size itself off — see HubTabs.ts's own doc comment for
// why that gutter was too narrow. Fixed per-cell height means 5 stacked cells no longer fill the
// whole available height like before; the rail stops short and leaves blank space below, which is
// the accepted trade-off for matching every other hub's cell size.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n/index';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from './HubTabs';
import type { IconKind } from '../../render/icons';

export type SocialTab = 'friends' | 'family' | 'sect' | 'world' | 'mail';

/**
 * The AI tab art per social tab (see render/icons.ts). Exported because these five cells and the
 * five page TITLES they lead to are the same five concepts — FriendsScene's header reads this same
 * table (chrome.ts) so a tab and its title can never drift apart. World reuses the globe the lobby's
 * Social button already has; the other four came with batch 5, and are drawn far enough apart to
 * survive being stacked in one rail: two heads (friends) vs a three-person cluster with a larger
 * centre figure (family) vs a pagoda (sect) vs an envelope (mail).
 */
export const SOCIAL_TAB_ICON: Record<SocialTab, IconKind> = {
  friends: 'friendsTabIcon',
  family: 'familyTabIcon',
  sect: 'sectTabIcon',
  world: 'socialTabIcon',
  mail: 'mailTabIcon',
};

const TAB_DEFS: { id: SocialTab; key: TranslationKey }[] = [
  { id: 'friends', key: 'friends.tab.friends' },
  { id: 'family',  key: 'friends.tab.family' },
  { id: 'sect',    key: 'friends.tab.sect' },
  { id: 'world',   key: 'friends.tab.world' },
  { id: 'mail',    key: 'friends.tab.mail' },
];

export interface SocialTabRailHit {
  rect: { x: number; y: number; w: number; h: number };
  fn: () => void;
}

export function drawSocialTabRail(
  container: PIXI.Container,
  w: number,
  h: number,
  top: number,
  landscape: boolean,
  active: SocialTab,
  badges: Partial<Record<SocialTab, number>>,
  onSelect: (tab: SocialTab) => void,
  hidden: SocialTab[] = [],
  // Only FriendsScene needs the active cell to be tappable (re-tapping the active Mail tab backs
  // out of a drilled-in detail view to that tab's list — see switchTab()'s same-tab re-tap branch).
  // FamilyScene/SectScene keep the convention every other hub tab bar follows: the active cell has
  // no hit rect at all, so it defaults off here.
  activeTappable = false,
): SocialTabRailHit[] {
  const defs = TAB_DEFS.filter((tabDef) => !hidden.includes(tabDef.id));
  const tabs: HubTab[] = defs.map((tabDef) => ({
    label: t(tabDef.key),
    active: active === tabDef.id,
    icon: SOCIAL_TAB_ICON[tabDef.id],
    badge: (badges[tabDef.id] ?? 0) > 0,
  }));

  if (!landscape) {
    const barH = bottomNavH(h);
    const { hits } = drawBottomNavTabs(container, w, h - barH, barH, tabs, (i) => onSelect(defs[i]!.id), { activeTappable });
    return hits;
  }

  const railW = sidebarNavW(w, h, landscape);
  const { hits } = drawSidebarTabs(container, railW, top, h, tabs, (i) => onSelect(defs[i]!.id), { activeTappable });
  return hits;
}
