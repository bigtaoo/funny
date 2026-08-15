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
import { PRESET_HEAD_BOX, HERO_HEAD_BOX, type HeadBox } from './portraitHeadBox';
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

/**
 * How much of the tile the art covers.
 *
 * Portraits (preset/hero/skin) run nearly edge-to-edge so the coloured disc reads as a thin
 * category rim rather than a background — at the old shared 0.62 the ring ate ~19% of the tile on
 * every side, leaving a fat donut around a head barely half the tile wide. They're measured off the
 * DISC's diameter (`size - 4`), not the tile's, so the rim survives at the map tokens' 16px floor;
 * a flat fraction of the tile would overflow the sketched rim outright down there.
 * Flat medal art (title) still wants the disc as breathing room and keeps the old tile fraction.
 */
const PORTRAIT_FILL_OF_DISC = 0.92;
const ICON_FILL = 0.62;

/** Neutral disc background shared by every avatar category (portraits/icons sit on top). */
const CATEGORY_BG: Record<AvatarCategory, number> = {
  preset: palette.inkBlue,
  title: 0xd4a030,
  hero: 0x4477cc,
  skin: 0x9955cc,
};

/**
 * Resolve a stored preset avatar key to one of the current 20. Accepts the string keys as-is, and
 * migrates the old pre-2026-08 numeric format (bare "0".."7" indices, from the 8-icon set this
 * replaced) by mapping the index positionally onto the new key list — old accounts land on *a*
 * valid portrait rather than the letter-initial glyph.
 */
