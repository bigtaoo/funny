// WorldMapNet's live-push handlers (worldsvc → gateway → NetSession → here, §14.5), extracted as
// form① free functions (claudedocs/client-modules.md "单文件 500 行收敛"). Wired by createAppCore:
// it points session.handlers at these (via WorldMapNet's thin delegating methods) while the world
// map is on-screen. Each one does a targeted authoritative refetch then redraws — cheaper than
// hand-merging the push payload into the cached views.
import { t } from '../../../i18n';
import { ui as C } from '../../../render/sketchUi';
import { serverNow } from '../../../net/serverClock';
import type { MarchUpdate, TileUpdate, UnderAttack, SiegeResult, NationMsg } from '../../../net/proto/transport';
import type { WorldMapContext } from '../WorldMapContext';
import { loadMapViewport, refreshMarches, refreshMe } from './loaders';

export function applyMarchUpdate(ctx: WorldMapContext, _m: MarchUpdate): void {
  if (ctx.destroyed) return;
  void refreshMarches(ctx);
}

/**
 * Real-time world/nation channel message (gateway push, worldsvc → gateway). Previously dropped
 * entirely (client had no onNationMsg handler) while a 5s poll (refreshWorldChat) re-fetched the
 * same data — this updates the HUD's latest-message + unread count immediately from the push
 * payload instead of waiting on the next poll tick.
 */
export function applyNationMsg(ctx: WorldMapContext, n: NationMsg): void {
  if (ctx.destroyed) return;
  ctx.worldChatLatest = { id: `push:${n.ts}:${n.fromPublicId}`, senderId: n.fromPublicId, senderPublicId: n.fromPublicId, senderName: n.fromName, body: n.text, ts: n.ts };
  if (n.ts > ctx.getWorldChatSeenTs()) ctx.worldChatUnread += 1;
  if (!ctx.destroyed) ctx.panels.renderHud();
}

export function applyTileUpdate(ctx: WorldMapContext, tu: TileUpdate): void {
  if (ctx.destroyed) return;
  // D-CITY-8: flag whether this push is our own main base losing durability, so the full-screen
  // vignette flash (WorldMapRenderer/vignette.ts) can fire once the fresh hp value is in cache.
  // TileUpdate itself carries no hp field (see transport.proto), so we diff the cached view before/after.
  const isOwnBase = !!ctx.me?.mainBaseTile && tu.tileId === ctx.me.mainBaseTile;
  const [bx, by] = isOwnBase ? ctx.parseTileId(tu.tileId) : [0, 0];
  const prevHp = isOwnBase ? ctx.tileCache.get(`${bx}:${by}`)?.hp : undefined;
  void loadMapViewport(ctx).then(() => {
    if (ctx.destroyed) return;
    if (isOwnBase) {
      const nowHp = ctx.tileCache.get(`${bx}:${by}`)?.hp;
      if (prevHp != null && nowHp != null && nowHp < prevHp) ctx.view.flashDamageVignette();
    }
    ctx.view.renderMap();
  });
}

export function applyUnderAttack(ctx: WorldMapContext, u: UnderAttack): void {
  if (ctx.destroyed) return;
  const [tx, ty] = ctx.parseTileId(u.tile);
  const sec = Math.max(0, Math.ceil((u.arriveAt - serverNow()) / 1000));
  const name = u.attackerName || ('#' + (u.attackerPublicId || '?'));
  // Routed through t()'s own param substitution rather than chained String.replace(str, str)
  // calls (2026-08-03 fix): `name` is an attacker-controlled display name, and replace's second
  // argument is a *pattern* string — a name containing literal `$&`/`` $` ``/`$'` would have been
  // interpreted as a special replacement token instead of inserted verbatim.
  ctx.panels.showToast(
    `${t('world.underAttack')} ${t('world.underAttackMsg', { name, tile: `(${tx},${ty})`, sec })}`,
    C.red,
  );
}

