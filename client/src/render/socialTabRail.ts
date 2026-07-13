// Shared vertical 5-tab social rail (friends/family/sect/world/mail), drawn left of the
// notebook binding line. Used by FriendsScene and by FamilyScene/SectScene — the latter two
// used to render with no rail at all, so navigating into them (auto-jump once a family/sect
// already exists) made the other 4 tabs appear to "vanish". Rendering the same rail in all
// three keeps the social hub feeling like one persistent screen.
//
// Delegates cell drawing to HubTabs.drawSidebarTabs so width/height match every other left-edge
// tab rail in the game (sidebarNavW/sidebarItemHeight) instead of the narrower notebook-margin
// gutter this rail used to size itself off — see HubTabs.ts's own doc comment for why that gutter
// was too narrow. Fixed per-cell height means 5 stacked cells no longer fill the whole available
// height like before; the rail stops short and leaves blank space below, which is the accepted
// trade-off for matching every other hub's cell size.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../i18n';
import { drawSidebarTabs, sidebarNavW, type HubTab } from '../ui/widgets/HubTabs';

export type SocialTab = 'friends' | 'family' | 'sect' | 'world' | 'mail';

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
): SocialTabRailHit[] {
  const railW = sidebarNavW(w, h, landscape);
  const defs = TAB_DEFS.filter((tabDef) => !hidden.includes(tabDef.id));
  const tabs: HubTab[] = defs.map((tabDef) => ({
    label: t(tabDef.key),
    active: active === tabDef.id,
    badge: (badges[tabDef.id] ?? 0) > 0,
  }));

  const { hits } = drawSidebarTabs(container, railW, top, h, tabs, (i) => onSelect(defs[i]!.id));
  return hits;
}
