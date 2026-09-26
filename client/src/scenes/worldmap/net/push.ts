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
import { formatDuration } from '../logic/formatDuration';

/**
 * How long a `marching` push waits for the HTTP response of the order that caused it. worldsvc fires
 * the push to the dispatcher before answering the request, and it travels an extra hop (gateway WS), so
 * the two usually land within a few tens of ms of each other in either order.
 */
export const OWN_ORDER_GRACE_MS = 300;

export function applyMarchUpdate(ctx: WorldMapContext, m: MarchUpdate): void {
  if (ctx.destroyed) return;
  // Arrivals, recalls-by-encounter, settlements: always news. Re-read.
  if (m.status !== 'marching') {
    void refreshMarches(ctx);
    return;
  }
  // 2026-09-26: a `marching` push is usually the echo of the player's own dispatch/recall, and that
  // order's HTTP response puts the exact same march into `ctx.marches` (doMarchTeam appends it; recall
  // re-reads). Re-reading all four order slices for it was a quarter of every dispatch's request budget
  // — see rateGate.ts. The response may land after the push, so decide once the grace has passed.
  setTimeout(() => {
    if (!ctx.destroyed && !describesCachedMarch(ctx, m)) void refreshMarches(ctx);
  }, OWN_ORDER_GRACE_MS);
}

/** The push says nothing the cache doesn't already: same march, same leg, same state. */
function describesCachedMarch(ctx: WorldMapContext, m: MarchUpdate): boolean {
  return ctx.marches.some((c) =>
    c.marchId === m.marchId && c.kind === m.kind && c.status === m.status
    && c.toTile === m.toTile && c.arriveAt === m.arriveAt);
}

/**
 * Real-time world/nation channel message (gateway push, worldsvc → gateway). Previously dropped
 * entirely (client had no onNationMsg handler) while a 5s poll re-fetched the same data — this
 * updates the HUD's latest-message + unread count immediately from the push payload instead. That
 * poll is gone (P1-2, comm-audit-2026-07-27), so this is now the ONLY thing that advances the HUD
 * chat line while the map is open; the initial value comes from `/world/enter`'s `worldChannel`
 * page (net/loaders.ts loadData), so the line is never blank waiting on a first push.
 */
export function applyNationMsg(ctx: WorldMapContext, n: NationMsg): void {
  if (ctx.destroyed) return;
  ctx.worldChatLatest = { id: `push:${n.ts}:${n.fromPublicId}`, senderId: n.fromPublicId, senderPublicId: n.fromPublicId, senderName: n.fromName, body: n.text, ts: n.ts };
  if (n.ts > ctx.getWorldChatSeenTs()) ctx.worldChatUnread += 1;
  if (!ctx.destroyed) ctx.panels.renderHud();
}

/**
 * Per-scene state of the coalesced tile refetch (see applyTileUpdate). Keyed weakly by ctx so a torn-down
 * scene takes its state with it, and a rebuilt scene starts clean.
 */
interface TileRefetch {
  /** A viewport refetch is on the wire. */
  running: boolean;
  /** A push arrived that the refetch on the wire (if any) may predate — one more is owed. */
  dirty: boolean;
  /** Our own base's hp as cached when the first not-yet-refetched push for it arrived; null if none is pending. */
  basePrevHp: { key: string; hp: number | undefined } | null;
}
const tileRefetches = new WeakMap<WorldMapContext, TileRefetch>();

/**
 * A tile changed somewhere — re-read the viewport. Coalesced (2026-09-26, WORLDSVC_CONCURRENCY_AUDIT §12.6):
 * each push used to fire its own full-viewport `GET /world/map`, so a fight near the camera (one push per
 * settled hit, per occupation tick, per neighbouring player) queued a read per push behind the client's
 * 5 req/s gate — the same bucket drain that delayed dispatches before §12. Now at most one refetch is on the
 * wire; pushes landing meanwhile mark it dirty and cost exactly one more refetch after it, which re-reads
 * the viewport AFTER all of them. Any number of pushes → at most two reads, and the last one is fresh.
 */
