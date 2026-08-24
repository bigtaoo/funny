// Card detail modal: stats + skill + troop cap + XP progress bar + injury/recover row + the 3 gear
// slots + the action button row (lock / feed / list-auction). Opened from a roster cell tap.
// Depends on ActionsPanel (doSetLock/doRecover) and FeedPanel (openFuseSelect) — see ../CardScene.ts
// assembly for the construction order.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { unitPortraitUrl, getArtTexture } from '../../render/cardArt';
import { buildIcon } from '../../render/icons';
import { buildLevelStars } from '../../render/levelStars';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { buildFactionIcon, FACTION_COLOR } from '../../render/factionIcon';
import { RARITY_COLOR } from '../EquipmentScene/layout';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import { CARD_DEFS, MAX_CARD_LEVEL, FUSION_MATERIAL_COUNT, fusionMaterialCandidates, troopCap, cardPower, cardHp, cardSiegeValue, cardSiegeValueEffective } from '../../game/meta/cardDefs';
import { skinsForUnitType, skinDisplayName } from '../../game/meta/skinDefs';
import type { UnitType } from '@nw/engine/types';
import { CardSceneCore, MODAL_DIM, injuryCountdown } from './core';
import { drawDetailFace, flipDetailPortrait } from './detailPortrait';
import type { ActionsPanel } from './actions';
import type { FeedPanel } from './feed';

