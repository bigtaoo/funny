// Where a finished campaign battle leads (ONBOARDING_DESIGN §13 / §15 / §17): the result screen's
// buttons, the level-chain banner over a first clear, and the card-name lookups those two show.
// Split out of campaignRoster.ts for the 500-line rule (claudedocs/client-modules.md); the navigation
// it triggers comes in as callbacks, so this module never reaches back into that closure.
import { getLevel, CAMPAIGN_LEVEL_ORDER, type LevelDefinition, type OwnerId, type PlayerStats, type Replay } from '../../../game';
import { CARD_DEFINITIONS } from '@nw/engine/config';
import { t, type TranslationKey } from '../../../i18n';
import { HERO_GIFT_LEVEL_ID } from '@nw/shared/onboarding';
import type { ChainBannerHost } from '../../../render/ChainBanner';
import type { UnlockCalloutEntry } from '../../../render/GameRenderer/unlockCallout';
import { resolveRealLayerInterlude } from '../../../scenes/realLayerInterludeArt';
import { nextLevelAfterWin, NEXT_LEVEL_AUTO_SEC, CHAIN_AUTO_SEC, CHAIN_RESULT_EVERY } from './nextLevel';
import type { AppCtx } from '../../appCtx';

/**
 * The first five campaign levels — the stretch the anonymous funnel follows level by level, that
 * shows no midgame ad, and whose first clears get the compact result (ONBOARDING_DESIGN §15).
 */
const EARLY_LEVEL_COUNT = 5;
export function isEarlyLevel(levelId: string): boolean {
  const i = CAMPAIGN_LEVEL_ORDER.indexOf(levelId);
  return i >= 0 && i < EARLY_LEVEL_COUNT;
}

/**
 * Cards a level adds over the one before it, by display name — a second copy of a card already in
 * hand is not "new" (ch1 lv4/6/7/8 add those). The first level has nothing to compare against.
 */
export function newCardsFor(levelId: string): { newCards?: string[] } {
  const idx = CAMPAIGN_LEVEL_ORDER.indexOf(levelId);
  const prev = idx > 0 ? getLevel(CAMPAIGN_LEVEL_ORDER[idx - 1]!) : null;
  const cur = getLevel(levelId);
  if (!prev?.loadout || !cur?.loadout) return {};
  const keyOf = (id: string): string | undefined => CARD_DEFINITIONS.find((c) => c.id === id)?.nameKey;
  const had = new Set(prev.loadout.map(keyOf));
  const fresh = [...new Set(cur.loadout.map(keyOf))].filter((k): k is string => !!k && !had.has(k));
  return fresh.length > 0 ? { newCards: fresh.map((k) => t(k as TranslationKey)) } : {};
}

/**
 * Callouts for a level's mid-battle card unlocks (ONBOARDING_DESIGN §17.4), until it is first cleared.
 * On the hero-gift level the hero's callout also says the card is the player's from tomorrow.
 */
export function unlockCalloutsFor(
  levelId: string, unlocks: readonly { cardId: string }[] | undefined, cleared: readonly string[],
): { unlockCallouts?: UnlockCalloutEntry[] } {
  if (!unlocks?.length || cleared.includes(levelId)) return {};
  const entries = unlocks.flatMap((u) => {
    const key = CARD_DEFINITIONS.find((c) => c.id === u.cardId)?.nameKey;
    if (!key) return [];
    const name = t(key as TranslationKey);
    return levelId === HERO_GIFT_LEVEL_ID
      ? [{ cardId: u.cardId, title: t('heroGift.battle.title', { name }), body: t('heroGift.battle.body', { name }) }]
      : [{ cardId: u.cardId, title: t('battle.newCard.title', { name }), body: t('battle.newCard.body') }];
  });
  return entries.length > 0 ? { unlockCallouts: entries } : {};
}

/** The finished battle, as campaignRoster's onGameEnd has settled it. */
export interface CampaignOutcome {
  levelId: string;
  /** The level as authored — `assistOnLoss` lives here, not on the assisted copy. */
  base: LevelDefinition;
  /** The level as played (the assisted copy on an easier retry). */
  level: LevelDefinition;
  winner: OwnerId | null;
  stats: [PlayerStats, PlayerStats];
  kept: Replay | undefined;
  stars: number;
  /** Read before recordClear. */
  firstClear: boolean;
  banner: ChainBannerHost | undefined;
}

/** The navigation the result can lead to — campaignRoster's own closures. */
export interface CampaignResultNav {
  goCampaignMap(): void;
  goLevelPrep(levelId: string): void;
  retryAssisted(levelId: string): void;
  chainInto(nextId: string): void;
}

