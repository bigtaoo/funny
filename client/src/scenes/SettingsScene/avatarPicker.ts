// SettingsScene's avatar picker modal (category tabs + scrollable icon grid), extracted as a form①
// free function (claudedocs/client-modules.md "单文件 500 行收敛"). Takes a narrow `PickerHost` —
// the scene's picker-related fields made public for this — instead of closing over `this`; those
// fields stay mutated in place exactly as before (`host.pickerScrollY = ...` etc.), just addressed
// through a narrower type.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import { Rect } from '../../layout/ILayout';
import { t } from '../../i18n';
import { ui as C, sketchPanel } from '../../render/sketchUi';
import { buildAvatar, makeAvatarId, type AvatarCategory } from '../../render/avatar';
import { PRESET_AVATAR_KEYS } from '../../render/presetAvatarArt';
import { buildIcon } from '../../render/icons';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { FS, snapFont } from '../../render/fontScale';
import { CARD_DEFS } from '../../game/meta/cardDefs';
import { SKIN_TARGET_UNIT } from '../../game/meta/skinDefs';
import { allTitleIds } from '../../game/meta/titles';
import type { SettingsSceneCallbacks, AvatarPickerItem } from './types';
import type { Hit } from '../../ui/hits';
import { AVATAR_TABS, AVATAR_TAB_LABEL_KEY, AVATAR_TAB_ICON, AVATAR_LOCKED_KEY } from './types';

function txt(label: string, size: number, color: number, bold = false): PIXI.Text {
  return makeText(label, {
    fontSize: size, fill: color, fontFamily: 'monospace',
    fontWeight: bold ? 'bold' : 'normal',
  });
}

/** What drawAvatarPickerOverlay/showLockToast need out of SettingsScene. */
export interface PickerHost {
  readonly container: PIXI.Container;
  readonly w: number;
  readonly h: number;
  readonly cb: SettingsSceneCallbacks;
  currentAvatarId: string | undefined;
  hits: Hit[];
  pickerTab: AvatarCategory;
  pickerScrollY: number;
  pickerMaxScroll: number;
  pickerViewRect: Rect | null;
  pickerCellHits: Hit[];
  toastMsg: string | null;
  toastTimer: number;
  render(): void;
  closeAvatarPicker(): void;
}

export function showLockToast(host: PickerHost, category: Exclude<AvatarCategory, 'preset'>): void {
  host.toastMsg = t(AVATAR_LOCKED_KEY[category]);
  host.toastTimer = 2.2;
  host.render();
}

/** The full candidate list + lock state for one tab (preset is always all-unlocked). */
export function pickerItems(cb: SettingsSceneCallbacks, category: AvatarCategory): AvatarPickerItem[] {
  const everOwned = cb.everOwned ?? {};
  switch (category) {
    case 'preset':
      return PRESET_AVATAR_KEYS.map((key) => ({ id: makeAvatarId('preset', key), locked: false }));
    case 'title': {
      const owned = new Set(cb.ownedTitles ?? []);
      return allTitleIds(cb.ownedTitles ?? []).map((id) => ({ id: makeAvatarId('title', id), locked: !owned.has(id) }));
    }
    case 'hero': {
      // everOwned.hero + cardInv are keyed by CARD_DEFS id (e.g. 'lichuang'), NOT unitType — only
      // check against d.id, even though the avatarId itself is keyed by d.unitType (art lookup key).
      const owned = new Set([...(cb.ownedHeroes ?? []), ...(everOwned.hero ?? [])]);
      return Object.values(CARD_DEFS).map((d) => ({ id: makeAvatarId('hero', d.unitType), locked: !owned.has(d.id) }));
    }
    case 'skin': {
      const owned = new Set([...(cb.ownedSkins ?? []), ...(everOwned.skin ?? [])]);
      return Object.keys(SKIN_TARGET_UNIT).map((id) => ({ id: makeAvatarId('skin', id), locked: !owned.has(id) }));
    }
  }
}

