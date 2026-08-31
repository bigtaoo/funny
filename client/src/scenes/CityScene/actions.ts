// CitySceneCore's async network actions (upgrade/speedup building, train/speedup-training,
// fill-all-teams), extracted as form① free functions (claudedocs/client-modules.md "单文件 500 行
// 收敛") — same "no Core delegate, explicit params" shape as EquipmentScene/helpers.ts's precedent.
// `me` is a getter/setter pair (not a plain property) because doFillAllTeams reassigns it directly
// (a partial cardState/troops patch that deliberately does NOT go through setMe()'s
// meLoadedAt-stamping, since it isn't a fresh server fetch) — a plain copied property would only
// rebind this throwaway host object, never reaching back to CitySceneCore's own field (same
// reasoning as RoomScene/views.ts's RoomViewHost). `bt`/`cb`/`teams` are plain readonly references:
// `bt` is only ever called (.start()/.stop()/.busy), `teams`/`cb` are only ever read.
import { t } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import type { BuildingKey, TeamTemplate, PlayerWorldView } from '../../net/WorldApiClient';
import { troopCap, cardPower } from '../../game/meta/cardDefs';
import { BUILD_SPEEDUP_SECS_PER_COIN } from '@nw/shared';
import { BusyTracker } from '../../ui/busyTracker';
import { serverNow } from '../../net/serverClock';
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import { teamSlotId, TEAM_CAP } from '../../game/meta/teamTroops';
import type { CitySceneCallbacks } from './core';

export interface ActionsHost {
  readonly bt: BusyTracker;
  readonly cb: CitySceneCallbacks;
  readonly teams: TeamTemplate[];
  me: PlayerWorldView | null;
  /** Assign `me` and stamp the sim baseline — see CitySceneCore.setMe's doc comment. */
  setMe(me: PlayerWorldView): void;
  render(): void;
  showToast(msg: string, color?: number): void;
}

export async function doUpgrade(host: ActionsHost, key: BuildingKey): Promise<void> {
  if (host.bt.busy) return;
  host.bt.start();
  host.render();
  try {
    host.setMe(await host.cb.worldApi.upgradeBuilding(host.cb.worldId, key));
    host.showToast(t('city.upgrading'), C.green as number);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('resources')) host.showToast(t('city.err.noResources'), C.red as number);
    else if (msg.includes('queue')) host.showToast(t('city.err.queueFull'), C.red as number);
    else if (msg.includes('desk')) host.showToast(t('city.err.deskGate'), C.red as number);
    else host.showToast(t('city.err.generic'), C.red as number);
  } finally {
    host.bt.stop();
  }
  host.render();
}

export async function doSpeedup(host: ActionsHost, key: BuildingKey): Promise<void> {
  if (host.bt.busy) return;
  const entry = host.me?.buildQueue?.find((q) => q.key === key);
  if (!entry) return;
  // serverNow() (P1-1): this determines how many coins are actually charged, so it must use the
  // same server-corrected clock as the price the player was shown (render.ts's renderBuildQueue) —
  // a client with a fast/slow local clock would otherwise over/under-charge relative to the
  // server's real remaining time (comm-audit-2026-07-27 finding).
  const secsLeft = Math.max(0, Math.ceil((entry.completeAt - serverNow()) / 1000));
  const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
  host.bt.start();
  host.render();
  try {
    host.setMe(await host.cb.worldApi.speedupBuild(host.cb.worldId, key, coins));
    // The coins were charged server-side and the response above carries only the world state —
    // pull the deducted balance back into the local wallet cache (see CitySceneCallbacks.refreshWallet).
    await host.cb.refreshWallet?.();
    host.showToast(t('city.speedupDone'), C.green as number);
  } catch {
    host.showToast(t('city.err.generic'), C.red as number);
  } finally {
    host.bt.stop();
  }
  host.render();
}

