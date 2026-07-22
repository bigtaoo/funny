// UI coverage for RechargeScene (GACHA_DESIGN §13, ADR-045): login-required guard, tier state
// rendering (locked/claimable/claimed), claim button interaction, and shop-group peer tab parity
// (same [Shop|Coins?|Gacha|BattlePass?] rail convention as BattlePassScene — see shopGroupTabs.ui.ts).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { RechargeScene, type RechargeCallbacks } from '../../src/scenes/RechargeScene';
import { RECHARGE_TIERS } from '../../src/game/balance/rechargeTierDefs';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

type Hit = { rect: { x: number; y: number; w: number; h: number }; fn: () => void };

// Accumulates x/y down the tree so the returned position is in scene-container (screen) space —
// the same space hit rects use. Matters since tier cards now live inside a scrolled `scrollContainer`
// (offset by bodyTopY - scrollY); a plain node.x/node.y would be local to that container and miss.
function findLabelPos(container: PIXI.Container, label: string): { x: number; y: number } | null {
  let found: { x: number; y: number } | null = null;
  const walk = (node: PIXI.Container, px: number, py: number): void => {
    if (found) return;
    const gx = px + node.x;
    const gy = py + node.y;
    if (node instanceof PIXI.Text && node.text === label) { found = { x: gx, y: gy }; return; }
    for (const c of node.children) walk(c as PIXI.Container, gx, gy);
  };
  walk(container, 0, 0);
  return found;
}

function tapLabel(scene: { container: PIXI.Container }, label: string): void {
  const pos = findLabelPos(scene.container, label);
  expect(pos, `label "${label}" not found in rendered tree`).not.toBeNull();
  const hits = (scene as unknown as { hits: Hit[] }).hits;
  const hit = hits.find(({ rect: r }) =>
    pos!.x >= r.x && pos!.x <= r.x + r.w && pos!.y >= r.y && pos!.y <= r.y + r.h);
  expect(hit, `no hit rect under label "${label}"`).toBeDefined();
  hit!.fn();
}

const SHOP = t('shop.title');
const GACHA = t('gacha.title');
const BATTLEPASS = t('battlepass.title');
const CLAIM = t('recharge.claim');
const CLAIMED = t('recharge.claimed');
const LOCKED = t('recharge.locked');
const LOGIN_REQUIRED = t('recharge.loginRequired');

function buildRecharge(cb: Partial<RechargeCallbacks>): RechargeScene {
  return new RechargeScene(createLayout(800, 1280), new InputManager(), {
    onBack() {},
    getCoins: () => 1000,
    ...cb,
  });
}

describe('RechargeScene — auth guard', () => {
  it('shows a login-required message when getData is absent (offline / not logged in)', () => {
    const scene = buildRecharge({});
    expect(findLabelPos(scene.container, LOGIN_REQUIRED)).not.toBeNull();
    scene.destroy();
  });

  it('does not show the login-required message when getData is provided', () => {
    const scene = buildRecharge({ getData: () => ({ totalRechargeCents: 0, claimed: [] }) });
    expect(findLabelPos(scene.container, LOGIN_REQUIRED)).toBeNull();
    scene.destroy();
  });
});

describe('RechargeScene — tier states', () => {
  it('a tier below the cumulative-spend threshold shows Locked, not Claim', () => {
    const scene = buildRecharge({ getData: () => ({ totalRechargeCents: 0, claimed: [] }) });
    expect(findLabelPos(scene.container, LOCKED)).not.toBeNull();
    expect(findLabelPos(scene.container, CLAIM)).toBeNull();
    scene.destroy();
  });

  it('a reached, unclaimed tier shows a Claim button', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const scene = buildRecharge({ getData: () => ({ totalRechargeCents: tier1.thresholdCents, claimed: [] }) });
    expect(findLabelPos(scene.container, CLAIM)).not.toBeNull();
    scene.destroy();
  });

  it('an already-claimed tier shows Claimed, not Claim', () => {
    const tier1 = RECHARGE_TIERS[0]!;
    const scene = buildRecharge({
      getData: () => ({ totalRechargeCents: tier1.thresholdCents, claimed: [tier1.id] }),
    });
    expect(findLabelPos(scene.container, CLAIMED)).not.toBeNull();
    // Only tier 1 is reached; it's claimed, so no Claim button should be showing anywhere.
    expect(findLabelPos(scene.container, CLAIM)).toBeNull();
    scene.destroy();
  });

  it('tapping Claim on a claimable tier calls onClaim with that tier id', async () => {
    const tier1 = RECHARGE_TIERS[0]!;
    let claimedTierId: number | null = null;
    const scene = buildRecharge({
      getData: () => ({ totalRechargeCents: tier1.thresholdCents, claimed: [] }),
      onClaim: async (tierId: number) => {
        claimedTierId = tierId;
        return [{ kind: 'coins', count: tier1.rewards[0]!.count }];
      },
    });
    tapLabel(scene, CLAIM);
    // onClaim is invoked synchronously from the tap handler (before awaiting the promise).
    expect(claimedTierId).toBe(tier1.id);
    scene.destroy();
  });
});

describe('RechargeScene — shop-group peer tab bar (mirrors BattlePassScene)', () => {
  it('shows the group tab rail only when openShop is wired', () => {
    const withGroup = buildRecharge({ openShop() {}, getData: () => ({ totalRechargeCents: 0, claimed: [] }) });
    expect(findLabelPos(withGroup.container, SHOP)).not.toBeNull();
    withGroup.destroy();

    const standalone = buildRecharge({ getData: () => ({ totalRechargeCents: 0, claimed: [] }) });
    expect(findLabelPos(standalone.container, SHOP)).toBeNull();
    standalone.destroy();
  });

  it('Gacha and BattlePass peer tabs route correctly from Recharge', () => {
    let openedGacha = 0;
    let openedBattlePass = 0;
    const scene = buildRecharge({
      openShop() {},
      openGacha: () => { openedGacha++; },
      openBattlePass: () => { openedBattlePass++; },
      getData: () => ({ totalRechargeCents: 0, claimed: [] }),
    });
    tapLabel(scene, GACHA);
    expect(openedGacha).toBe(1);
    tapLabel(scene, BATTLEPASS);
    expect(openedBattlePass).toBe(1);
    scene.destroy();
  });
});
