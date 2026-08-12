// composition-hooks.ui.ts — BEHAVIORAL counterpart to test/ui/composition-wiring.ui.ts.
//
// The 2026-08-11/08-12 client mixin-chain → composition conversions resolved each chain's
// bidirectional dependencies with a "lazy hook": a field on `XSceneCore` declared with a **no-op
// default**, which the outer assembly overwrites with the real `() => this.someSibling.method()`
// immediately after the real sibling is constructed. composition-wiring.ui.ts pins the IDENTITY half
// of that (`expect(core.someHook).not.toBeUndefined()`, `expect(a.sibling).toBe(scene.sibling)`) —
// but a hook field is ALWAYS defined (that's the whole point of the no-op default), so those checks
// stay green even if the assembly never overwrites it. A hook that is wired but never invoked, or an
// assembly that simply forgets one `this.core.xHook = ...` line, is invisible to them.
//
// This file closes that gap for the hooks that had NO behavioral coverage anywhere in the suite —
// verified by deliberately deleting each assembly's hook assignment and confirming the whole
// existing suite still passed (AuctionScene: 275 auction/scene tests green with a dead
// `reopenCreateForm`; LobbyScene: all 162 files / 1478 tests green with a dead `buildHook`;
// EquipmentScene `cancelAssignHook`: no test referenced backAction() at all). The hooks that turned
// out to be ALREADY well covered are deliberately NOT re-tested here — see the note at the bottom of
// this file for which ones and where their coverage lives.
//
// Every test drives the hook through its real user-facing call path (a rendered hit rect, a public
// `applyX()`, a dispatched engine event) and asserts a real observable effect, not a spy call count.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — real PIXI tree, no renderer.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Every PIXI.Text string currently in a display subtree (same helper as auctionScene.ui.ts). */
function collectTexts(root: PIXI.Container): string[] {
  const out: string[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch.text);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

// ── AuctionScene: core.reopenCreateForm (item picker → back to the create-listing form) ──────────
//
// The conversion cut the picker↔createForm cycle by routing "return to the create form" through
// `core.reopenCreateForm` — which also let the whole picker side collapse from a class to plain
// functions (itemPickerRender.ts). itemPickerRender.ts's pickAndReturn()/cancelItemPicker() set the
// picked item on Core, close the picker overlay, render(), and then call the hook. With the hook
// left at its no-op default, the item selection still lands on Core (so every existing
// auctionPickerDedupe.ui.ts assertion passes) but the player is dumped back on the plain market list
// instead of the create form they came from — the listing they were halfway through composing is
// simply gone from the screen.

describe('AuctionScene — core.reopenCreateForm actually returns the user to the create form', () => {
  function buildSave(): SaveData {
    const save = makeNewSave('acc_test');
    save.equipmentInv = {
      inst_A: { id: 'inst_A', defId: 'wp_pencil', rarity: 'epic', level: 0, affixes: [], locked: false },
    };
    return save;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function buildScene(): Promise<any> {
    const { AuctionScene } = await import('../../src/scenes/AuctionScene');
    const worldApi = {
      listAuctions: async () => [],
      getMyListings: async () => [],
      getAuctionRefBand: async () => ({ ref: 10, floor: 5, ceil: 20 }),
    } as unknown as import('../../src/net/WorldApiClient').WorldApiClient;
    const save = buildSave();
    return new AuctionScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, worldApi, getSave: () => save,
    });
  }

  it('picking an item in the picker routes back to the create form with that item pre-filled', async () => {
    const { buildPickEntries, selectedItemLabel } = await import('../../src/scenes/AuctionScene/itemPickerRender');
    const scene = await buildScene();

    // Real entry point: open the create form, then tap its item field (always modalHits[0]).
    scene.createListing.openCreateForm();
    expect(scene.core.modalOpen).toBe(true);
    scene.core.modalHits[0].action();
    // openItemPicker() closes the modal and swaps the body over to the picker overlay.
    expect(scene.core.itemPickerOpen).toBe(true);
    expect(scene.core.modalOpen).toBe(false);

    // Pick the one equipment entry — pickAndReturn() → core.reopenCreateForm().
    const entry = buildPickEntries(scene.core).find((e: { cls: string }) => e.cls === 'equipment')!;
    expect(entry).toBeDefined();
    entry.onPick();

    expect(scene.core.itemPickerOpen).toBe(false);
    expect(scene.core.createEquipId).toBe('inst_A');
    // The whole point of the hook: the create form must be back on screen…
    expect(scene.core.modalOpen).toBe(true);
    // …and showing the item that was just picked (createListing.ts renders selectedItemLabel() into
    // the emphasized item field, so its presence proves openCreateForm() re-ran AFTER the pick, not
    // some stale pre-pick paint).
    const label = selectedItemLabel(scene.core);
    expect(label).not.toBeNull();
    expect(collectTexts(scene.core.modalLayer)).toContain(label);

    scene.destroy();
  });

  it('cancelling the picker (header Back) also routes back to the create form, keeping any prior selection', async () => {
    const { selectedItemLabel } = await import('../../src/scenes/AuctionScene/itemPickerRender');
    const scene = await buildScene();

    scene.core.createClass = 'material'; // a class that always has a label ("Scrap")
    scene.createListing.openCreateForm();
    scene.core.modalHits[0].action();
    expect(scene.core.itemPickerOpen).toBe(true);

    // The picker overlay replaces the body hits and rebinds the header Back button to
    // cancelItemPicker() (see AuctionScene.ts's render()).
    const backHit = scene.core.hitRects.find(
      (hh: { rect: { x: number; y: number; w: number; h: number } }) => hh.rect === scene.core.backRect,
    );
    expect(backHit).toBeDefined();
    backHit.action();

    expect(scene.core.itemPickerOpen).toBe(false);
    expect(scene.core.modalOpen).toBe(true); // returned to the form, not to the market list
    expect(collectTexts(scene.core.modalLayer)).toContain(selectedItemLabel(scene.core));

    scene.destroy();
  });

  it("the ref-band fetch's late callback repaints the open form in place (the hook's other caller)", async () => {
    const { AuctionScene } = await import('../../src/scenes/AuctionScene');
    let releaseBand!: (b: { ref: number; floor: number; ceil: number }) => void;
    const worldApi = {
      listAuctions: async () => [],
      getMyListings: async () => [],
      getAuctionRefBand: () => new Promise<{ ref: number; floor: number; ceil: number }>((r) => { releaseBand = r; }),
    } as unknown as import('../../src/net/WorldApiClient').WorldApiClient;
    const save = buildSave();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = new AuctionScene(createLayout(800, 1280), new InputManager(), {
      onBack() {}, worldApi, getSave: () => save,
    }) as any;

    scene.core.createClass = 'material';
    scene.createListing.openCreateForm(); // fires ensureRefBand('material:scrap'), still pending
    expect(scene.core.refBandLoading).toBe(true);

    releaseBand({ ref: 4242, floor: 1000, ceil: 9000 });
    await Promise.resolve();
    await Promise.resolve();

    // core.ensureRefBand's .then() calls reopenCreateForm() while modalOpen — the freshly-fetched
    // band's numbers must appear in the re-rendered form. A no-op hook leaves the form frozen on
    // its "loading…" paint until some unrelated interaction repaints it.
    expect(scene.core.refBandLoading).toBe(false);
    const texts = collectTexts(scene.core.modalLayer).join('|');
    expect(texts).toContain('4242');

    scene.destroy();
  });
});

