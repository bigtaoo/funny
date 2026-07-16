// ─────────────────────────────────────────────────────────────────────────────
// D-track runner — protect_enhance shop-item pricing check (SLG_ECONOMY_CHECK-adjacent,
// see EQUIPMENT_DESIGN.md §6.2 / §E7 for the mechanic).
//   npx tsx src/enhanceProtectRun.ts
// ─────────────────────────────────────────────────────────────────────────────

import { SHOP_ITEMS } from '@nw/shared';
import { protectValueByLevel, breakEvenLevels } from './enhanceProtect';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const f2 = (n: number) => n.toFixed(2);

function bar(s: string) { console.log('═'.repeat(90)); console.log(s); console.log('═'.repeat(90)); }

// Read the live shop price rather than hardcoding it, so this script can never drift from SHOP_ITEMS.
const protectItem = SHOP_ITEMS.find((i) => i.id === 'protect_enhance');
if (!protectItem) throw new Error('protect_enhance missing from SHOP_ITEMS — economy.ts changed shape');
const PROTECT_ENHANCE_PRICE_COINS = protectItem.cost;

bar('protect_enhance shop-item pricing check (EQUIPMENT_DESIGN §6.2 / §E7)');
console.log(`Flat shop price = ${PROTECT_ENHANCE_PRICE_COINS} coins (SHOP_ITEMS, server/shared/src/economy.ts).`);
console.log('Value of one use = coin-equivalent of the materials it saves on ONE failed attempt');
console.log('(coins are always deducted regardless — protect only guards materials).\n');

const rows = protectValueByLevel();
console.log(
  'level'.padEnd(8) +
    'p(success)'.padStart(11) +
    'E[attempts]'.padStart(13) +
    'mat coin-eq/atmpt'.padStart(19) +
    'coins/atmpt'.padStart(13) +
    'E[mat lost climbing]'.padStart(22),
);
for (const r of rows) {
  console.log(
    `+${r.fromLevel}->+${r.toLevel}`.padEnd(8) +
      `${(r.successRate * 100).toFixed(0)}%`.padStart(11) +
      f2(r.expectedAttempts).padStart(13) +
      fmt(r.materialCoinValuePerAttempt).padStart(19) +
      fmt(r.coinsPerAttempt).padStart(13) +
      fmt(r.expectedMaterialLossToClimb).padStart(22),
  );
}
console.log('');

const { profitableFromLevel } = breakEvenLevels(PROTECT_ENHANCE_PRICE_COINS);
console.log('── Break-even read ──');
if (profitableFromLevel === null) {
  console.log(`  At NO level does one failed attempt's material cost reach ${PROTECT_ENHANCE_PRICE_COINS} coins.`);
  console.log('  The flat price is priced for the WHOLE climb\'s expected material loss (see column at right above),');
  console.log('  not a single attempt — read it as "insurance for a costly high-level push", not a per-attempt tool.');
} else {
  console.log(`  From +${profitableFromLevel} onward, a single failed attempt's material cost alone already`);
  console.log(`  exceeds the ${PROTECT_ENHANCE_PRICE_COINS}-coin price — profitable per-attempt at and above that level.`);
}
console.log('');
bar('VERDICT');
console.log('See ECONOMY_NUMBERS.md §5.4 for the registered conclusion (price kept as-is 2026-07-16;');
console.log('this documents WHY a flat price under-protects low levels and over-protects high ones,');
console.log('not a proposal to change it).');
