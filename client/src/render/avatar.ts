/**
 * avatar.ts — player avatar (notebook doodle style).
 *
 * avatarId is a composite string "<category>:<key>":
 *   preset:0-7   — one of 8 hand-picked icon tokens (icon + background colour), the original set.
 *   title:<id>   — an owned title's medal art (titleArt.ts) on a neutral disc.
 *   hero:<unit>  — a hero's card portrait (cardArt.ts UNIT_ART_URLS), cropped to a circle.
 *   equip:<def>  — an equipment icon (equipmentAtlas.ts), on a neutral disc.
 *   material:<k> — a crafting-material icon (materialAtlas.ts), on a neutral disc.
 *   skin:<id>    — the re-skinned character's portrait (skins have no separate 2D art).
 * Bare digit strings ('0'-'7', the pre-sync localStorage format) are treated as "preset:<n>".
 * Anything else unresolved (unknown key, category with no art) falls back to the letter-initial style.
 *
 * Deterministic per (name, seed) so the same player always gets the same doodle when no avatarId
 * resolves. Shared by the lobby profile chip, the settings screen, and the avatar picker.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { SketchPen } from './sketch';
import { palette } from './theme';
import { buildIcon, IconKind } from './icons';
import { buildAvatarIcon } from './avatarAtlas';
import { buildMaterialIcon, type MaterialKind } from './materialAtlas';
import { buildEquipIcon } from './equipmentAtlas';
import { titleIconUrl } from './titleArt';
import { UNIT_ART_URLS } from './cardArt';
import { EQUIPMENT_DEFS } from '../game/meta/equipmentDefs';
import { SKIN_TARGET_UNIT } from '../game/meta/skinDefs';
import { snapFont } from './fontScale';

/** First visible glyph of a name, uppercased (handles CJK + latin). */
function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

/** 8 hand-crafted avatar tokens (icon + background colour), indices 0-7. */
const AVATAR_DEFS: Array<{ icon: IconKind; bg: number }> = [
  { icon: 'book',    bg: 0x4477cc },  // 0 scholar inkBlue (default-compatible)
  { icon: 'trophy',  bg: 0xcc9900 },  // 1 champion gold
  { icon: 'swords',  bg: 0xcc3333 },  // 2 warrior red
  { icon: 'castle',  bg: 0x4a9e4a },  // 3 sovereign green
  { icon: 'pencils', bg: 0x9955cc },  // 4 creator purple
  { icon: 'globe',   bg: 0x44aacc },  // 5 explorer cyan
  { icon: 'coin',    bg: 0xcc6633 },  // 6 merchant orange
  { icon: 'home',    bg: 0x667788 },  // 7 guardian grey-blue
];

/** Total number of preset avatar tokens available (for UI pickers). */
export const AVATAR_COUNT = AVATAR_DEFS.length;

export type AvatarCategory = 'preset' | 'title' | 'hero' | 'equip' | 'material' | 'skin';

/** Composite avatarId "<category>:<key>", or a bare preset digit for backward compat. */
export function makeAvatarId(category: AvatarCategory, key: string): string {
  return `${category}:${key}`;
}

/** Parse a stored avatarId into its category + key; null if the string doesn't look like one of ours. */
export function parseAvatarId(id: string): { category: AvatarCategory; key: string } | null {
  if (/^\d+$/.test(id)) return { category: 'preset', key: id };
  const sep = id.indexOf(':');
  if (sep < 0) return null;
  const category = id.slice(0, sep);
  const key = id.slice(sep + 1);
  if (category === 'preset' || category === 'title' || category === 'hero' ||
      category === 'equip' || category === 'material' || category === 'skin') {
    return { category, key };
  }
  return null;
}

/** Neutral disc background shared by every non-preset category (presets keep their own per-icon colour). */
const CATEGORY_BG: Record<Exclude<AvatarCategory, 'preset'>, number> = {
  title: 0xd4a030,
  hero: 0x4477cc,
  equip: 0x667788,
  material: 0x8a6d3b,
  skin: 0x9955cc,
};

/** A size×size PIXI sprite from `url`, top-left origin (matches buildIcon's contract), or null if unresolved. */
function spriteIcon(url: string | null, size: number): PIXI.DisplayObject | null {
  if (!url) return null;
  const tex = PIXI.Texture.from(url);
  const sprite = new PIXI.Sprite(tex);
  sprite.width = size;
  sprite.height = size;
  return sprite;
}

