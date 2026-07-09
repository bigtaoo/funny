// Shared vertical 5-tab social rail (friends/family/sect/world/mail), drawn left of the
// notebook binding line. Used by FriendsScene and by FamilyScene/SectScene — the latter two
// used to render with no rail at all, so navigating into them (auto-jump once a family/sect
// already exists) made the other 4 tabs appear to "vanish". Rendering the same rail in all
// three keeps the social hub feeling like one persistent screen.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, marginLineX } from './sketchUi';

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
  active: SocialTab,
  badges: Partial<Record<SocialTab, number>>,
  onSelect: (tab: SocialTab) => void,
): SocialTabRailHit[] {
  const railW = marginLineX(w);
  const cellH = Math.round((h - top) / TAB_DEFS.length);
  const fontSize = Math.round(railW * 0.16);
  const hits: SocialTabRailHit[] = [];

  TAB_DEFS.forEach((tabDef, i) => {
    const ty = top + i * cellH;
    const isActive = active === tabDef.id;

    const bg = new PIXI.Graphics();
    bg.beginFill(isActive ? C.paper : C.dark, isActive ? 1 : 0.12);
    bg.drawRect(0, ty, railW, cellH);
    bg.endFill();
    container.addChild(bg);

    if (isActive) {
      const marker = new PIXI.Graphics();
      marker.beginFill(C.accent);
      marker.drawRect(railW - 3, ty + cellH * 0.15, 3, cellH * 0.7);
      marker.endFill();
      container.addChild(marker);
    }

    const label = txt(t(tabDef.key), fontSize, isActive ? C.dark : C.mid, isActive);
    label.anchor.set(0.5, 0.5); label.x = railW / 2; label.y = ty + cellH / 2;
    container.addChild(label);

    const badge = badges[tabDef.id] ?? 0;
    if (badge > 0) {
      const dot = new PIXI.Graphics();
      dot.beginFill(C.red);
      dot.drawCircle(railW - Math.round(railW * 0.16), ty + Math.round(cellH * 0.22), Math.round(railW * 0.09));
      dot.endFill();
      container.addChild(dot);
    }

    hits.push({ rect: { x: 0, y: ty, w: railW, h: cellH }, fn: () => onSelect(tabDef.id) });
  });

  return hits;
}
