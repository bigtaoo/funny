// Fixture builders for the layout sweep's database seed (see lib/seed.ts for the transport, and
// portraitLayout.spec.ts for why any of this exists).
//
// Everything here is a PURE function returning plain documents. No mongo, no Playwright, no PIXI —
// so the shapes stay readable next to the server's own Doc interfaces, and a wrong one is a diff
// rather than an archaeology session.
//
// The one design rule: **every value is a worst case, and the worst case is a real one.** The sweep
// is looking for layouts that break when content arrives, so a name here is exactly as long as the
// server would ever let a name be (MAX_DISPLAY_NAME_LEN 24 / ORG_NAME_WIDTH_MAX 12 display units),
// a count is exactly as wide as the biggest one a player can hold, and a list is exactly as long as
// its cap (a family holds FAMILY_CAP members, the leaderboard shows 100 rows). Numbers that are
// merely large are not interesting; numbers one digit off the cap are what re-wrap a row.
//
// CJK is deliberately over-represented in names: a full-width glyph is two display units, so a
// name at the width cap is PHYSICALLY the widest string the field can ever hold, and CJK is also
// what `pixiText`'s anti-clip padding was added for (see layoutAudit.ts).

/** Longest display name the server accepts (MAX_DISPLAY_NAME_LEN, shared/src/password.ts). */
export const NAME_MAX = 24;
/** Longest family/sect name, in display units — a full-width glyph counts 2 (ORG_NAME_WIDTH_MAX). */
export const ORG_WIDTH_MAX = 12;
/** Mail subject cap (MAIL_SUBJECT_MAX, shared/src/social.ts). */
export const SUBJECT_MAX = 80;

/**
 * Display names handed to the bot accounts that populate every roster the sweep walks.
 *
 * Three shapes, because they break layouts in three different ways: a CJK name at the width cap is
 * the widest possible string, a German compound is the longest possible *unbreakable* token (no
 * space for word-wrap to use), and a latin name at 24 characters is the longest possible string
 * full stop. Short ones are mixed in so a row's layout is not accidentally uniform.
 */
export const LONG_NAMES: readonly string[] = [
  '玄天不灭战神统领大将军', // 11 full-width = 22 display units
  'Donaudampfschifffahrt24',
  'Maximiliane-Vandenberghe',
  '墨水战争第一指挥官阁下',
  'Rechtsschutzversicherung',
  '不落长夜之城的守望者们',
  'Bartholomew_Fitzgerald77',
  '铅笔与橡皮的永恒争斗史',
  'Streichholzschächtelchen',
  'Wolfeschlegelsteinhausen',
];

/** Short names, so a seeded roster is not uniformly worst-case (a layout can also break on the mix). */
const SHORT_NAMES: readonly string[] = ['阿墨', 'Ke', 'Jo', '小七', 'Ada', 'Wu', 'Bo', 'Ivy'];

/** Deterministic pick, so two runs of the sweep seed the same names and a diff of two reports means something. */
export function nameFor(i: number): string {
  // 2:1 long:short — enough short rows that "every row is huge" cannot hide a bug that only shows
  // when a wide row sits next to a narrow one (the fixed-column vs. content-width failure).
  return i % 3 === 2
    ? SHORT_NAMES[i % SHORT_NAMES.length]!
    : LONG_NAMES[i % LONG_NAMES.length]!;
}

/** A CJK name at exactly ORG_NAME_WIDTH_MAX (6 full-width glyphs = 12 display units). */
export const FAMILY_NAME = '不落长夜之城';
export const FAMILY_TAG = 'NIGHT';
export const SECT_NAME = '九州墨海盟约';
export const SECT_TAG = 'MOHAI';

/**
 * A family announcement long enough to need wrapping in a portrait panel, with no early space —
 * the shape that finds a panel measuring by character count rather than by rendered width.
 */
export const ANNOUNCEMENT =
  '本周目标：巩固东境三座资源城，禁止单队越线；晚八点集合冲锋，未到者视为放弃本轮分配。'
  + '补给由粮官统一发放，Ersatzlieferungen werden am Freitag verteilt.';

// ── Inventory ────────────────────────────────────────────────────────────────────────────────

/** Card definition ids that exist in CARD_DEFS (shared/src/cards.ts). */
export const CARD_DEF_IDS = ['lichuang', 'chenshou', 'suyuan', 'max', 'lena', 'mara'] as const;
/**
 * The equipment catalogue, mirrored from EQUIPMENT_DEFS (shared/src/equipment.ts).
 *
 * Slot AND rarity are locked by the defId there, so this cannot be a bare id list with a rarity
 * chosen alongside it: an instance whose stored rarity disagrees with its def is not a worst case,
 * it is a document the game cannot produce. Twelve entries = three slots x four rarities, which is
 * also every affix-row count the detail panel can draw (see `SUB_AFFIX_COUNT`).
 */