export async function doTrain(host: ActionsHost, qty: number): Promise<void> {
  if (host.bt.busy || qty <= 0) return;
  host.bt.start();
  host.render();
  try {
    host.setMe(await host.cb.worldApi.trainTroops(host.cb.worldId, qty));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('cap')) host.showToast(t('city.err.troopCap'), C.red as number);
    else if (msg.includes('queue')) host.showToast(t('city.err.trainQueueFull'), C.red as number);
    else if (msg.includes('Insufficient'))
      host.showToast(t('city.err.noResources'), C.red as number);
    else host.showToast(t('city.err.generic'), C.red as number);
  } finally {
    host.bt.stop();
  }
  host.render();
}

export async function doSpeedupTraining(host: ActionsHost, coins: number): Promise<void> {
  if (host.bt.busy) return;
  host.bt.start();
  host.render();
  try {
    host.setMe(await host.cb.worldApi.speedupTraining(host.cb.worldId, coins));
    // Same as doSpeedup above — resync the wallet after the server-side charge.
    await host.cb.refreshWallet?.();
    host.showToast(t('city.speedupDone'), C.green as number);
  } catch {
    host.showToast(t('city.err.generic'), C.red as number);
  } finally {
    host.bt.stop();
  }
  host.render();
}

/**
 * "填满所有队伍" — distribute the home troop pool across all 5 teams in slot order (t1..t5),
 * highest combat-power card first within each team (mirrors DefenseEditorScene's §6.5 一键补满).
 * A team only takes what's left in the pool once earlier teams are topped up, so an exhausted
 * pool partially fills whichever team is next in line and leaves the rest untouched.
 */
export async function doFillAllTeams(host: ActionsHost): Promise<void> {
  if (host.bt.busy) return;
  const save = host.cb.getSave?.() as SaveData | undefined;
  const cardInv = save?.cardInv ?? {};
  const equipmentInv = save?.equipmentInv ?? {};
  const cardState = host.me?.cardState ?? {};
  let pool = host.me?.troops ?? 0;
  const allocations: Record<string, number> = {};
  const filledTeamIds = new Set<string>();

  for (let i = 0; i < TEAM_CAP && pool > 0; i++) {
    const team = host.teams.find((tm) => tm.id === teamSlotId(i));
    if (!team) continue;
    const placed = team.army
      .filter((e) => !!e.cardInstanceId)
      .map((e) => ({ id: e.cardInstanceId!, card: cardInv[e.cardInstanceId!] }))
      .filter((x): x is { id: string; card: CardInstance } => !!x.card);
    if (placed.length === 0) continue;
    placed.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));
    for (const { id, card } of placed) {
      if (pool <= 0) break;
      const current = cardState[id]?.currentTroops ?? 0;
      const gap = Math.max(0, troopCap(card) - current);
      if (gap <= 0) continue;
      const amount = Math.min(gap, pool);
      allocations[id] = amount;
      pool -= amount;
      filledTeamIds.add(team.id);
    }
  }

  if (Object.keys(allocations).length === 0) {
    host.showToast(t('city.military.fillAllTeamsNone'), C.red as number);
    return;
  }

  host.bt.start();
  host.render();
  try {
    await host.cb.worldApi.distributeTroops(host.cb.worldId, allocations);
    let total = 0;
    const nextCardState = { ...cardState };
    for (const [id, amount] of Object.entries(allocations)) {
      total += amount;
      const cs = nextCardState[id];
      nextCardState[id] = { ...cs, currentTroops: (cs?.currentTroops ?? 0) + amount };
    }
    if (host.me)
      host.me = { ...host.me, troops: (host.me.troops ?? 0) - total, cardState: nextCardState };
    host.showToast(
      t('city.military.fillAllTeamsDone')
        .replace('{n}', String(total))
        .replace('{teams}', String(filledTeamIds.size)),
      C.green as number
    );
  } catch {
    host.showToast(t('city.err.generic'), C.red as number);
  } finally {
    host.bt.stop();
  }
  host.render();
}