/** A character portrait cropped to a circle of diameter `size`, biased toward the upper (head/torso) area. */
function buildPortraitIcon(url: string, size: number): PIXI.Container {
  const c = new PIXI.Container();
  const tex = PIXI.Texture.from(url);
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0.5, 0.5);
  const base = tex.valid && tex.width > 0 && tex.height > 0 ? Math.max(size / tex.width, size / tex.height) : size / 256;
  sprite.scale.set(base * 1.6);
  sprite.x = size / 2;
  sprite.y = size * 0.42;
  const mask = new PIXI.Graphics();
  mask.beginFill(0xffffff);
  mask.drawCircle(size / 2, size / 2, size / 2);
  mask.endFill();
  c.addChild(sprite);
  c.addChild(mask);
  sprite.mask = mask;
  return c;
}

/** Resolve the centred icon/portrait for a non-preset category, or null if the key has no art (→ letter fallback). */
function categoryIcon(category: Exclude<AvatarCategory, 'preset'>, key: string, size: number): PIXI.DisplayObject | null {
  switch (category) {
    case 'title':
      return spriteIcon(titleIconUrl(key), size) ?? buildIcon('trophy', size, palette.paper);
    case 'hero': {
      const url = UNIT_ART_URLS[key];
      return url ? buildPortraitIcon(url, size) : null;
    }
    case 'equip': {
      const def = EQUIPMENT_DEFS[key];
      if (!def) return null;
      const icon = buildEquipIcon(def.defId, def.slot, def.rarity, size);
      // buildEquipIcon is centre-anchored (unlike buildIcon's top-left contract) — wrap it so the
      // caller can still position this return value by its top-left corner like every other case.
      const wrap = new PIXI.Container();
      icon.x = size / 2; icon.y = size / 2;
      wrap.addChild(icon);
      return wrap;
    }
    case 'material':
      return buildMaterialIcon(key as MaterialKind, size, palette.paper);
    case 'skin': {
      const unit = SKIN_TARGET_UNIT[key];
      const url = unit !== undefined ? UNIT_ART_URLS[unit] : undefined;
      return url ? buildPortraitIcon(url, size) : null;
    }
  }
}

/**
 * Build a square avatar container of side `size`, centred on (size/2, size/2).
 *
 * `avatarId` selects what's drawn: a preset icon, or an owned title/hero/equipment/material/skin's
 * art on a neutral disc. Anything unresolved (absent, unparseable, or unknown key) falls back to an
 * ink circle with the name's first letter.
 */
export function buildAvatar(size: number, name: string, seed = 7, avatarId?: string): PIXI.Container {
  const c = new PIXI.Container();
  const r = size / 2 - 2;
  const cx = size / 2, cy = size / 2;

  const parsed = avatarId ? parseAvatarId(avatarId) : null;
  const presetIdx = parsed?.category === 'preset' ? parseInt(parsed.key, 10) : -1;
  const presetDef = (presetIdx >= 0 && presetIdx < AVATAR_DEFS.length) ? AVATAR_DEFS[presetIdx] : null;

  const iconS = Math.round(size * 0.62);
  let icon: PIXI.DisplayObject | null = null;
  let bg: number = palette.inkBlue;
  if (presetDef) {
    bg = presetDef.bg;
    icon = buildAvatarIcon(presetDef.icon, iconS, palette.paper);
  } else if (parsed && parsed.category !== 'preset') {
    icon = categoryIcon(parsed.category, parsed.key, iconS);
    if (icon) bg = CATEGORY_BG[parsed.category];
  }

  const disc = new PIXI.Graphics();
  disc.beginFill(bg);
  disc.drawCircle(cx, cy, r);
  disc.endFill();
  new SketchPen(disc, seed).circle(cx, cy, r, {
    color: palette.pencil, width: 2.2, jitter: 1.2,
  });
  c.addChild(disc);

  if (icon) {
    icon.x = Math.round(cx - iconS / 2);
    icon.y = Math.round(cy - iconS / 2);
    c.addChild(icon);
  } else {
    const letter = makeText(initial(name), {
      fontSize: snapFont(Math.round(size * 0.5)),
      fill: palette.paper,
      fontFamily: 'monospace',
      fontWeight: 'bold',
    });
    letter.anchor.set(0.5, 0.5);
    letter.x = cx; letter.y = cy + 1;
    c.addChild(letter);
  }

  return c;
}
