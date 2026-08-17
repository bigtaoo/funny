// Cross-cutting chrome (tab rail/header/frame) + shared render primitives (hidden-input/scroll-
// region/center-label/button) — split out of core.ts (2026-08-11, form ① independent function
// module per claudedocs/client-modules.md's split-form priority note) purely to keep core.ts under
// the 500-line convention. Called from every domain panel (friendsList/search/orgForm/worldChat/
// mail all draw buttons, several scroll regions) and from the outer ../FriendsScene.ts assembly
// (beginRender/endRender/drawTabBar/drawHeader — the render() dispatcher's shared frame), so these
// take `core` explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { drawSocialTabRail, SOCIAL_TAB_ICON, type SocialTab } from '../../ui/widgets/socialTabRail';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { drawSceneHeader, drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import type { FriendsSceneCore } from './core';

/** render()'s opening steps — clears this frame's tree and draws the shared background. Called from
 *  the outer assembly's render() before it dispatches to the active tab's panel. */
export function beginRender(core: FriendsSceneCore): void {
  // popup.container / modalLayer are persistent singletons (built once in ctor, reused across
  // renders) — detach them first so tearDownChildren doesn't destroy them. Otherwise the next
  // render re-adds a destroyed container (transform === null) and Pixi throws "can't access
  // property _parentID, e.transform is null".
  core.container.removeChild(core.popup.container);
  core.container.removeChild(core.modalLayer);
  tearDownChildren(core.container);
  core.hits = [];
  // Cleared each render; only a scroll panel (friends list / world chat / mail) sets it
  // back > 0, so drawScrollbar() below is a no-op on the non-scrolling tabs.
  core.maxScroll = 0;

  // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
  const railX = core.landscape ? sidebarNavW(core.w, core.h, true) : undefined;
  core.container.addChild(buildPaperBackground('friendsbg', core.w, core.h, { railX }));
  const decoC = buildDecorCLayer(core.w, core.h);
  if (decoC) core.container.addChild(decoC);
  drawHeader(core);
}

/** render()'s closing steps — re-attach the popup/modal singletons. Guards `dead` itself since
 *  drawFamilyTab/drawSectTab can synchronously navigate away (openFamilyHub/openSectHub) once a
 *  family/sect already exists, which destroys this scene (incl. popup.container) mid-render —
 *  re-adding it below would then throw. */
export function endRender(core: FriendsSceneCore): void {
  if (core.dead) return;
  drawScrollbar(core);
  core.container.addChild(core.popup.container);
  core.container.addChild(core.modalLayer);
}

/**
 * Shared scroll indicator for whichever panel set a scrollable region this render
 * (friends list / world chat / mail all write regionTop/regionBottom + maxScroll).
 * No-op when maxScroll is 0 (reset at the top of render()).
 */
export function drawScrollbar(core: FriendsSceneCore): void {
  drawScrollIndicator(
    core.container,
    { x: 0, y: core.regionTop, w: core.w, h: core.regionBottom - core.regionTop },
    core.scrollY, core.maxScroll,
  );
}

// ── Tab rail (5 tabs, vertical, left of the binding line) ──────────────────────

export function drawTabBar(core: FriendsSceneCore): void {
  // Sect tab is only useful to a family leader (who can found/join one) or someone whose
  // family already belongs to a sect (who can view it) — everyone else hits a dead end, so
  // hide the tab rather than show a page that can only ever say "you can't do anything here".
  const s = core.slgStatus;
  const hidden: SocialTab[] = s && !s.isLeader && !s.sectId ? ['sect'] : [];
  const hits = drawSocialTabRail(
    core.container, core.w, core.h, core.bodyTop, core.landscape, core.tab,
    { friends: core.incoming.length + core.totalUnreadChat, mail: core.mailUnread, family: core.slgStatus?.pendingJoinRequests ?? 0 },
    (tab) => core.switchTab(tab),
    hidden,
    true, // activeTappable: re-tapping the active Mail tab must close an open detail view
  );
  core.hits.push(...hits);
}

export function drawHeader(core: FriendsSceneCore): void {
  const { w, h } = core;
  const titleKey = `friends.tab.${core.tab}` as TranslationKey;
  // Title glyph comes from the same table as the tab rail's (socialTabRail.ts) — one concept per
  // social tab, whether it's drawn in the cell or above the page.
  const hdr = drawSceneHeader(core.container, w, h, t(titleKey), {
    variant: 'paper', icon: SOCIAL_TAB_ICON[core.tab],
  });
  core.hits.push({ rect: hdr.backRect, fn: () => core.onBack() });
  // World channel posts cost coins — show the current balance top-right while on that tab.
  if (core.tab === 'world' && core.cb.getCoins) drawHeaderCurrency(core.container, w, hdr.headerH, core.cb.getCoins());
}