export const EQUIP_DEFS = [
  { defId: 'wp_pencil', slot: 'weapon', rarity: 'common' },
  { defId: 'wp_pen', slot: 'weapon', rarity: 'fine' },
  { defId: 'wp_marker', slot: 'weapon', rarity: 'rare' },
  { defId: 'wp_highlighter', slot: 'weapon', rarity: 'epic' },
  { defId: 'ar_draft', slot: 'armor', rarity: 'common' },
  { defId: 'ar_cardstock', slot: 'armor', rarity: 'fine' },
  { defId: 'ar_leather', slot: 'armor', rarity: 'rare' },
  { defId: 'ar_foil', slot: 'armor', rarity: 'epic' },
  { defId: 'tk_clip', slot: 'trinket', rarity: 'common' },
  { defId: 'tk_bookmark', slot: 'trinket', rarity: 'fine' },
  { defId: 'tk_sticker', slot: 'trinket', rarity: 'rare' },
  { defId: 'tk_seal', slot: 'trinket', rarity: 'epic' },
] as const;
/** The epic piece of each slot — what a maxed card wears. */
const EPIC_BY_SLOT: Record<string, string> = { weapon: 'wp_highlighter', armor: 'ar_foil', trinket: 'tk_seal' };
/**
 * Main affix per slot, as STORED — the base value from MAIN_AFFIX_BY_SLOT (shared/src/equipment.ts).
 * The screen multiplies it by `enhanceMultiplier(level)` itself (EquipmentScene/helpers.ts
 * `affixDesc`), so +9 prints base x5.00 — a two-digit number, never more. `m_crit` is picked for
 * trinkets over `m_spd` because 'Crit Chance' is the longer of the two labels.
 */
const MAIN_AFFIX: Record<string, { id: string; value: number }> = {
  weapon: { id: 'm_atk', value: 8 },
  armor: { id: 'm_hp', value: 10 },
  trinket: { id: 'm_crit', value: 6 },
};
/** Sub-affixes at the top of their rolled range (SUB_AFFIX_POOL), widest label first. */
const SUB_AFFIXES = [
  { id: 's_critmult', value: 30 }, // 'Crit Damage +30%' — the longest affix line in the catalogue
  { id: 's_atkspd', value: 6 },
] as const;
/** Sub-affix count by rarity (CRAFT_SUB_AFFIX_COUNT) — this is what makes the card taller. */
const SUB_AFFIX_COUNT: Record<string, number> = { common: 0, fine: 1, rare: 2, epic: 2 };
/** Gear slots a CardInstance can fill (CardInstance.gear keys). */
const GEAR_SLOTS = ['weapon', 'armor', 'trinket'] as const;

export interface SeedEquipment {
  _id: string; accountId: string; defId: string; rarity: string; level: number;
  affixes: { id: string; value: number }[]; locked?: boolean; obtainedAt: number;
}

export interface SeedCard {
  _id: string; accountId: string; defId: string; level: number;
  gear: Record<string, string>; gearInstanceIds: string[]; locked: boolean; obtainedAt: number;
}

/**
 * A short, id-safe slug of an accountId, used to scope every fixed `_id` this module mints.
 *
 * Not cosmetic (2026-09-12): the ids used to be plain counters (`seedcard0000`), and the seed's own
 * cleanup deletes them scoped to the CURRENT account — so the second account ever seeded against a
 * stack hit `E11000 duplicate key` on the first card, because the document was still there under the
 * first account's name and the scoped delete could not see it. The dry-run that validated this seed
 * ran against a clean database, which is exactly the condition under which that bug is invisible.
 */
export function tagOf(accountId: string): string {
  return accountId.replace(/[^A-Za-z0-9]/g, '').slice(-10) || 'anon';
}

/**
 * A full-strength roster: `cards` cards, each at max level with all three gear slots filled by a
 * +9 epic. Every number a card cell prints (level, power, affix values) is therefore at the widest
 * the GAME can make it, which is the entire point — a fresh account's level-1 no-gear cards print
 * two digits and prove nothing about the cell, and a fixture that prints five proves less than
 * nothing (see `mkEquip`).
 */
