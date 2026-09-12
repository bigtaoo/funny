// header.ts — the fixed top band both CampaignMapScene pages (TOC + chapter) wear: the SceneHeader
// chrome + back pill, the right-aligned shortcut pills, and the scene-owned title/subtitle.
// Split out of ../CampaignMapScene.ts (2026-09-12) to bring that file back under the 500-line
// convention, form① (independent function module — the split-form priority in
// claudedocs/client-modules.md): it draws into a container the caller hands it, pushes into the
// caller's hit table, and reaches nothing on the scene but the design width/height and the three
// callbacks below. The layout order here is load-bearing and stays in one place — the shortcut
// pills are laid out FIRST because where they stop (`rightX`) is what decides the band the title
// is fitted into (the German-portrait finding, sweep §50.12).
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchButton, seedFor } from '../../render/sketchUi';
import { FS, fitFont } from '../../render/fontScale';
import { buildIcon, type IconKind } from '../../render/icons';
import { drawSceneHeader, buildTitleIcon } from '../../ui/widgets/SceneHeader';
import { t } from '../../i18n';
import type { Hit } from '../../ui/hits';

/** What the header needs from the scene: the two page-independent actions plus the page's own text. */
export interface CampaignHeaderOpts {
  /** Design-space viewport the band is laid out against. */
  w: number;
  h: number;
  title: string;
  /** Chapter pages only (the notebook owner). Present = the title rides above it and the pills drop to its row. */
  subtitle?: string;
  onBack: () => void;
  onOpenEquipment: () => void;
  /** Chapter pages only: the "back to the notebook overview" shortcut. Absent on the TOC (which IS that overview). */
  onChapters?: () => void;
}