// ── EquipmentScene: core.cancelAssignHook (header Back while the card picker is open) ────────────
//
// Core.backAction() (wired at Core-construction time, before AssignPanel exists) has to cancel the
// assign sub-mode rather than leave the scene. With the hook at its no-op default, Back does
// literally nothing while assigning: the card picker stays up and the player cannot get out of it
// without navigating away — and it must NOT fall through to cb.onBack() either.

describe('EquipmentScene — core.cancelAssignHook actually cancels the assign sub-mode', () => {
  function buildSave(): SaveData {
    const save = makeNewSave('acc_test');
    save.wallet.coins = 100000;
    save.materials = { scrap: 100, lead: 100, binding: 100 };
    save.equipmentInv = {
      inst_wp: { id: 'inst_wp', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: false },
    };
    save.cardInv = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      card1: { id: 'card1', defId: 'lichuang', level: 1, gear: {}, locked: false } as any,
    };
    return save;
  }

  it('the header Back button cancels the card picker instead of leaving the scene', async () => {
    const { EquipmentScene } = await import('../../src/scenes/EquipmentScene');
    const onBack = vi.fn();
    const save = buildSave();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = new EquipmentScene(createLayout(1280, 800), new InputManager(), {
      onBack,
      getSave: () => save,
      craft: async () => ({ ok: true }),
      enhance: async () => ({ ok: true, success: true, level: 1 }),
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '', // bag mode ⇒ Equip opens the card picker (assign sub-mode)
    }) as any;

    scene.assign.beginAssign('inst_wp', 'weapon');
    expect(scene.core.assign).toEqual({ instId: 'inst_wp', slot: 'weapon' });

    // The assembly's render() always pushes the Back hit first (rect === core.backRect).
    const backHit = scene.core.hitRects[0];
    expect(backHit.rect).toBe(scene.core.backRect);
    backHit.action();

    expect(scene.core.assign).toBeNull();     // picker cancelled…
    expect(onBack).not.toHaveBeenCalled();    // …and Back did NOT leave the scene

    // Second Back, now out of assign mode, does leave.
    scene.core.hitRects[0].action();
    expect(onBack).toHaveBeenCalledTimes(1);

    scene.destroy();
  });
});