export function buildInventory(accountId: string, cards: number, spareEquipment: number): {
  cards: SeedCard[]; equipment: SeedEquipment[];
} {
  const equipment: SeedEquipment[] = [];
  const out: SeedCard[] = [];
  const now = Date.now();
  let e = 0;
  const tag = tagOf(accountId);
  /**
   * One instance of `defId` at enhancement `level`, with the affix list that def can actually roll.
   *
   * The first version invented both (four affixes, four-digit values, two ids — `p_crit`/`p_def` —
   * that are not in the catalogue at all). That is not a worst case, it is fiction, and it was an
   * expensive one: the real screen prints `base x enhanceMultiplier(level)` for a main affix, so a
   * stored 8630 rendered as '+16150%', every line was several characters wider than the game can
   * produce, `fitFont` shrank all of them to fit, and the sweep's single largest cluster — 60
   * `unreadable` findings on the equipment screen, 2026-09-12 — was measuring the fixture rather
   * than the layout. An unknown affix id also falls through to a raw `p_def +2673`, which is how
   * the invented ids announced themselves once the screenshots were read.
   */
  const mkEquip = (defId: string, slot: string, rarity: string, level: number): SeedEquipment => {
    const id = `seedeq${tag}${String(e).padStart(4, '0')}`;
    e += 1;
    return {
      _id: id, accountId, defId, rarity, level,
      affixes: [MAIN_AFFIX[slot]!, ...SUB_AFFIXES.slice(0, SUB_AFFIX_COUNT[rarity] ?? 0)],
      locked: level >= 8,
      obtainedAt: now - e * 60_000,
    };
  };

  for (let i = 0; i < cards; i++) {
    const gear: Record<string, string> = {};
    for (const slot of GEAR_SLOTS) {
      const inst = mkEquip(EPIC_BY_SLOT[slot]!, slot, 'epic', 9);
      equipment.push(inst);
      gear[slot] = inst._id;
    }
    out.push({
      _id: `seedcard${tag}${String(i).padStart(4, '0')}`,
      accountId,
      defId: CARD_DEF_IDS[i % CARD_DEF_IDS.length]!,
      // Card level: max is what makes the cell print its widest power number.
      level: 60,
      gear,
      gearInstanceIds: Object.values(gear),
      locked: i % 5 === 0,
      obtainedAt: now - i * 3_600_000,
    });
  }
  // Unequipped stock, so the equipment screen's own grid is full rather than showing only what is
  // already on a card (equipped items are filtered out of some tabs).
  // Every def at every enhancement level the cap allows, cycled — so the grid holds all four
  // rarities (0/1/2 affix rows, i.e. three card heights) and the whole +0..+9 star range.
  for (let i = 0; i < spareEquipment; i++) {
    const def = EQUIP_DEFS[i % EQUIP_DEFS.length]!;
    equipment.push(mkEquip(def.defId, def.slot, def.rarity, i % 10));
  }
  return { cards: out, equipment };
}

// ── Mail ─────────────────────────────────────────────────────────────────────────────────────

export interface SeedMail {
  _id: string; to: string; from: string; fromName?: string; subject: string; body: string;
  attachments?: { kind: string; id?: string; count?: number }[];
  createdAt: number; expireAt: { __date: number }; readAt?: number;
}

/**
 * A subject at exactly MAIL_SUBJECT_MAX, so the row's title has no slack left anywhere.
 *
 * The cap is 80 CHARACTERS (shared/src/social.ts), and every one of them here is full-width — 160
 * display units, the widest a mail subject can physically be. The first version sliced at 40 while
 * claiming to be at the cap, and the source string was only 36 characters long, so the slice did
 * nothing and the "worst case" was less than half of one.
 */
const MAX_SUBJECT = (
  '第七赛季结算奖励与跨服争霸战参与凭证发放通知（含补偿明细，请在七日内领取，逾期未领将自动退回系统仓库，'
  + '如有疑问请通过游戏内反馈入口联系客服，我们会在两个工作日内回复您的问题）'
).slice(0, SUBJECT_MAX);
const LONG_BODY =
  '亲爱的指挥官：\n\n第七赛季已于北京时间本周一凌晨结算完毕。您在本赛季的最终排名为第 1 位，'
  + '峰值积分 2847，累计参与攻城 168 次、防守 94 次。以下为您的结算奖励明细：\n\n'
  + '· 赛季称号「墨海无双」\n· 金币 1288000\n· 高级抽卡券 120 张\n· 传说装备箱 12 个\n\n'
  + 'Zusätzlich erhalten Sie eine Entschädigung für die Serverwartung vom vergangenen Wochenende. '
  + 'Die Gutschrift erfolgt automatisch und muss nicht gesondert beantragt werden.\n\n'
  + '请注意：附件将在 7 天后过期，逾期未领取将自动退回。感谢您的参与，下赛季再会！';