export function routeCampaignResult(ctx: Pick<AppCtx, 'nav' | 'views' | 'platform'>, go: CampaignResultNav, o: CampaignOutcome): void {
  const { nav, views, platform } = ctx;
  const { levelId, base, level, winner, stats, kept, stars, firstClear, banner } = o;
  const outroTexts = winner === 0 && level.story?.outroKey ? [t(level.story.outroKey as TranslationKey)] : undefined;
  // Each chapter's last level (chN_lv10.json) carries a `realLayerKey` — the Tao/Anna
  // "real layer" beat for that chapter (world.md「章末真实层」). Shown as its own
  // illustrated interlude after the result panel, before actually returning to the map;
  // every other level (or a non-win) has no interlude, so `proceedToMap` is just
  // `goCampaignMap` (see resolveRealLayerInterlude's own unit tests for the branching).
  const interlude = resolveRealLayerInterlude(level, winner);
  const proceedToMap = interlude
    ? () => views.showRealLayerInterlude(interlude.illustrationUrl, interlude.textKey, { onFinish: () => go.goCampaignMap() })
    : () => go.goCampaignMap();
  // A lost level offers the retry first (through level prep, which charges the stamina) and
  // keeps the map one tap away — before, a defeat only had "back to map".
  // No midgame ad around the first five levels (ONBOARDING_DESIGN §15.5).
  const early = isEarlyLevel(levelId);
  const toMap = { label: t('result.backToMap'), icon: 'mapPin' as const, onTap: proceedToMap };
  if (winner !== 0 && base.assistOnLoss) {
    // The first levels lead with the easier retry (§17.2) — the human funnel showed most first
    // losses never came back for a second attempt at the same difficulty.
    void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroTexts,
      () => go.retryAssisted(levelId), t('result.retryEasier'), undefined,
      toMap, undefined,
      { skipAd: early, extraSecondary: { label: t('result.retry'), icon: 'replay', onTap: () => go.goLevelPrep(levelId) } });
    return;
  }
  if (winner !== 0) {
    void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroTexts,
      () => go.goLevelPrep(levelId), t('result.retry'), undefined,
      toMap, undefined, { skipAd: early });
    return;
  }
  // A clear offers the next level first and keeps the map one tap away (ONBOARDING_DESIGN §13).
  const nextId = nextLevelAfterWin(levelId, stars > 0 || !firstClear, !!interlude);
  if (!nextId) {
    void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroTexts, proceedToMap, t('result.backToMap'),
      undefined, undefined, undefined, { skipAd: early });
    return;
  }
  // A first clear rolls straight on into the next level from a banner over this battle (§17.3) —
  // no result screen, no prep screen, no ad — except on every CHAIN_RESULT_EVERY-th level (lv5,
  // lv10, …), which keeps the full result screen: stars, rewards, the way to the map.
  // The pair to goCampaign's onGameplayStart is sent here, since goResult (which sends it
  // otherwise) is skipped.
  const nextLevel = getLevel(nextId);
  if (banner && firstClear && stars > 0 && !outroTexts && nextLevel && (CAMPAIGN_LEVEL_ORDER.indexOf(levelId) + 1) % CHAIN_RESULT_EVERY !== 0) {
    platform.onGameplayStop();
    banner.showChainBanner({
      stars,
      nextName: t(nextLevel.nameKey as TranslationKey),
      ...newCardsFor(nextId),
      autoSec: CHAIN_AUTO_SEC,
      onNext: () => go.chainInto(nextId),
      onMap: proceedToMap,
    });
    return;
  }
  // The first clear of an early level gets the compact screen with an "up next" teaser (§15.4).
  const nextKey = nextLevel?.nameKey;
  // The hero-gift level's first clear also says the trial hero is theirs from tomorrow (§17.4).
  const giftLine = firstClear && levelId === HERO_GIFT_LEVEL_ID ? t('heroGift.result', { name: t('card.max.name') }) : undefined;
  const firstWin = early && firstClear && nextKey
    ? { nextName: t(nextKey as TranslationKey), ...(giftLine ? { giftLine } : {}) }
    : undefined;
  // No detour here any more (ONBOARDING_DESIGN §15.2): the reward loop waits for the player's own
  // first trip to the lobby — routing the ch1_lv2 win there cut lv3 starts from 72% to 19%.
  void nav.goResult(winner, stats, 0, kept, undefined, undefined, outroTexts,
    () => go.goLevelPrep(nextId), t('result.nextLevel'), undefined,
    toMap,
    firstClear ? NEXT_LEVEL_AUTO_SEC : undefined, { skipAd: early, ...(firstWin ? { firstWin } : {}) });
}