// ── LobbyScene: core.buildHook (badges → whole-scene relayout) ───────────────────────────────────
//
// The old build.ts↔badges.ts cycle was resolved by moving rebuild() onto Core and giving it a lazy
// `buildHook`. rebuild() tears the whole container down FIRST and then calls the hook to repaint —
// so with the hook at its no-op default, any rebuild() (a live-event window opening, a wallet write
// through onSaveChanged, the coin-icon atlas settling after first paint) leaves the lobby a
// completely BLANK screen. Nothing in the suite noticed: LobbyScene's constructor calls
// `this.build.build()` directly, so the first paint never goes through the hook at all.

describe('LobbyScene — core.buildHook actually repaints after core.rebuild()', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function buildLobby(): Promise<any> {
    const { LobbyScene } = await import('../../src/scenes/LobbyScene');
    return new LobbyScene(createLayout(800, 1280), new InputManager(), {
      onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
      onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
      // The right-side strip only renders at all when onOpenDaily is wired (mainContent.ts's
      // hasSideStrip), and the events entry additionally needs onOpenEvents + core.eventsAvailable.
      onOpenDaily() {},
      onOpenEvents() {},
      playerName: 'Tester',
    });
  }

  it('applyEventsAvailable(true) relayouts the scene so the events strip entry appears', async () => {
    const scene = await buildLobby();
    // No live event window yet → mainContent.ts skips the strip entry, leaving its rect zeroed.
    expect(scene.core.eventsBtnRect.w).toBe(0);
    const childrenBefore = scene.core.container.children.length;
    expect(childrenBefore).toBeGreaterThan(0);

    // Real path: BadgesPanel.applyEventsAvailable → core.rebuild() → core.buildHook() → build().
    scene.applyEventsAvailable(true);

    // rebuild() tore the container down; the hook is the ONLY thing that paints it again.
    expect(scene.core.container.children.length).toBeGreaterThan(0);
    expect(scene.core.eventsBtnRect.w).toBeGreaterThan(0);
    expect(scene.core.eventsBtnRect.h).toBeGreaterThan(0);

    scene.destroy();
  });

  it('applyEventsAvailable(false) relayouts again and removes the entry (the hook fires both ways)', async () => {
    const scene = await buildLobby();
    scene.applyEventsAvailable(true);
    expect(scene.core.eventsBtnRect.w).toBeGreaterThan(0);

    scene.applyEventsAvailable(false);
    expect(scene.core.container.children.length).toBeGreaterThan(0);
    expect(scene.core.eventsBtnRect.w).toBe(0);

    scene.destroy();
  });

  it("the assembly's OWN unsubs array is drained on destroy (Core does not own this subscription)", async () => {
    const { LobbyScene } = await import('../../src/scenes/LobbyScene');
    const input = new InputManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scene = new LobbyScene(createLayout(800, 1280), input, {
      onStartGame() {}, onOpenCampaign() {}, onOpenRoom() {}, onOpenShop() {},
      onOpenCards() {}, onOpenStats() {}, onOpenProfile() {},
      playerName: 'Tester',
    }) as any;

    // LobbyScene is the one chain in this batch where update()/destroy()/the input.onDown
    // subscription live on the OUTER assembly rather than Core (the old mixin update() called two
    // different siblings by name) — so the assembly holds its own `unsubs`, and `core.destroy()`
    // alone would NOT unhook it. Prove the drain really happens: the handler must be dead after
    // destroy(), or a later tap fires build.handleDown on a torn-down scene (the TitlesScene leak
    // class of bug that test/input-subscription-cleanup.test.ts guards statically).
    const spy = vi.spyOn(scene.build, 'handleDown');
    const rect = scene.core.btnRect;
    input._emitDown(rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(spy).toHaveBeenCalledTimes(1);

    scene.destroy();
    spy.mockClear();
    input._emitDown(rect.x + rect.w / 2, rect.y + rect.h / 2);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── GameRenderer: EventsPanel reaching InputPanel through core.input ─────────────────────────────
//
// The conversion split the old single class into EventsPanel + InputPanel, and events.ts's engine
// event handler now reaches the input domain through `this.core.input` (a back-reference the
// assembly sets right after constructing InputPanel). The 4 events that must cancel an in-flight
// drag / tap-select (card_played, card_expired, game_over, game_draw) were tested only in isolation
// — no test ever had a drag actually in progress when one arrived, so the cross-domain half of
// those branches (the reason events.ts needs `core.input` at all) was never exercised.

describe('GameRenderer — engine events cancel an in-flight drag/tap-select through core.input', () => {
  /** ch1_lv1's deterministic opening hand — slot 2 is a shieldbearer (cost 6). Same fixture as
   *  test/ui/gameRendererInput.ui.ts; see that file's banner for why the index is safe to pin. */
  const SLOT_UNIT = 2;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function buildRenderer(): Promise<any> {
    const { GameRenderer } = await import('../../src/render/GameRenderer');
    const { createLocalMatch } = await import('../../src/app/matchEngine');
    const { getLevel } = await import('../../src/game');
    const level = getLevel('ch1_lv1')!;
    const { engine } = createLocalMatch({ level });
    const layout = createLayout(800, 1280);
    const input = new InputManager();
    const renderer = new GameRenderer(engine, layout, input);
    renderer.init();
    // Settle the staggered opening draw so hand slots are hit-testable.
    for (let i = 0; i < 5; i++) renderer.update(1 / 30);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { engine, layout, input, renderer, r: renderer as any };
  }

  /** Press a hand card and drag it onto the board WITHOUT releasing — leaves input.drag live. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function startDrag(ctx: any): void {
    const from = ctx.r.core.handView.slotCenter(SLOT_UNIT);
    const to = ctx.layout.gridToScreen(1, 1);
    ctx.input._emitDown(from.x, from.y);
    ctx.input._emitMove(to.x, to.y); // past DRAG_THRESHOLD → real card drag
    expect(ctx.r.input.drag).not.toBeNull();
  }

  /** Tap a hand card (down+up at the same point) — leaves input.tapSelect live. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function startTapSelect(ctx: any): void {
    const c = ctx.r.core.handView.slotCenter(SLOT_UNIT);
    ctx.input._emitDown(c.x, c.y);
    ctx.input._emitUp(c.x, c.y);
    expect(ctx.r.input.tapSelect?.handIndex).toBe(SLOT_UNIT);
  }

  it('card_played for the local owner drops the in-flight drag (the card is already gone)', async () => {
    const ctx = await buildRenderer();
    startDrag(ctx);
    ctx.r.events.handleEvent(
      { type: 'card_played', owner: ctx.r.core.localOwner, handIndex: SLOT_UNIT },
      ctx.engine.state,
    );
    expect(ctx.r.input.drag).toBeNull();
    ctx.renderer.destroy();
  });

  it("card_played for the OPPONENT leaves the local player's drag alone", async () => {
    const ctx = await buildRenderer();
    startDrag(ctx);
    ctx.r.events.handleEvent(
      { type: 'card_played', owner: 1 - ctx.r.core.localOwner, handIndex: SLOT_UNIT },
      ctx.engine.state,
    );
    expect(ctx.r.input.drag).not.toBeNull();
    ctx.renderer.destroy();
  });

  it('card_expired on the selected slot drops the tap-selection (the refreshed card is a different card)', async () => {
    const ctx = await buildRenderer();
    startTapSelect(ctx);
    ctx.r.events.handleEvent(
      { type: 'card_expired', owner: ctx.r.core.localOwner, handIndex: SLOT_UNIT },
      ctx.engine.state,
    );
    expect(ctx.r.input.tapSelect).toBeNull();
    ctx.renderer.destroy();
  });

  it('card_expired on a DIFFERENT slot leaves the tap-selection standing', async () => {
    const ctx = await buildRenderer();
    startTapSelect(ctx);
    ctx.r.events.handleEvent(
      { type: 'card_expired', owner: ctx.r.core.localOwner, handIndex: SLOT_UNIT + 1 },
      ctx.engine.state,
    );
    expect(ctx.r.input.tapSelect?.handIndex).toBe(SLOT_UNIT);
    ctx.renderer.destroy();
  });

  it('game_over drops an in-flight drag (no placing cards onto a finished match)', async () => {
    const ctx = await buildRenderer();
    startDrag(ctx);
    ctx.r.events.handleEvent({ type: 'game_over', winner: ctx.r.core.localOwner }, ctx.engine.state);
    expect(ctx.r.input.drag).toBeNull();
    ctx.renderer.destroy();
  });

  it('game_draw drops an in-flight tap-selection', async () => {
    const ctx = await buildRenderer();
    startTapSelect(ctx);
    ctx.r.events.handleEvent({ type: 'game_draw' }, ctx.engine.state);
    expect(ctx.r.input.tapSelect).toBeNull();
    ctx.renderer.destroy();
  });
});

// ── Hooks deliberately NOT re-tested here (already covered behaviorally) ─────────────────────────
//
// Confirmed by deleting each assembly's hook assignment and watching the EXISTING suite go red:
//   • CardScene `core.doFuse` (feed's confirm button → ActionsPanel.doFuse → FeedPanel
//     .playFusionAnim) — 14 tests in test/ui/cardFusePanel.ui.ts fail, including its
//     "end-to-end: the real animation + busy update() ticks run to completion" round trip.
//   • EquipmentScene `core.doEquipHook` (AssignPanel's card picker → DetailPanel.doEquip) —
//     test/ui/scenes.ui.ts's "bag mode: instanceActions(Equip) → … → core.doEquipHook → …" fails.
//   • EquipmentScene `core.refreshInstanceCellHook` (DetailPanel.doEnhance → InventoryPanel's
//     single-cell redraw) — test/ui/equipmentEnhanceIncrementalRedraw.ui.ts's first case fails,
//     because the no-op default returns false and doEnhance falls back to a full render(), which
//     replaces the cell containers the test pins by identity. (Under the default worker pool that
//     fallback happens to exhaust the worker's heap before the assertion reports; `--pool=threads`
//     shows the intended clean `Object.is` failure. Either way the file goes red.)
//   • GameRenderer `core.input` / `core.events` back-references — 14 tests across
//     gameRendererInput/SpellInput/SurrenderRace/gameScenes fail (Core's own onDown/onMove/onUp
//     closures go through `this.input`).
//   • FamilyScene's actions↔input MERGE (doSendMsg/submitMessage moved onto InputPanel) — see the
//     "merged text-entry + send unit" describe in test/familySendButton.test.ts.
//   • WorldMapRenderer's hoisted pool+city+fog bundle and injected `refreshMap` closures — see
//     test/ui/worldMapRefreshBundle.ui.ts.