/**
 * `count` mails, oldest last. Deliberately mixed: the first few carry the long subject + long body +
 * four-digit attachment counts (the row and the reader both at their widest), the rest are ordinary,
 * and a third of them are unread so the list renders both states.
 */
export function buildMails(accountId: string, count: number): SeedMail[] {
  const now = Date.now();
  const tag = tagOf(accountId);
  const out: SeedMail[] = [];
  for (let i = 0; i < count; i++) {
    const heavy = i % 4 === 0;
    const createdAt = now - i * 3_600_000;
    out.push({
      _id: `seedmail${tag}${String(i).padStart(3, '0')}`,
      to: accountId,
      from: i % 5 === 0 ? 'system' : `seedsender${i}`,
      ...(i % 5 === 0 ? {} : { fromName: nameFor(i) }),
      subject: heavy ? MAX_SUBJECT : `Kampfbericht #${1000 + i}`,
      body: heavy ? LONG_BODY : `Bezirk ${i} wurde erfolgreich verteidigt. Verluste: ${120 + i * 7} Einheiten.`,
      ...(heavy
        ? {
          attachments: [
            { kind: 'coins', count: 1288000 },
            { kind: 'material', id: 'scrap', count: 4820 },
            { kind: 'material', id: 'binding', count: 1360 },
          ],
        }
        : i % 3 === 1
          ? { attachments: [{ kind: 'material', id: 'lead', count: 240 }] }
          : {}),
      createdAt,
      expireAt: { __date: createdAt + 30 * 86_400_000 },
      ...(i % 3 === 0 ? {} : { readAt: createdAt + 60_000 }),
    });
  }
  return out;
}

// ── Auction ──────────────────────────────────────────────────────────────────────────────────

export interface SeedAuction {
  _id: string; sellerId: string; itemType: string; item: Record<string, unknown>; qty: number;
  price: number; currency: string; expireAt: number; status: string;
  saleMode?: string; startPrice?: number; buyoutPrice?: number;
  topBid?: { bidderId: string; amount: number; ts: number };
  rev: number;
}

/**
 * `count` open listings — enough to page. Mixed sale modes and item types, prices up into seven
 * digits (the widest a coin figure gets), and a third of them already carrying a top bid, so the
 * bid line renders too.
 */
export function buildAuctions(sellerIds: string[], mySellerId: string, count: number): SeedAuction[] {
  const now = Date.now();
  const out: SeedAuction[] = [];
  const materials = ['scrap', 'lead', 'binding'];
  for (let i = 0; i < count; i++) {
    // Every fifth listing is the player's own, so "My listings" is populated too.
    const sellerId = i % 5 === 0 ? mySellerId : sellerIds[i % sellerIds.length]!;
    const isEquip = i % 3 === 1;
    const auctionMode = i % 3 === 2;
    const price = 12_500 + i * 34_700;
    out.push({
      _id: `seedauc${String(i).padStart(3, '0')}`,
      sellerId,
      itemType: isEquip ? 'equipment' : 'material',
      item: isEquip
        ? {
          // Same catalogue and same affix shape as an owned instance — a listing is a real
          // EquipmentInstance, so it has to be one here too (see buildInventory's `mkEquip`).
          instance: (() => {
            const def = EQUIP_DEFS[i % EQUIP_DEFS.length]!;
            return {
              id: `seedauceq${i}`,
              defId: def.defId,
              rarity: def.rarity,
              level: i % 10,
              affixes: [MAIN_AFFIX[def.slot]!, ...SUB_AFFIXES.slice(0, SUB_AFFIX_COUNT[def.rarity] ?? 0)],
            };
          })(),
        }
        : { material: materials[i % materials.length]! },
      qty: isEquip ? 1 : 100 + i * 37,
      price,
      currency: 'coins',
      expireAt: now + (2 + (i % 20)) * 3_600_000,
      status: 'open',
      ...(auctionMode
        ? {
          saleMode: 'auction',
          startPrice: price,
          buyoutPrice: price * 4,
          topBid: { bidderId: sellerIds[(i + 1) % sellerIds.length]!, amount: price + 5300, ts: now - i * 1000 },
        }
        : { saleMode: 'fixed' }),
      rev: 1,
    });
  }
  return out;
}