/** Draws the fixed top band into `root`; returns its height. Pushes its hits onto `hits`. */
export function buildCampaignHeader(root: PIXI.Container, hits: Hit[], opts: CampaignHeaderOpts): number {
  const { w, h, title: titleStr, subtitle: subtitleStr } = opts;
  // Top-bar chrome (dark strip + back button top-left) is handled by SceneHeader;
  // the title is drawn here instead (when a subtitle is present the title rises slightly;
  // §3.1 allows title=null to let the scene own the title area).
  const hdr = drawSceneHeader(root, w, h, null);
  const tbH = hdr.headerH;

  hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: opts.onBack });

  // Right-aligned header shortcuts, each on the one true primary-button
  // background (sketchButton, §7.5) so they read as real buttons — matching
  // the Back pill — rather than bare gold text floating on the paper bar.
  // Laid out right→left; `rightX` walks left by each pill's width + gap.
  const fontSz = FS.label;
  const padX = Math.round(fontSz * 0.8);
  const pillH = Math.round(fontSz + padX * 1.4);
  const pillGap = Math.round(w * 0.02);
  let rightX = w - Math.round(w * 0.04);
  // The pills ride the SUBTITLE's row when there is one, not the title's (2026-09-12). The bar is
  // 12% of the design height — 230 design px in portrait — so a chapter page already uses it as
  // two rows: the title at 0.40 and the notebook owner at 0.72. Putting the shortcuts on the
  // title's row left it a 181-px band between the back pill and `Kapitel`, and German's "Kapitel
  // 2 · Trainingsgelände" needs 545 even before the glyph: it was drawn straight through both
  // pills (sweep §50.12), and shrinking it to the band would have meant a 12-design-px scene
  // title. On the owner's row the title gets the whole bar right of the back pill and needs no
  // shrinking at all; the owner line is short and centred, and is clamped off the pills below.
  const pillMidY = subtitleStr ? Math.round(tbH * 0.72) : Math.round(tbH / 2);

  // Each pill carries a leading glyph, the same [icon][gap][label] shape the
  // title beside it and the world-map header entries (WorldMapPanels/headerHud)
  // use, so a shortcut is recognizable before its two CJK characters are read.
  // The `'active'` bake is the light ink cut for a dark fill — `tabIconVariant`
  // would pick the de-emphasised `inactive` grey off the gold label colour,
  // which all but vanishes on the ink-dark pill.
  const iconSz = Math.round(fontSz * 1.15);
  const iconGap = Math.round(fontSz * 0.35);

  const addHeaderButton = (labelStr: string, icon: IconKind, fn: () => void): void => {
    const label = txt(labelStr, fontSz, C.gold, true);
    const groupW = iconSz + iconGap + label.width;
    const pillW = Math.round(groupW + padX * 2);
    const pillX = rightX - pillW;
    const pillY = Math.round(pillMidY - pillH / 2);

    const bg = sketchButton(pillW, pillH, seedFor(pillX, pillY, pillW));
    bg.x = pillX; bg.y = pillY;
    root.addChild(bg);

    const groupX = pillX + (pillW - groupW) / 2;
    const glyph = buildIcon(icon, iconSz, C.gold, { variant: 'active' });
    glyph.x = Math.round(groupX);
    glyph.y = Math.round(pillMidY - iconSz / 2);
    root.addChild(glyph);

    label.anchor.set(0, 0.5);
    label.x = Math.round(groupX + iconSz + iconGap); label.y = pillMidY;
    root.addChild(label);

    hits.push({ rect: { x: pillX, y: pillY, w: pillW, h: pillH }, fn });
    rightX = pillX - pillGap;
  };

  // Single growth-hub entry (LOBBY_IA_REDESIGN §9): merges the former separate
  // Collection/Equipment header links, matching the lobby's unified [Collection|Equipment] tab.
  // `equipIcon` is the same shield the lobby's Equipment tab and EquipmentScene wear.
  addHeaderButton(t('campaign.equipment'), 'equipIcon', () => opts.onOpenEquipment());

  // Chapter-page-only shortcut to the notebook overview (TOC), since Back now exits to the lobby directly.
  // The open-notebook `campaignTabIcon` reads as "back to the book" without colliding with the
  // treasure-map `pveTabIcon` this same bar already shows beside the title.
  const onChapters = opts.onChapters;
  if (onChapters) {
    addHeaderButton(t('campaign.chapters'), 'campaignTabIcon', () => onChapters());
  }

  // ── Title LAST, because the shortcut pills above are what decide how much room it has ──
  //
  // With a subtitle (chapter pages: notebook owner), the title rides slightly above center so the
  // dim owner line tucks beneath it; without one it centers. The `pveTabIcon` treasure map is the
  // same glyph LevelPrepScene and the achievement wall's PvE category use — the campaign IS the
  // PvE track, so all three show one picture. Laid out as the [icon][gap][title] group
  // drawSceneHeader would draw, just centred by hand because this scene owns the title (it may sit
  // above a subtitle line).
  //
  // The band is measured, not assumed (2026-09-12). This used to centre the group on the whole bar
  // with nothing to stop it: on a 360-wide phone German's "Kapitel 2 · Trainingsgelände" is 27
  // characters and was drawn straight through the `Kapitel`/`Ausrüstung` pills it is centred
  // against (sweep §50.12). On a chapter page the pills have moved to the owner's row (see
  // `pillMidY`), so the title's right edge is the bar's own inset; on the TOC they share its row
  // and `rightX` — where the pills stop — is the edge it has to respect. `fitFont` then chooses a
  // size off the shared scale for whatever band that leaves, rather than scaling the built node
  // under the legibility floor.
  const bandL = hdr.backRect.x + hdr.backRect.w + pillGap;
  const bandR = subtitleStr ? w - Math.round(w * 0.04) : rightX;
  const band = Math.max(Math.round(w * 0.2), bandR - bandL);
  const titleY = subtitleStr ? Math.round(tbH * 0.40) : tbH / 2;
  let icon = buildTitleIcon('pveTabIcon', FS.title, C.dark);
  const probe = txt(titleStr, FS.title, C.dark, true);
  const titleSize = fitFont(FS.title, icon.size + icon.gap + probe.width, band);
  probe.destroy({ texture: true, baseTexture: true });
  if (titleSize !== FS.title) {
    icon.node.destroy({ children: true });
    icon = buildTitleIcon('pveTabIcon', titleSize, C.dark);
  }
  const title = txt(titleStr, titleSize, C.dark, true);
  const groupW = icon.size + icon.gap + title.width;
  // Centred on the bar, then pushed back inside the band when the centre would put it under the
  // pills (same clamp drawSceneHeader applies against a currency cluster).
  const groupX = Math.max(bandL, Math.min(Math.round((w - groupW) / 2), bandR - groupW));
  icon.node.x = groupX;
  icon.node.y = Math.round(titleY - icon.size / 2);
  root.addChild(icon.node);
  title.anchor.set(0, 0.5); title.x = groupX + icon.size + icon.gap;
  title.y = titleY;
  root.addChild(title);

  if (subtitleStr) {
    const sub = txt(subtitleStr, FS.label, C.mid, false, Math.max(Math.round(w * 0.2), rightX - bandL));
    sub.anchor.set(0.5, 0.5);
    // Centred on the bar, but never into the pills that now share this row.
    sub.x = Math.min(w / 2, rightX - pillGap - sub.width / 2);
    sub.y = pillMidY;
    sub.alpha = 0.75;
    root.addChild(sub);
  }

  return tbH;
}