// ── Shared render primitives ─────────────────────────────────────────────────

/** Center label (fixed position, not in the scroll layer). */
export function centerLabelFixed(core: FriendsSceneCore, text: string): void {
  const regionH = core.regionBottom - core.regionTop;
  const lbl = txt(text, FS.heading, C.mid);
  lbl.anchor.set(0.5, 0.5); lbl.x = core.cCX; lbl.y = core.regionTop + regionH / 2;
  core.container.addChild(lbl);
}

export function scrollRegion(core: FriendsSceneCore, regionH: number): { layer: PIXI.Container } {
  const { w } = core;
  const clip = new PIXI.Graphics();
  clip.beginFill(0xffffff); clip.drawRect(0, core.regionTop, w, regionH); clip.endFill();
  core.container.addChild(clip);
  const layer = new PIXI.Container();
  layer.mask = clip;
  core.container.addChild(layer);
  return { layer };
}

export function centerLabel(core: FriendsSceneCore, layer: PIXI.Container, key: TranslationKey, regionH: number): void {
  const l = txt(t(key), FS.heading, C.mid);
  l.anchor.set(0.5, 0.5); l.x = core.cCX; l.y = core.regionTop + regionH / 2;
  layer.addChild(l);
}

export function addButton(
  core: FriendsSceneCore,
  label: string, x: number, y: number, w: number, h: number,
  fill: number, stroke: number, fn: () => void,
  textColor = 0xffffff, fontSize?: number, layer?: PIXI.Container,
): void {
  const target = layer ?? core.container;
  const g = sketchPanel(w, h, { fill, border: stroke, width: 2, seed: seedFor(x, y, w) });
  g.x = x; g.y = y;
  target.addChild(g);

  if (label === '✕') {
    // Hand-drawn close glyph instead of the bare dingbat.
    const sz = Math.round(Math.min(w, h) * 0.5);
    const ic = buildIcon('close', sz, textColor);
    ic.x = x + (w - sz) / 2; ic.y = y + (h - sz) / 2;
    target.addChild(ic);
  } else {
    // Shrink to fit when the label (e.g. a cost suffix like "发言 · 50 金币") is wider than the
    // button — narrow portrait buttons otherwise let the text spill past the button's border.
    let size = fontSize ?? snapFont(Math.round(h * 0.36));
    const maxTextW = w * 0.88;
    let tl = txt(label, size, textColor, true);
    while (tl.width > maxTextW && size > 10) {
      size -= 1;
      tl.destroy();
      tl = txt(label, size, textColor, true);
    }
    tl.anchor.set(0.5, 0.5); tl.x = x + w / 2; tl.y = y + h / 2;
    target.addChild(tl);
  }

  core.hits.push({ rect: { x, y, w, h }, scroll: !!layer, fn });
}

// ── HTML hidden input helper ────────────────────────────────────────────────

export function openHiddenInput(core: FriendsSceneCore, opts: {
  value: string;
  maxLength: number;
  placeholder?: string;
  /** Optional clamp applied to the raw value before onInput (e.g. display-width cap for org names). */
  clamp?(v: string): string;
  onInput(v: string): void;
  onBlur?(): void;
  onEnter?(): void;
}): void {
  // Tear down only the previous DOM element — NOT via core.clearHiddenInput(), which also
  // resets the active-field flags (worldChatActive / family/sectActiveInput). Every
  // caller sets its flag *before* calling openHiddenInput, so calling clearHiddenInput
  // here would wipe the flag we just set → the field never shows its blinking caret
  // (the blink loop in update() and caretDisplay() are both gated on that flag).
  if (core.hiddenInput) { core.hiddenInput.remove(); core.hiddenInput = null; }
  core.caretOn = true;
  core.caretTimer = 0;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = opts.value;
  inp.maxLength = opts.maxLength;
  inp.placeholder = opts.placeholder ?? '';
  inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
  document.body.appendChild(inp);
  inp.focus();
  inp.addEventListener('input', () => {
    if (opts.clamp) {
      const clamped = opts.clamp(inp.value);
      if (clamped !== inp.value) inp.value = clamped;
    }
    opts.onInput(inp.value);
    if (!core.dead) core.render();
  });
  if (opts.onEnter) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onEnter!(); });
  }
  inp.addEventListener('blur', () => {
    opts.onBlur?.();
    if (inp.parentNode) inp.remove();
    if (core.hiddenInput === inp) core.hiddenInput = null;
    if (!core.dead) core.render();
  });
  core.hiddenInput = inp;
}