/** Detail-modal domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class DetailPanel {
  /**
   * {@link detailSignature} of the modal currently on screen, or null when nothing is drawn — the
   * gate {@link ensureDetail} uses to skip a rebuild. See that method for why this exists.
   */
  private sig: string | null = null;

  constructor(
    private readonly core: CardSceneCore,
    private readonly actions: ActionsPanel,
    private readonly feed: FeedPanel,
  ) {}

  /**
   * Draw the detail modal for `cardId` **only if it isn't already on screen unchanged**.
   *
   * This is what the assembly's render() calls. render() runs for reasons that have nothing to do
   * with the modal — a busy-dot tick, a save-change ping, a portrait texture finishing its load, a
   * scroll-driven grid refresh — and it used to call {@link openDetail} unconditionally every time.
   * That rebuilt ~15 `PIXI.Text` nodes whose `resolution` is `dpr × modalScale` (2–2.3x), i.e. the
   * most expensive text in the scene to rasterize: ~4.3 ms per pass, measured at dpr 1, for a panel
   * that in almost every case had not changed by one pixel.
   *
   * The signature covers everything the panel draws, so "unchanged" is safe rather than hopeful; on
   * a skip the existing scene graph AND the existing `core.modalHits`/`modalScale` are what stay
   * valid, which is why nothing here touches them.
   */
  ensureDetail(cardId: string): void {
    const core = this.core;
    const next = this.detailSignature(cardId);
    if (next !== null && next === this.sig && core.modalOpen && core.detailId === cardId) return;
    this.openDetail(cardId);
  }

  /**
   * Everything the modal draws, flattened into one string — the sibling of ListPanel's
   * cellSignature, and the same maintenance rule applies: **anything new the panel renders has to
   * show up here**, or it will draw once and then never update.
   */
  private detailSignature(cardId: string): string | null {
    const core = this.core;
    const save = core.cb.getSave();
    const card = save.cardInv?.[cardId];
    if (!card) return null;
    const def = CARD_DEFS[card.defId];
    const state = core.cb.getCardState?.()?.[card.id];
    const now = Date.now();
    const gear = (['weapon', 'armor', 'trinket'] as EquipSlot[]).map((slot) => {
      const inst = card.gear[slot] ? save.equipmentInv?.[card.gear[slot]!] : undefined;
      return inst ? `${inst.defId}:${inst.rarity}:${inst.level}` : '-';
    }).join(',');
    const injuredUntil = state?.injuredUntil ?? 0;
    // The countdown STRING, not the deadline: rebuild once per displayed minute, not per tick.
    const injured = injuredUntil > now ? injuryCountdown(injuredUntil, now) : '';
    const unitType = def?.unitType as UnitType | undefined;
    const skin = unitType ? core.cb.getEquippedSkin(unitType) ?? '' : '';
    const ownedSkins = unitType ? skinsForUnitType(unitType, core.cb.getOwnedSkins()).join(',') : '';
    const artUrl = unitType ? unitPortraitUrl(unitType, core.cb.getEquippedSkin(unitType)) ?? '' : '';
    const artReady = artUrl && getArtTexture(artUrl).baseTexture.valid ? '1' : '0';
    const materialsOwned = card.level >= MAX_CARD_LEVEL ? -1
      : fusionMaterialCandidates(card, save.cardInv ?? {})
        .filter((c) => !core.cb.getCardState?.()?.[c.id]?.teamId).length;
    return [
      cardId, card.defId, card.level, card.locked ? 1 : 0, gear,
      state === undefined ? '-' : state.currentTroops, state?.teamId ?? '-',
      state?.teamId ? core.cb.getTeamName?.(state.teamId) ?? '' : '', injured,
      materialsOwned, skin, ownedSkins, artUrl, artReady,
      core.bt.busy ? 1 : 0, core.skinPickerOpen ? 1 : 0, core.detailFlipped ? 1 : 0,
    ].join('|');
  }

  openDetail(cardId: string): void {
    const core = this.core;
    const save = core.cb.getSave();
    const card = save.cardInv?.[cardId];
    if (!card) { core.detailId = null; this.sig = null; core.closeModal(); return; }
    core.detailId = cardId;
    this.sig = this.detailSignature(cardId);

    const { w, h } = core;
    const ml = core.modalLayer;
    // Stop an in-flight portrait flip before its container is destroyed underneath it: the tick
    // closure writes `container.scale.x` every frame, and PIXI nulls `transform` on destroy, so a
    // rebuild mid-flip used to throw out of the shared ticker (latent since the flip landed —
    // closeModal cleaned this up, a plain re-render never did).
    core.flipTickerCleanup?.();
    core.flipTickerCleanup = null;
    tearDownChildren(ml);
    core.modalHits = [];
    core.modalOpen = true;

    const def = CARD_DEFS[card.defId];
    const cardState = core.cb.getCardState?.();
    const state = cardState?.[card.id];
    const now = Date.now();
    const isInjured = (state?.injuredUntil ?? 0) > now;
    const inTeam = !!state?.teamId;
    const cap = def ? troopCap(card) : 0;
    const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
    const maxLevel = card.level >= MAX_CARD_LEVEL;

    // Fusion-readiness: how many eligible (same faction, same level, unlocked, not deployed to an
    // SLG team) material cards are currently owned, out of the FUSION_MATERIAL_COUNT needed for
    // the next fusion. Must mirror feed.ts's candidateOf filter — this used to count deployed
    // duplicates as available, so the bar could read "5/5 ready" while the fuse panel itself
    // silently excluded some of those same cards, leaving the ring short of materials.
    const materialsOwned = maxLevel ? 0
      : fusionMaterialCandidates(card, save.cardInv ?? {}).filter((c) => !cardState?.[c.id]?.teamId).length;
    const materialsFrac = maxLevel ? 1 : Math.min(1, materialsOwned / FUSION_MATERIAL_COUNT);

    // Natural (unscaled) content size — everything below is laid out in this local frame.
    const mw = Math.min(380, w - 24);
    // Content height: pad(12) + name(26) + portrait row(122, stat column now has 5 lines + inTeam
    // tag so it can outgrow the 96px portrait) + injury(26|4) + skill(28) + xp(26) + gear(82) + button row(40).
    const contentH = 12 + 26 + 122 + (isInjured ? 26 : 4) + 28 + 26 + 82 + 40;
    const mh = Math.min(contentH, h - 60);
    const mx = 0;
    const my = 0;

    // Scale the whole panel to ~80% of the *fitted* axis (min(w,h) — 1080 in both orientations by
    // design-width convention), clamped to 92% of each real screen axis (CityScene.modalScaleFor
    // fix, 2026-07-30): the old `this.landscape ? (h*0.8)/mh : (w*0.8)/mw` used the raw landscape
    // height directly, which overscaled short popups whenever landscape h was much smaller than mh
    // would suggest.
    const modalRef = Math.min(w, h);
    const scale = Math.min((modalRef * 0.8) / mw, (w * 0.92) / mw, (h * 0.92) / mh);
    const screenW = mw * scale;
    const screenH = mh * scale;
    const screenX = (w - screenW) / 2;
    const screenY = Math.max(core.headerH + 4, (h - screenH) / 2);
    core.modalScale = scale;
    core.modalOriginX = screenX;
    core.modalOriginY = screenY;

    // Dim (covers the real screen, not the scaled panel)
    const dim = new PIXI.Graphics();
    dim.beginFill(MODAL_DIM, 0.45).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panelRoot = new PIXI.Container();
    panelRoot.position.set(screenX, screenY);
    panelRoot.scale.set(scale);
    ml.addChild(panelRoot);
    core.modalPanelRoot = panelRoot;

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: isInjured ? C.red : C.accent, width: 2, seed: seedFor(0, 5, mw) });
    panel.x = mx; panel.y = my;
    panelRoot.addChild(panel);

    let cy = my + 12;

    // Name + faction totem (totem, not text — the faction is named after a
    // story lead, so a faction *name* here reads as a second character name).
    const factionColor = def ? FACTION_COLOR[def.faction] : C.accent;
    const nameLbl = core.stxt(t(`card.${card.defId}.name` as TranslationKey), FS.small, C.dark, true);
    nameLbl.x = mx + 12; nameLbl.y = cy;
    panelRoot.addChild(nameLbl);

    if (def) {
      const facSize = 28;
      const facIcon = buildFactionIcon(def.faction, facSize);
      facIcon.x = mx + mw - 12 - facSize; facIcon.y = cy - 4;
      panelRoot.addChild(facIcon);
    }
    cy += 26;

    // ── Portrait (left, tap to flip → lore) + stats column (right) ──
    const portraitBox = 96;
    const portraitX = mx + 12;
    const portraitY = cy;
    // fillAlpha: 0 — see list.ts's renderCardCell (2026-08-21): the modal panel behind is already
    // the one background layer, this frame is a stroke-only faction-colored outline.
    const frame = sketchPanel(portraitBox, portraitBox, { fill: 0xf0eee7, fillAlpha: 0, border: factionColor, seed: seedFor(portraitX, portraitY, portraitBox) });
    frame.x = portraitX; frame.y = portraitY;
    panelRoot.addChild(frame);
    const artUrl = def
      ? unitPortraitUrl(def.unitType as UnitType, core.cb.getEquippedSkin(def.unitType as UnitType)) ?? undefined
      : undefined;
    const loreText = t(`card.${card.defId}.lore` as TranslationKey);
    const faceLayer = new PIXI.Container();
    faceLayer.position.set(portraitX + portraitBox / 2, portraitY + portraitBox / 2);
    panelRoot.addChild(faceLayer);
    drawDetailFace(core, faceLayer, portraitBox, artUrl, loreText, core.detailFlipped);
    // Skipped while the skin picker popover is open (2026-08-03 fix): the popover's own dim
    // backdrop geometrically overlaps this same portrait rect (registered later, further down),
    // and hit-testing resolves first-match-wins in registration order — without this guard, a tap
    // on the popover's first row(s) hit this still-registered flip instead of selecting the skin.
    if (!core.skinPickerOpen) {
      core.modalHits.push({
        rect: core.toModalScreen({ x: portraitX, y: portraitY, w: portraitBox, h: portraitBox }),
        action: () => flipDetailPortrait(core, faceLayer, portraitBox, artUrl, loreText),
      });
    }

    // Change-skin badge (bottom-right corner of the frame) — only for characters with ≥1 owned skin.
    const unitType = def?.unitType as UnitType | undefined;
    const ownedForChar = unitType ? skinsForUnitType(unitType, core.cb.getOwnedSkins()) : [];
    if (unitType && ownedForChar.length > 0) {
      const badgeSize = 22;
      const badgeX = portraitX + portraitBox - badgeSize + 4;
      const badgeY = portraitY + portraitBox - badgeSize + 4;
      const badge = sketchPanel(badgeSize, badgeSize, { fill: C.dark, border: C.gold, seed: seedFor(badgeX, badgeY, badgeSize) });
      badge.x = badgeX; badge.y = badgeY;
      panelRoot.addChild(badge);
      const ic = buildIcon('brush', badgeSize - 8, C.gold);
      ic.x = badgeX + 4; ic.y = badgeY + 4;
      panelRoot.addChild(ic);
      core.modalHits.push({
        rect: core.toModalScreen({ x: badgeX, y: badgeY, w: badgeSize, h: badgeSize }),
        action: () => { core.skinPickerOpen = !core.skinPickerOpen; core.render(); },
      });
    }

    const statX = portraitX + portraitBox + 14;
    const statMaxW = mx + mw - 12 - statX;
    let statY = portraitY + 2;

    // Level as a row of gold stars, not "Lv.N" text — matches the roster grid card convention
    // (list.ts renderCardCell): level is the headline stat, one filled star per level (max MAX_CARD_LEVEL).
    const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, card.level));
    const { container: stars } = buildLevelStars(starN, statMaxW, 14, 3);
    stars.name = 'levelStars';
    stars.x = statX; stars.y = statY;
    panelRoot.addChild(stars);
    statY += 20;

    const pwrLine = core.stxt(`${t('roster.power')} ${power}`, FS.tiny, C.dark, true);
    pwrLine.x = statX; pwrLine.y = statY;
    panelRoot.addChild(pwrLine);
    statY += 20;

    // Troop cap
    const troopStr = state !== undefined
      ? `${t('roster.troopCap')}: ${state.currentTroops}/${cap}`
      : `${t('roster.troopCap')}: ${cap}`;
    const troopLine = core.stxt(troopStr, FS.micro, state !== undefined && state.currentTroops >= cap ? C.gold : C.dark);
    troopLine.x = statX; troopLine.y = statY;
    panelRoot.addChild(troopLine);
    statY += 18;

    // HP + siege value: static per-unit-type combat stats (engine UNIT_BLUEPRINTS), not per-instance.
    const hpLine = core.stxt(`${t('roster.hp')}: ${cardHp(card)}`, FS.micro, C.dark);
    hpLine.x = statX; hpLine.y = statY;
    panelRoot.addChild(hpLine);
    statY += 18;

    // ADR-069 follow-up: the engine clamps a unit's battle HP at the blueprint value, so troops beyond
    // that only buy base damage. A card can legitimately hold far more (troopCap is 200+ at level 1 for
    // infantry vs a 60 HP cap), and nothing in this panel used to say so — the player saw "troops 200,
    // HP 60" as two unrelated numbers. Only shown while the card is actually over the cap, so a normal
    // card carries no extra copy.
    // Measured against `cardHp()` = the BASELINE blueprint HP, matching the HP line directly above it.
    // The real in-battle cap is that value scaled by card level + gear (buildSiegeBlueprints), so this
    // can warn a little early on a well-geared card — deliberately the safe direction, and it keeps the
    // two lines consistent with each other rather than quoting two different definitions of "HP".
    const overCap = (state?.currentTroops ?? 0) - cardHp(card);
    if (overCap > 0) {
      const overLine = core.stxt(t('roster.hpOverflow').replace('{n}', String(overCap)), FS.micro, C.mid);
      overLine.x = statX; overLine.y = statY;
      panelRoot.addChild(overLine);
      statY += 18;
    }

    // ADR-069: base damage = rating × troops / 60, so the rating alone tells the player nothing about
    // what this card will actually do to a base (0 troops → 0 damage). Show both: the effective number
    // for the troops currently assigned, with the per-60-troop rating in parentheses.
    const siegeEff = cardSiegeValueEffective(card, state?.currentTroops ?? 0);
    const siegeText = `${t('roster.siege')}: ${siegeEff}`
      + t('roster.siegePer60').replace('{base}', String(cardSiegeValue(card)));
    const siegeLine = core.stxt(siegeText, FS.micro, C.dark);
    siegeLine.x = statX; siegeLine.y = statY;
    panelRoot.addChild(siegeLine);
    statY += 18;

    if (inTeam) {
      const teamName = state?.teamId ? core.cb.getTeamName?.(state.teamId) : undefined;
      const tagText = teamName ? t('roster.inTeamNamed').replace('{team}', teamName) : t('roster.inTeam');
      const tag = core.stxt(`[${tagText}]`, FS.micro, C.accent, true);
      tag.x = statX; tag.y = statY;
      panelRoot.addChild(tag);
      statY += 16;
    }

    cy = portraitY + Math.max(portraitBox, statY - portraitY) + 10;

    // Injury status + recover button
    if (isInjured && state?.injuredUntil) {
      const injLine = core.stxt(t('roster.injured').replace('{time}', injuryCountdown(state.injuredUntil, now)), FS.micro, C.red);
      injLine.x = mx + 12; injLine.y = cy;
      panelRoot.addChild(injLine);

      if (core.cb.recoverCard && !core.bt.busy) {
        const recBtnW = 110;
        const recBtn = sketchPanel(recBtnW, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 3, recBtnW) });
        recBtn.x = mx + mw - 12 - recBtnW; recBtn.y = cy - 1;
        panelRoot.addChild(recBtn);
        const recLbl = core.stxt(t('roster.recoverBtn'), FS.micro, C.dark);
        recLbl.anchor.set(0.5, 0.5); recLbl.x = recBtn.x + recBtnW / 2; recLbl.y = recBtn.y + 11;
        panelRoot.addChild(recLbl);
        core.modalHits.push({
          rect: core.toModalScreen({ x: recBtn.x, y: recBtn.y, w: recBtnW, h: 22 }),
          action: () => void this.actions.doRecover(card.id),
        });
      }
      cy += 22;
    }
    cy += 4;

    // Skill
    const skillVal = def ? def.skillGrowth[Math.max(0, card.level - 1)] : 0;
    const hasSkill = def?.faction === 'anna' && skillVal > 0;
    const skillKey = hasSkill ? `card.${card.defId}.desc` as TranslationKey : 'roster.skillNone' as TranslationKey;
    const skillLine = core.stxt(`${t('roster.skill')}: ${t(skillKey)}`, FS.micro, hasSkill ? C.accent : C.mid);
    skillLine.x = mx + 12; skillLine.y = cy;
    skillLine.style.wordWrap = true; skillLine.style.wordWrapWidth = mw - 24;
    panelRoot.addChild(skillLine);
    cy += 28;

    // Fusion-readiness bar: owned same-level same-faction materials toward FUSION_MATERIAL_COUNT.
    const barW = mw - 24;
    const barH = 10;
    const barBg = new PIXI.Graphics();
    barBg.beginFill(0xe0ddd4).drawRoundedRect(mx + 12, cy, barW, barH, 4).endFill();
    panelRoot.addChild(barBg);
    if (!maxLevel && materialsFrac > 0) {
      const barFill = new PIXI.Graphics();
      barFill.beginFill(C.accent).drawRoundedRect(mx + 12, cy, Math.max(4, barW * materialsFrac), barH, 4).endFill();
      panelRoot.addChild(barFill);
    }
    const xpLbl = maxLevel
      ? core.stxt(t('roster.maxLevel'), FS.micro, C.gold, true)
      : core.stxt(`${t('roster.fuseMaterials')} ${materialsOwned} / ${FUSION_MATERIAL_COUNT}`, FS.micro, C.mid);
    xpLbl.anchor.set(0.5, 0); xpLbl.x = mx + mw / 2; xpLbl.y = cy + 12;
    panelRoot.addChild(xpLbl);
    cy += 26;

    // Gear slots (3 slots; tap each to open equipment scene)
    this.renderDetailGearSlots(card, mx, cy, mw, save);
    cy += 82;

    // Action buttons
    const btnY = my + mh - 40;
    const btnH = 30;
    const buttons: { label: string; fill: number; stroke: number; fn: () => void; on: boolean }[] = [];

    // Lock / unlock
    const lockOn = !core.bt.busy;
    buttons.push(card.locked
      ? { label: t('roster.unlock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.actions.doSetLock(card.id, false) }
      : { label: t('roster.lock'), fill: 0xeeeedd, stroke: C.mid, on: lockOn, fn: () => void this.actions.doSetLock(card.id, true) });

    // Fuse
    const fuseOn = !core.bt.busy && !maxLevel;
    buttons.push({ label: t('roster.fuseBtn'), fill: C.dark, stroke: C.gold, on: fuseOn, fn: () => this.feed.openFuseSelect(card) });

    // Auction (requires all gear slots empty)
    const allGearEmpty = !card.gear.weapon && !card.gear.armor && !card.gear.trinket;
    const auctionOn = !core.bt.busy && !card.locked && allGearEmpty;
    buttons.push({ label: t('roster.listAuction'), fill: 0xf5f0e8, stroke: C.mid, on: auctionOn, fn: () => core.showToast(t('roster.listAuctionNeedUnequip' as TranslationKey), C.mid) });

    const n = buttons.length;
    const gap = 6;
    const bw = (mw - 24 - gap * (n - 1)) / n;
    buttons.forEach((b, i) => {
      const x = mx + 12 + i * (bw + gap);
      const g = sketchPanel(bw, btnH, { fill: b.on ? b.fill : C.btnOff, border: b.on ? b.stroke : C.mid, seed: seedFor(i, 6, bw) });
      g.x = x; g.y = btnY;
      panelRoot.addChild(g);
      const lbl = core.stxt(b.label, FS.micro, b.on ? (b.fill === 0xeeeedd || b.fill === 0xf5f0e8 ? C.dark : C.light) : C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = btnY + btnH / 2;
      panelRoot.addChild(lbl);
      if (b.on) core.modalHits.push({ rect: core.toModalScreen({ x, y: btnY, w: bw, h: btnH }), action: b.fn });
    });

    // Skin picker popover (change-skin badge tapped) — floats over the rest of the modal; a tap
    // anywhere outside its rows closes the picker (not the whole modal — needs a second tap for that).
    if (core.skinPickerOpen && unitType) {
      const pW = mw - 24, pX = mx + 12, pY = my + 40;
      const rowH = 26, rowGap = 4;
      const options: Array<{ id: string | null; label: string }> = [
        { id: null, label: t('collection.default') },
        ...ownedForChar.map((id) => ({ id, label: skinDisplayName(id) })),
      ];
      const pH = options.length * (rowH + rowGap) + 8;
      // Covers the real screen (not just the scaled panel), so the picker reads as fully modal.
      const dim2 = new PIXI.Graphics();
      dim2.beginFill(MODAL_DIM, 0.5).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim2);
      const popup = sketchPanel(pW, pH, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(pX, pY, pW) });
      popup.x = pX; popup.y = pY;
      panelRoot.addChild(popup);
      const equippedNow = core.cb.getEquippedSkin(unitType);
      options.forEach((opt, i) => {
        const ry = pY + 4 + i * (rowH + rowGap);
        const isEq = opt.id === equippedNow;
        const row = sketchPanel(pW - 8, rowH, { fill: isEq ? C.dark : 0xf5f0e8, border: isEq ? C.green : C.mid, seed: seedFor(i, ry, pW) });
        row.x = pX + 4; row.y = ry;
        panelRoot.addChild(row);
        const lbl = core.stxt(opt.label, FS.micro, isEq ? C.light : C.dark, true);
        lbl.anchor.set(0.5, 0.5); lbl.x = pX + pW / 2; lbl.y = ry + rowH / 2;
        panelRoot.addChild(lbl);
        if (!isEq) {
          core.modalHits.push({
            rect: core.toModalScreen({ x: pX + 4, y: ry, w: pW - 8, h: rowH }),
            action: () => { core.cb.equipSkin(unitType, opt.id); core.skinPickerOpen = false; core.render(); },
          });
        }
      });
      core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => { core.skinPickerOpen = false; core.render(); } });
    }

    // Tap outside to close
    core.modalHits.push({ rect: core.toModalScreen({ x: mx, y: my, w: mw, h: mh }), action: () => {} });
    core.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => core.closeDetail() });
  }


  /** Render 3 gear slot boxes (icon + level badge) inside the detail modal. */
  renderDetailGearSlots(card: CardInstance, mx: number, cy: number, mw: number, save: SaveData): void {
    const core = this.core;
    const EQUIP_SLOTS: EquipSlot[] = ['weapon', 'armor', 'trinket'];
    const cellW = (mw - 24 - 8 * 2) / 3;
    const cellH = 74;
    const iconSize = Math.min(cellW, cellH) - 26;
    const root = core.modalPanelRoot;

    EQUIP_SLOTS.forEach((slot, i) => {
      const x = mx + 12 + i * (cellW + 8);
      const instId = card.gear[slot];
      const inst = instId ? save.equipmentInv?.[instId] : undefined;
      const cell = sketchPanel(cellW, cellH, { fill: 0xf0eeea, border: inst ? RARITY_COLOR[inst.rarity] : C.mid, seed: seedFor(i, 8, cellW) });
      cell.x = x; cell.y = cy;
      root.addChild(cell);

      const iconCx = x + cellW / 2;
      const iconCy = cy + 6 + iconSize / 2;
      // buildEquipIcon already renders the hollow "+" placeholder for an empty
      // slot, so it doesn't need dimming (a dimmed real-item glyph used to read
      // as a low-rarity equipped item at a glance).
      const icon = buildEquipIcon(inst?.defId, slot, inst?.rarity ?? 'common', iconSize, seedFor(i, 8, cellW));
      icon.position.set(iconCx, iconCy);
      root.addChild(icon);

      const slotLbl = core.stxt(t(`equip.slot.${slot}` as TranslationKey), FS.micro, inst ? C.mid : C.light);
      slotLbl.anchor.set(0.5, 0); slotLbl.x = iconCx; slotLbl.y = cy + cellH - 16;
      root.addChild(slotLbl);

      if (inst) {
        const badge = core.stxt(`+${inst.level}`, FS.micro, C.dark, true);
        badge.anchor.set(1, 0); badge.x = x + cellW - 4; badge.y = cy + 4;
        root.addChild(badge);
      }

      if (core.cb.openEquipment && !core.bt.busy) {
        core.modalHits.push({
          rect: core.toModalScreen({ x, y: cy, w: cellW, h: cellH }),
          action: () => { core.closeModal(); core.cb.openEquipment!(card.id, slot); },
        });
      }
    });
  }
}
