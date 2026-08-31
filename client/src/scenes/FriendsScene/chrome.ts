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
import { caretDisplay } from '../../ui/inputDisplay';
import { drawSocialTabRail, SOCIAL_TAB_ICON, type SocialTab } from '../../ui/widgets/socialTabRail';
import { sidebarNavW } from '../../ui/widgets/HubTabs';
import { drawSceneHeader, drawHeaderCurrency, headerCurrencyWidth, sceneHeaderHeight } from '../../ui/widgets/SceneHeader';
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
  // Everything the incremental-repaint paths hold onto was just destroyed by tearDownChildren —
  // drop the refs so they fall back to a full render instead of touching a dead display object.
  core.repaint.reset();

  // Landscape only for now — see ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
  const railX = core.landscape ? sidebarNavW(core.w, core.h, true) : undefined;
  core.container.addChild(buildPaperBackground('friendsbg', core.w, core.h, { railX }));
  const decoC = buildDecorCLayer(core.w, core.h);
  if (decoC) core.container.addChild(decoC);
  drawHeader(core);
}

/** render()'s closing steps — re-attach the popup/modal singletons. The `dead` guard is kept as a
 *  backstop: drawFamilyTab/drawSectTab used to synchronously navigate away (openFamilyHub/
 *  openSectHub) once a family/sect existed, destroying this scene — incl. popup.container — while
 *  render() was still walking its own tree, so re-adding it here threw. Those jumps now happen from
 *  switchTab/loadSLGStatus instead (see core.autoJumpOrgHub), never from a draw method. */
export function endRender(core: FriendsSceneCore): void {
  if (core.dead) return;
  // Shared scroll indicator for whichever panel set a scrollable region this render (friends list /
  // world chat / mail all write regionTop/regionBottom + maxScroll). A no-op when maxScroll is 0
  // (reset at the top of render()), so the non-scrolling tabs pay nothing. Owned by `repaint`
  // because a drag has to redraw the thumb on its own, outside any render.
  core.repaint.drawScrollbar();
  core.container.addChild(core.popup.container);
  core.container.addChild(core.modalLayer);
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
  // World channel posts cost coins — show the current balance top-right while on that tab, and
  // reserve its real width so a centred title can't run under it on a narrow portrait bar
  // (2026-08-24). Only the world tab draws a cluster, so the other tabs keep the full band.
  const coins = core.tab === 'world' && core.cb.getCoins ? core.cb.getCoins() : null;
  const hdr = drawSceneHeader(core.container, w, h, t(titleKey), {
    variant: 'paper', icon: SOCIAL_TAB_ICON[core.tab],
    ...(coins === null ? {} : { rightReserve: headerCurrencyWidth(sceneHeaderHeight(h), coins) }),
  });
  core.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => core.onBack() });
  if (coins !== null) {
    drawHeaderCurrency(core.container, w, hdr.headerH, coins, [], undefined, 1, hdr.titleRight);
  }
}

// ── Shared render primitives ─────────────────────────────────────────────────

/**
 * The value Text for an on-canvas text field: renders `value` with a blinking caret while focused,
 * and — when focused — registers itself so the 0.5s blink can swap the caret in place instead of
 * re-rendering the whole tree (see ./repaint.ts). Every field on these tabs goes through here so
 * none can drift into the old "draw a caret nobody can cheaply update" shape.
 *
 * The caller still positions/anchors the returned Text and adds it to its own parent.
 */
export function caretText(core: FriendsSceneCore, opts: {
  active: boolean;
  value: string;
  size: number;
  color: number;
  /** Shown in place of the value when the field is empty and unfocused. */
  placeholder: string;
  /** Re-applies width-dependent layout after the string changes (see CaretField.reflow). */
  reflow?: (obj: PIXI.Text) => void;
}): PIXI.Text {
  const obj = txt(caretDisplay(opts.value, opts.active && core.caretOn, opts.placeholder), opts.size, opts.color);
  if (opts.active) {
    core.repaint.caretField = {
      obj, value: opts.value, placeholder: opts.placeholder,
      ...(opts.reflow ? { reflow: opts.reflow } : {}),
    };
  }
  return obj;
}

/** Center label (fixed position, not in the scroll layer). */
export function centerLabelFixed(core: FriendsSceneCore, text: string): void {
  const regionH = core.regionBottom - core.regionTop;
  const lbl = txt(text, FS.heading, C.mid);
  lbl.anchor.set(0.5, 0.5); lbl.x = core.cCX; lbl.y = core.regionTop + regionH / 2;
  core.container.addChild(lbl);
}

/**
 * Open a masked scroll region and register it as *the* scroll layer for this render, so a drag can
 * translate it instead of rebuilding every row (see FriendsSceneCore's cheap-scroll block). The clip
 * stays in `container`, outside the layer, so translating the layer scrolls the content under a
 * fixed viewport. Rows are laid out one region-height beyond the viewport in each direction
 * (`scrollOverscan`), which is how far a drag can go before it needs a rebuild.
 */
export function scrollRegion(core: FriendsSceneCore, regionH: number): { layer: PIXI.Container } {
  const { w } = core;
  const clip = new PIXI.Graphics();
  clip.beginFill(0xffffff); clip.drawRect(0, core.regionTop, w, regionH); clip.endFill();
  core.container.addChild(clip);
  const layer = new PIXI.Container();
  layer.mask = clip;
  core.container.addChild(layer);
  core.repaint.register(layer, regionH);
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