export async function applySiegeResult(ctx: WorldMapContext, s: SiegeResult): Promise<void> {
  if (ctx.destroyed) return;
  // The attacking march is about to drop off `ctx.marches` (refreshMarches below) and get torn
  // down by fog.ts syncMarchTokens — mark it to keep playing 'attacking' a beat longer instead
  // of vanishing instantly. Default duration covers the case the .tao asset hasn't loaded yet.
  if (s.marchId) {
    const entry = ctx.marchTokenRuntimes.get(s.marchId);
    if (entry) {
      // A 'dot' LOD token has no clip/duration concept — it's a static sprite, so the default
      // beat below covers it (its container is torn down the same as a stickman's either way).
      const durSec = (entry.mode === 'stickman' && entry.runtime?.currentDuration) || 0.6;
      ctx.marchAttackUntil.set(s.marchId, Date.now() + durSec * 1000);
    }
  }
  // Ownership / resources / troops may all have shifted — refetch before classifying (2026-08-09:
  // this can no longer be a fire-and-forget side effect like refreshMe/refreshMarches below — the
  // attack-win branch needs the freshly-refetched target tile's `contestedByMe` to tell an
  // occupation-hold start apart from an instant final outcome).
  await loadMapViewport(ctx);
  if (ctx.destroyed) return;
  ctx.view.renderMap();
  void refreshMe(ctx);
  void refreshMarches(ctx);

  // Role classification is server-authoritative (2026-08-02 bug fix, transport.proto SiegeResult):
  // previously this guessed "did I dispatch this march" from a per-scene, in-memory Set
  // (myAttackTiles/myOccupyTiles) populated only at dispatch time — reset on every WorldMapScene
  // rebuild (leaving and re-entering the SLG, or a page reload) while the march was still in
  // flight, misreading the player's own occupy win as a defensive loss ("Territory lost"). `s`
  // now always carries who dispatched the offensive march and what kind it was, so the client
  // never needs to remember its own past action.
  const amInitiator = s.attackerId === ctx.cb.accountId;
  if (amInitiator && s.marchKind === 'attack') {
    // 2026-08-09 (user decision): a territory (or occupation-expulsion) win no longer hands over
    // ownership instantly — it starts the same OCCUPY_HOLD_SEC hold as occupying neutral land
    // (worldsvc combatSiege/arrival.ts landSiege §territory branch, occupation.ts
    // applyOccupationExpulsion). The just-refetched target tile's `contestedByMe` is the
    // server-authoritative signal for that (identical to how the occupy branch below already
    // distinguishes its own win): show the same lightweight toast instead of a blocking "Siege
    // won!" modal. A base siege / structure chip / PvE stronghold-or-crossing capture is still an
    // instant final outcome (no contestedByMe) and keeps the outcome + replay & verify modal.
    const [tx, ty] = ctx.parseTileId(s.tile);
    const tile = ctx.tileCache.get(`${tx}:${ty}`);
    if (s.outcome === 'attacker_win' && tile?.contestedByMe) {
      ctx.panels.showToast(t('world.siegeWinHold'), C.dark);
    } else {
      const loot = s.lootSummary ?? '';
      const line = s.outcome === 'attacker_win' ? t('world.siegeWin').replace('{loot}', loot)
        : s.outcome === 'defender_win' ? t('world.siegeLoss')
        : t('world.siegeDraw');
      ctx.panels.showModal(
        [{ text: line, icon: 'swords' }],
        [
          { label: t('world.replaySiege'), action: () => { ctx.panels.closeModal(); ctx.cb.onReplaySiege(s.siegeId); }, icon: 'replay' },
          { label: t('common.close'), action: () => ctx.panels.closeModal(), icon: 'close' },
        ],
      );
    }
  } else if (amInitiator && s.marchKind === 'occupy') {
    // We launched an occupy (PvE land-grab, ADR-037). It reports back as a SiegeResult but is our own action —
    // a win begins the occupation hold, a non-win means the NPC garrison held. Lightweight toast (no replay
    // modal): occupy is high-frequency expansion, unlike a deliberate PvP siege.
    const line = s.outcome === 'attacker_win' ? t('world.occupyWin') : t('world.occupyLoss');
    ctx.panels.showToast(line, s.outcome === 'attacker_win' ? C.dark : C.red);
  } else if (amInitiator && s.marchKind === 'move') {
    // §51's residual gap, closed (SLG_DESIGN_LOG §53): a field encounter (ADR-051 §2.2,
    // server/worldsvc/src/combatSiege/encounter.ts) — our marching team bumped an enemy stationed team /
    // another march / a garrison mid-transit and fought on the spot. No territory changes hands (that's
    // occupy's job), just a skirmish outcome for the marcher — its own branch, correct win/loss valence.
    const line = s.outcome === 'attacker_win' ? t('world.encounterWin') : t('world.encounterLoss');
    ctx.panels.showToast(line, s.outcome === 'attacker_win' ? C.dark : C.red);
  } else {
    // We were the defender (or a bystander) — toast only.
    const line = s.outcome === 'attacker_win' ? t('world.defendLost') : t('world.defendHeld');
    ctx.panels.showToast(line, s.outcome === 'attacker_win' ? C.red : C.dark);
  }
}