export function applyTileUpdate(ctx: WorldMapContext, tu: TileUpdate): void {
  if (ctx.destroyed) return;
  let st = tileRefetches.get(ctx);
  if (!st) { st = { running: false, dirty: false, basePrevHp: null }; tileRefetches.set(ctx, st); }
  // D-CITY-8: flag whether this push is our own main base losing durability, so the full-screen
  // vignette flash (WorldMapRenderer/vignette.ts) can fire once the fresh hp value is in cache.
  // TileUpdate itself carries no hp field (see transport.proto), so we diff the cached view before/after.
  // The "before" is captured HERE, at push time, not when the refetch starts: a refetch already on the
  // wire may land this very hit in cache first, and a later snapshot would then diff it away.
  if (!st.basePrevHp && ctx.me?.mainBaseTile && tu.tileId === ctx.me.mainBaseTile) {
    const [bx, by] = ctx.parseTileId(tu.tileId);
    const key = `${bx}:${by}`;
    st.basePrevHp = { key, hp: ctx.tileCache.get(key)?.hp };
  }
  st.dirty = true;
  if (!st.running) void drainTileRefetch(ctx, st);
}

async function drainTileRefetch(ctx: WorldMapContext, st: TileRefetch): Promise<void> {
  st.running = true;
  try {
    while (st.dirty && !ctx.destroyed) {
      st.dirty = false;
      const base = st.basePrevHp;
      st.basePrevHp = null;
      await loadMapViewport(ctx);
      if (ctx.destroyed) return;
      if (base) {
        const nowHp = ctx.tileCache.get(base.key)?.hp;
        if (base.hp != null && nowHp != null && nowHp < base.hp) ctx.view.flashDamageVignette();
      }
      ctx.view.renderMap();
    }
  } finally {
    st.running = false;
  }
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
  // this can no longer be a fire-and-forget side effect like refreshMe below — the attack-win branch
  // needs the freshly-refetched target tile's `contestedByMe` to tell an occupation-hold start apart
  // from an instant final outcome). 2026-09-12 (围攻驻留): the order slices are awaited for the same
  // reason — a base/city win is told apart from a final one by whether `ctx.siegeHolds` now carries a
  // hold under this siege's id, and the server wrote that document before it pushed this result.
  await Promise.all([loadMapViewport(ctx), refreshMarches(ctx)]);
  if (ctx.destroyed) return;
  ctx.view.renderMap();
  void refreshMe(ctx);

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
    // won!" modal.
    //
    // 2026-09-12 (user decision, 围攻驻留): beating another player's MAIN BASE reads the same way — it
    // was never an instant outcome either (the garrison falling only schedules a durability hit
    // SLG_SIEGE_DAMAGE_DELAY_MS out, ADR-026 §4), so the blocking "Siege won!" modal was announcing a
    // result that had not happened yet and interrupting the player to do it. Its signal is a fresh
    // `siegeHolds` entry under this siege's id — the same "ask the server what state the win left
    // behind" shape as `contestedByMe`, and it covers the wild-city ladder (ADR-074 P1) too.
    //
    // What still earns a modal: an instant final outcome — a structure chip, a PvE
    // stronghold-or-crossing capture, and every LOSS (the replay is the point of a loss).
    const [tx, ty] = ctx.parseTileId(s.tile);
    const tile = ctx.tileCache.get(`${tx}:${ty}`);
    const hold = ctx.siegeHolds.find((h) => h.siegeId === s.siegeId) ?? null;
    if (s.outcome === 'attacker_win' && hold) {
      ctx.panels.showToast(
        t(hold.isBase ? 'world.siegeWinBaseHold' : 'world.siegeWinCityHold')
          .replace('{time}', formatDuration((hold.dueAt - serverNow()) / 1000))
          .replace('{dmg}', String(hold.damage)),
        C.dark,
      );
    } else if (s.outcome === 'attacker_win' && tile?.contestedByMe) {
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
