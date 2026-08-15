/**
 * avatar.ts — player avatar (notebook doodle style).
 *
 * avatarId is a composite string "<category>:<key>":
 *   preset:<key> — one of 20 free bust portraits (presetAvatarArt.ts), cropped to a circle.
 *   title:<id>   — an owned title's medal art (titleArt.ts) on a neutral disc.
 *   hero:<unit>  — a hero's dedicated "everyday clothes" bust portrait (heroAvatarArt.ts),
 *                  cropped to a circle — NOT the battle/card illustration (cardArt.ts UNIT_ART_URLS).
 *   skin:<id>    — the re-skinned character's portrait (skins have no separate 2D art; still
 *                  reads the hero's battle art via SKIN_TARGET_UNIT — a known bug, see
 *                  design/product/avatar-art-prompts.md §三, pending the 2 unfinished skin repaints).
 * Bare digit strings ('0'-'7', the pre-2026-08 localStorage format) are treated as "preset:<n>"
 * and positionally migrated onto the new 20-key list (see resolvePresetArtUrl) so old accounts
 * still land on a real portrait instead of the letter-initial fallback.
 * The `equip`/`material` avatar categories that used to exist here were deleted outright (2026-08
 * redesign, design/product/avatar-art-prompts.md) — equipment/materials change too often for a
 * head-shot pool to track. Accounts with a stored `equip:*`/`material:*` avatarId fail to parse
 * here (parseAvatarId returns null) and would fall back to the letter-initial style, but in
 * practice never reach this code: metaserver's `sanitizeEquippedAvatar` (server/metaserver/src/
 * save.ts) rewrites those to `preset:0` on every outgoing save — read-time only, no DB write-back.
 * Anything else unresolved (unknown key, category with no art) falls back to the letter-initial style.
 *
 * Deterministic per (name, seed) so the same player always gets the same doodle when no avatarId
 * resolves. Shared by the lobby profile chip, the settings screen, and the avatar picker.
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from './pixiText';
import { SketchPen } from './sketch';
import { palette } from './theme';
import { buildIcon } from './icons';
import { titleIconUrl } from './titleArt';
import { UNIT_ART_URLS, getArtTexture } from './cardArt';
import { PRESET_AVATAR_KEYS, PRESET_AVATAR_ART_URLS, type PresetAvatarKey } from './presetAvatarArt';
import { HERO_AVATAR_ART_URLS, type HeroAvatarKey } from './heroAvatarArt';
import { SKIN_TARGET_UNIT } from '../game/meta/skinDefs';
import { snapFont } from './fontScale';

/** First visible glyph of a name, uppercased (handles CJK + latin). */
function initial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

export type AvatarCategory = 'preset' | 'title' | 'hero' | 'skin';

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
  if (category === 'preset' || category === 'title' || category === 'hero' || category === 'skin') {
    return { category, key };
  }
  return null;
}

/** Neutral disc background shared by every avatar category (portraits/icons sit on top, at ~62% width). */
const CATEGORY_BG: Record<AvatarCategory, number> = {
  preset: palette.inkBlue,
  title: 0xd4a030,
  hero: 0x4477cc,
  skin: 0x9955cc,
};

/**
 * Resolve a preset avatar key to its portrait URL. Accepts the current 20 string keys, and
 * migrates the old pre-2026-08 numeric format (bare "0".."7" indices, from the 8-icon set this
 * replaced) by mapping the index positionally onto the new key list — old accounts land on *a*
 * valid portrait rather than the letter-initial glyph.
 */
function resolvePresetArtUrl(key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(PRESET_AVATAR_ART_URLS, key)) {
    return PRESET_AVATAR_ART_URLS[key as PresetAvatarKey];
  }
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10) % PRESET_AVATAR_KEYS.length;
    return PRESET_AVATAR_ART_URLS[PRESET_AVATAR_KEYS[idx]!];
  }
  return undefined;
}

/** A size×size PIXI sprite from `url`, top-left origin (matches buildIcon's contract), or null if unresolved. */
function spriteIcon(url: string | null, size: number): PIXI.DisplayObject | null {
  if (!url) return null;
  const tex = PIXI.Texture.from(url);
  const sprite = new PIXI.Sprite(tex);
  sprite.width = size;
  sprite.height = size;
  return sprite;
}

/**
 * A character portrait cropped to a circle of diameter `size`.
 * All six unit illustrations (cardArt.ts UNIT_ART_URLS) are full-body renders with the head flush
 * against the top edge and no meaningful aspect variance in width — so fitting by WIDTH alone and
 * anchoring to the top keeps the head in frame regardless of how tall/narrow the body is (a fixed
 * "cover then zoom in" fit was cropping straight through the torso on the tallest portraits, cutting
 * the head off entirely). Cropping the lower body is fine; that's the point of an avatar bust crop.
 */
function buildPortraitIcon(url: string, size: number): PIXI.Container {
  const c = new PIXI.Container();
  // getArtTexture (not bare Texture.from) so bust crops share the mipmap opt-in — avatar
  // circles shrink hero art hard, and a no-mipmap version winning the shared cache here
  // would drag the roster/detail portraits back down with it.
  const tex = getArtTexture(url);
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0.5, 0);
  sprite.scale.set(tex.valid && tex.width > 0 ? size / tex.width : size / 256);
  sprite.x = size / 2;
  sprite.y = size * 0.03; // slight headroom so the art's top edge isn't flush with the circle's rim
  const mask = new PIXI.Graphics();
  mask.beginFill(0xffffff);
  mask.drawCircle(size / 2, size / 2, size / 2);
  mask.endFill();
  c.addChild(sprite);
  c.addChild(mask);
  sprite.mask = mask;
  return c;
}

/** Resolve the centred icon/portrait for any avatar category, or null if the key has no art (→ letter fallback). */
function categoryIcon(category: AvatarCategory, key: string, size: number): PIXI.DisplayObject | null {
  switch (category) {
    case 'preset': {
      const url = resolvePresetArtUrl(key);
      return url ? buildPortraitIcon(url, size) : null;
    }
    case 'title':
      return spriteIcon(titleIconUrl(key), size) ?? buildIcon('trophy', size, palette.paper);
    case 'hero': {
      const url = HERO_AVATAR_ART_URLS[key as HeroAvatarKey];
      return url ? buildPortraitIcon(url, size) : null;
    }
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
 * `avatarId` selects what's drawn: a preset/hero/title/skin's portrait or medal art on a neutral
 * disc. Anything unresolved (absent, unparseable, or unknown key) falls back to an ink circle with
 * the name's first letter.
 */
export function buildAvatar(size: number, name: string, seed = 7, avatarId?: string): PIXI.Container {
  const c = new PIXI.Container();
  const r = size / 2 - 2;
  const cx = size / 2, cy = size / 2;

  const parsed = avatarId ? parseAvatarId(avatarId) : null;

  const iconS = Math.round(size * 0.62);
  let icon: PIXI.DisplayObject | null = null;
  let bg: number = palette.inkBlue;
  if (parsed) {
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