function resolvePresetKey(key: string): PresetAvatarKey | undefined {
  if (Object.prototype.hasOwnProperty.call(PRESET_AVATAR_ART_URLS, key)) return key as PresetAvatarKey;
  if (/^\d+$/.test(key)) {
    const idx = parseInt(key, 10) % PRESET_AVATAR_KEYS.length;
    return PRESET_AVATAR_KEYS[idx]!;
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
 * Bust framing, as fractions of the circle's diameter: the head (hair top → neck, per
 * portraitHeadBox.ts) starts `HEAD_TOP` down and fills `HEAD_SPAN` of the circle, so the crop lands
 * at the neck and the shoulders stay out of frame. Wide heads (tsundere's pigtails, fanboy,
 * hero_infantry) hit `HEAD_MAX_W` first and are sized by width instead, or they'd burst the sides.
 * Picked from a Canvas2D side-by-side of all 26 real portraits at these three values ±0.04.
 */
const HEAD_TOP = 0.05;
const HEAD_SPAN = 0.90;
const HEAD_MAX_W = 0.88;

/** Nominal bust-portrait pixel size — every one of the 26 is 512×768; used only before the real texture loads. */
const BUST_W = 512, BUST_H = 768;

/**
 * Fit a portrait into the circle. With a head box (presets/heroes — the bust portraits) each
 * portrait is normalised against its OWN head geometry, which varies far more than the composition
 * brief suggests (hair top 0.03-0.13 of the image, neck 0.52-0.69, head width 0.58-0.94); one
 * global crop constant has to clear the loosest of them and leaves all the others looking small.
 *
 * Without one (`head: null`) — cardArt.ts's full-body battle renders, which the skin category still
 * borrows — fit by WIDTH and anchor to the TOP. Their heads sit flush against the top edge, so any
 * "cover then zoom" fit crops straight through the torso and loses the head entirely; a bit of
 * headroom keeps the art's top edge off the rim.
 */
function fitPortrait(sprite: PIXI.Sprite, tex: PIXI.Texture, size: number, head: HeadBox | null): void {
  const valid = tex.baseTexture.valid && tex.width > 1;
  if (!head) {
    sprite.scale.set(valid ? size / tex.width : size / 256);
    sprite.y = size * 0.03;
    return;
  }
  const texW = valid ? tex.width : BUST_W, texH = valid ? tex.height : BUST_H;
  const byHeight = (HEAD_SPAN * size) / ((head.bottom - head.top) * texH);
  const byWidth = (HEAD_MAX_W * size) / (head.width * texW);
  // Never below a plain width fit, or the circle's flanks would show the disc through the art.
  const scale = Math.max(size / texW, Math.min(byHeight, byWidth));
  sprite.scale.set(scale);
  sprite.y = HEAD_TOP * size - head.top * texH * scale;
}

/** A character portrait cropped to a circle of diameter `size`, framed per {@link fitPortrait}. */
function buildPortraitIcon(url: string, size: number, head: HeadBox | null): PIXI.Container {
  const c = new PIXI.Container();
  // getArtTexture (not bare Texture.from) so bust crops share the mipmap opt-in — avatar
  // circles shrink hero art hard, and a no-mipmap version winning the shared cache here
  // would drag the roster/detail portraits back down with it.
  const tex = getArtTexture(url);
  const sprite = new PIXI.Sprite(tex);
  sprite.anchor.set(0.5, 0);
  sprite.x = size / 2;
  const fit = () => fitPortrait(sprite, tex, size, head);
  fit();
  if (!tex.baseTexture.valid) {
    // The art loads async and the placeholder texture is 1×1, so the first fit runs on assumed
    // dimensions — exact for the busts (all 512×768), a guess for the full-body art. Nothing
    // re-renders an avatar (it's a leaf builder, not a scene), so re-fit in place once the real
    // size is known; `once` + the destroyed guard keeps this from outliving the sprite when the
    // screen is torn down mid-load.
    tex.baseTexture.once('loaded', () => { if (!sprite.destroyed) fit(); });
  }
  const mask = new PIXI.Graphics();
  mask.beginFill(0xffffff);
  mask.drawCircle(size / 2, size / 2, size / 2);
  mask.endFill();
  c.addChild(sprite);
  c.addChild(mask);
  sprite.mask = mask;
  return c;
}

/** Art side length for a category, given the tile side and the disc's radius. */
function categoryIconSize(category: AvatarCategory, size: number, r: number): number {
  return Math.round(category === 'title' ? size * ICON_FILL : r * 2 * PORTRAIT_FILL_OF_DISC);
}

/** Resolve the centred icon/portrait for any avatar category, or null if the key has no art (→ letter fallback). */
function categoryIcon(category: AvatarCategory, key: string, size: number): PIXI.DisplayObject | null {
  switch (category) {
    case 'preset': {
      const resolved = resolvePresetKey(key);
      return resolved
        ? buildPortraitIcon(PRESET_AVATAR_ART_URLS[resolved], size, PRESET_HEAD_BOX[resolved])
        : null;
    }
    case 'title':
      return spriteIcon(titleIconUrl(key), size) ?? buildIcon('trophy', size, palette.paper);
    case 'hero': {
      const url = HERO_AVATAR_ART_URLS[key as HeroAvatarKey];
      return url ? buildPortraitIcon(url, size, HERO_HEAD_BOX[key as HeroAvatarKey] ?? null) : null;
    }
    case 'skin': {
      // Full-body battle art, not a bust — no head box, so it falls back to the width fit.
      const unit = SKIN_TARGET_UNIT[key];
      const url = unit !== undefined ? UNIT_ART_URLS[unit] : undefined;
      return url ? buildPortraitIcon(url, size, null) : null;
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

  let iconS = Math.round(size * ICON_FILL);
  let icon: PIXI.DisplayObject | null = null;
  let bg: number = palette.inkBlue;
  if (parsed) {
    iconS = categoryIconSize(parsed.category, size, r);
    icon = categoryIcon(parsed.category, parsed.key, iconS);
    if (icon) bg = CATEGORY_BG[parsed.category];
  }

  const disc = new PIXI.Graphics();
  disc.beginFill(bg);
  disc.drawCircle(cx, cy, r);
  disc.endFill();
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

  // Pencil rim drawn LAST: a portrait now reaches within a few px of the disc's edge, and at small
  // tile sizes (list rows, map tokens) it would otherwise cover the inner half of the stroke and
  // leave the hand-drawn line looking thin and broken.
  const rim = new PIXI.Graphics();
  new SketchPen(rim, seed).circle(cx, cy, r, {
    color: palette.pencil, width: 2.2, jitter: 1.2,
  });
  c.addChild(rim);

  return c;
}