/** Modal avatar picker — category tabs + a scrollable icon grid, with locked (never-owned) items greyed out. */
export function drawAvatarPickerOverlay(host: PickerHost): void {
  const { w, h, container, cb } = host;
  // Modal: discard base-scene hits so only the overlay's controls are tappable; the grid itself
  // uses pickerCellHits/pickerViewRect (checked in handleDown) instead of host.hits.
  host.hits = [];
  host.pickerCellHits = [];

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.7); dim.drawRect(0, 0, w, h); dim.endFill();
  container.addChild(dim);

  const pw = Math.round(w * 0.88), ph = Math.round(h * 0.68);
  const px = (w - pw) / 2, py = (h - ph) / 2;
  const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, width: 2.4, seed: 42 });
  panel.x = px; panel.y = py;
  container.addChild(panel);

  const title = txt(t('settings.avatar'), FS.title, C.dark, true);
  title.anchor.set(0.5, 0); title.x = w / 2; title.y = py + Math.round(h * 0.022);
  container.addChild(title);

  // Category tabs, drawn in a sub-container offset to the panel so drawHubTabs' own (0-based)
  // layout math just works; its returned hit rects are local to that sub-container, so they're
  // translated back to stage space before landing in host.hits.
  const tabY = py + Math.round(h * 0.06);
  const tabStripH = hubTabsHeight(h);
  const tabLayer = new PIXI.Container();
  container.addChild(tabLayer);
  const tabs: HubTab[] = AVATAR_TABS.map((cat) => ({
    label: t(AVATAR_TAB_LABEL_KEY[cat]), active: cat === host.pickerTab, icon: AVATAR_TAB_ICON[cat],
  }));
  const tabHits = drawHubTabs(tabLayer, pw, 0, tabStripH, tabs, (i) => {
    host.pickerTab = AVATAR_TABS[i]!;
    host.pickerScrollY = 0;
    host.toastMsg = null;
    host.render();
  });
  tabLayer.x = px; tabLayer.y = tabY;
  host.hits.push(...tabHits.map((hit) => ({ ...hit, rect: { ...hit.rect, x: hit.rect.x + px, y: hit.rect.y + tabY } })));

  // Scrollable icon grid below the tabs.
  const gridTop = tabY + tabStripH + Math.round(h * 0.02);
  const toastH = Math.round(h * 0.045);
  const closeAreaH = Math.round(h * 0.09);
  const gridH = py + ph - closeAreaH - toastH - gridTop;
  const gridPad = Math.round(pw * 0.05);
  const gridInnerW = pw - gridPad * 2;
  const view: Rect = { x: px + gridPad, y: gridTop, w: gridInnerW, h: gridH };

  const clip = new PIXI.Graphics();
  clip.beginFill(0xffffff); clip.drawRect(view.x, view.y, view.w, view.h); clip.endFill();
  container.addChild(clip);
  const gridLayer = new PIXI.Container();
  gridLayer.mask = clip;
  container.addChild(gridLayer);

  const items = pickerItems(cb, host.pickerTab);
  const avS = Math.round(h * 0.085);
  const cellGap = Math.round(avS * 0.35);
  const cols = Math.max(1, Math.floor((gridInnerW + cellGap) / (avS + cellGap)));
  const rowH = avS + cellGap;
  const rows = Math.ceil(items.length / cols);
  const contentH = rows * rowH;
  host.pickerMaxScroll = Math.max(0, contentH - gridH);
  host.pickerScrollY = Math.min(host.pickerScrollY, host.pickerMaxScroll);

  items.forEach((item, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ax = view.x + col * (avS + cellGap);
    const ay = view.y + row * rowH - host.pickerScrollY;
    if (ay + avS < view.y || ay > view.y + view.h) return; // culled — off-screen row

    const selected = host.currentAvatarId === item.id;
    if (selected) {
      const ring = new PIXI.Graphics();
      ring.lineStyle(Math.max(2, Math.round(avS * 0.07)), C.gold, 1);
      ring.drawCircle(ax + avS / 2, ay + avS / 2, avS / 2 + Math.round(avS * 0.06));
      gridLayer.addChild(ring);
    }

    const av = buildAvatar(avS, '', 10 + i, item.id);
    av.x = ax; av.y = ay;
    av.alpha = item.locked ? 0.32 : (!cb.onSetAvatar ? 0.75 : (selected ? 1.0 : 0.82));
    gridLayer.addChild(av);

    if (item.locked) {
      const lockS = Math.round(avS * 0.42);
      const lockBadge = new PIXI.Graphics();
      lockBadge.beginFill(0x000000, 0.5);
      lockBadge.drawCircle(ax + avS / 2, ay + avS / 2, lockS / 2 + 3);
      lockBadge.endFill();
      gridLayer.addChild(lockBadge);
      const lock = buildIcon('lock', lockS, 0xffffff);
      lock.x = ax + avS / 2 - lockS / 2; lock.y = ay + avS / 2 - lockS / 2;
      gridLayer.addChild(lock);
    }

    if (cb.onSetAvatar && !selected) {
      const cat = host.pickerTab;
      host.pickerCellHits.push({
        rect: { x: ax, y: ay, w: avS, h: avS }, // ay is already on-screen position for this render
        fn: item.locked
          ? () => showLockToast(host, cat as Exclude<AvatarCategory, 'preset'>)
          : () => {
            host.currentAvatarId = item.id;
            cb.onSetAvatar!(item.id);
            host.closeAvatarPicker(); // pick + dismiss
          },
      });
    }
  });
  host.pickerViewRect = view;

  drawScrollIndicator(container, view, host.pickerScrollY, host.pickerMaxScroll);

  // Transient lock-reason toast, between the grid and the close button.
  if (host.toastMsg) {
    const toast = txt(host.toastMsg, snapFont(Math.round(toastH * 0.5)), C.red, true);
    toast.anchor.set(0.5, 0.5);
    toast.x = w / 2; toast.y = gridTop + gridH + toastH / 2;
    container.addChild(toast);
  }

  // Close button.
  const btnW = Math.round(pw * 0.5), btnH = Math.round(closeAreaH * 0.62);
  const bxx = px + (pw - btnW) / 2, byy = py + ph - btnH - Math.round(h * 0.02);
  const cBox = new PIXI.Graphics();
  cBox.beginFill(C.dark); cBox.drawRect(bxx, byy, btnW, btnH); cBox.endFill();
  container.addChild(cBox);
  const cLbl = txt(t('common.close'), snapFont(Math.round(btnH * 0.36)), 0xffffff, true);
  cLbl.anchor.set(0.5, 0.5); cLbl.x = bxx + btnW / 2; cLbl.y = byy + btnH / 2;
  container.addChild(cLbl);
  host.hits.push({ rect: { x: bxx, y: byy, w: btnW, h: btnH }, fn: () => host.closeAvatarPicker() });

  // Tap outside panel = close (registered last so specific hits win — first-match-wins).
  host.hits.push({ rect: { x: 0, y: 0, w, h }, fn: () => host.closeAvatarPicker() });
}
