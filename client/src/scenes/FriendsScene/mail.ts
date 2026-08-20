// Mail tab: the mail list + rows, opening a mail, and the mail detail view (attachments + claim/delete).
//
// MailPanel depends on NetworkPanel (via NetworkHandlers — doClaim/doMailDelete) but NetworkPanel
// has no dependency back on it: one-way, so a plain independent class over `core` + `network`
// (2026-08-11 converted from the former `XMixin(Base)` inheritance chain, per
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { makeText } from '../../render/pixiText';
import { getEquipDef } from '../../game/meta/equipmentDefs';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { cardInstanceArtUrl, getArtTexture } from '../../render/cardArt';
import { buildRewardIcon } from '../../render/rewardIcon';
import type { MailView, MailAttachmentView } from '../../net/ApiClient';
import type { FriendsSceneCore } from './core';
import { addButton, centerLabel, scrollRegion } from './chrome';
import type { NetworkHandlers } from './network';

// ⚠️ Material-attachment id namespace: every server system that sends a `kind: 'material'` mail
// attachment (auctionsvc, worldsvc season rewards, battlepass, retention, events) uses the short
// `scrap`/`lead`/`binding` id — NOT the `mat_`-prefixed ids gacha grants directly into
// SaveData.materials (see GachaScene.MATERIAL_ICON, a different id namespace for a different
// source). Resolution now runs through `materialKind()` in render/rewardIcon.ts, which accepts the
// short ids only; keying it on `mat_` ids would silently drop every real attachment to the capsule.

export class MailPanel {
  /** Card art textures load async; tracks which URLs already have a re-render hooked on load. */
  private mailArtHooked = new Set<string>();

  constructor(private readonly core: FriendsSceneCore, private readonly network: NetworkHandlers) {}

  // ── Mail tab ──────────────────────────────────────────────────────────────────

  drawMailList(): void {
    const core = this.core;
    const { h } = core;
    core.regionTop = core.bodyTop + Math.round(h * 0.01);
    core.regionBottom = core.bodyBottom;
    const regionH = core.regionBottom - core.regionTop;
    const { layer } = scrollRegion(core, regionH);

    if (core.loading) { centerLabel(core, layer, 'friends.loading', regionH); core.maxScroll = 0; return; }
    if (core.mail.length === 0) { centerLabel(core, layer, 'mail.empty', regionH); core.maxScroll = 0; return; }

    let cy = Math.round(h * 0.01);
    const screenY = (c: number) => core.regionTop + c - core.scrollY;
    const rowGap = Math.round(h * 0.014);
    const rh = Math.round(h * 0.10);
    for (const m of core.mail) {
      const sy = screenY(cy);
      if (core.rowVisible(sy, rh)) this.drawMailRow(layer, m, sy);
      cy += rh + rowGap;
    }
    core.maxScroll = Math.max(0, cy - regionH);
    // Post-hoc clamp (mail deleted since the last render) — flag it so update() applies the shift
    // next frame; see the matching comment in friendsList.drawList.
    if (core.scrollY > core.maxScroll) { core.scrollY = core.maxScroll; core.scrollDirty = true; }
  }

  private drawMailRow(layer: PIXI.Container, m: MailView, y: number): void {
    const core = this.core;
    const { h } = core;
    const rh = Math.round(h * 0.10);
    const rx = core.cX;
    const rw = core.cW;
    const hasAtt = !!m.attachments && m.attachments.length > 0;
    const unclaimed = hasAtt && !m.claimed;
    const accent = !m.read ? C.gold : unclaimed ? C.green : C.mid;
    const bg = sketchPanel(rw, rh, { fill: C.paper, border: accent, width: 2, seed: seedFor(rx, 3, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, accent, seedFor(rx, rh, 11));
    layer.addChild(bg);

    if (!m.read) {
      const dot = new PIXI.Graphics();
      dot.beginFill(C.gold); dot.drawCircle(rx + Math.round(rw * 0.05), y + rh / 2, Math.round(rh * 0.08)); dot.endFill();
      layer.addChild(dot);
    }
    const tx = rx + 18;
    // Attachment marker: a hand-drawn gift glyph before the subject (replaces the 🎁 emoji).
    let subjX = tx;
    if (hasAtt) {
      const giftSz = Math.round(rh * 0.34);
      const gi = buildIcon('gift', giftSz, C.gold);
      gi.x = tx; gi.y = y + rh * 0.34 - giftSz / 2;
      layer.addChild(gi);
      subjX = tx + giftSz + Math.round(rw * 0.015);
    }
    const subj = txt(mailText(m.subject), snapFont(Math.round(rh * 0.3)), C.dark, true);
    subj.anchor.set(0, 0.5); subj.x = subjX; subj.y = y + rh * 0.34;
    layer.addChild(subj);
    const from = txt(m.fromName || (m.from === 'system' ? t('mail.system') : `#${m.from}`), snapFont(Math.round(rh * 0.22)), C.mid);
    from.anchor.set(0, 0.5); from.x = tx; from.y = y + rh * 0.70;
    layer.addChild(from);

    core.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openMail(m) });
  }

  private openMail(m: MailView): void {
    const core = this.core;
    core.openMailItem = m;
    core.scrollY = 0;
    if (!m.read) {
      void core.cb.markMailRead(m.mailId).then(() => {
        m.read = true;
        // Decrement the cached badge count immediately (2026-08-03 fix) — previously only the
        // individual mail's own `read` flag was updated, so the Mail-tab/lobby badge stayed at its
        // stale pre-read count until some other trigger forced a full refresh() (e.g. a tab switch),
        // making the unread dot appear stuck even after the player had read everything.
        core.mailUnread = Math.max(0, core.mailUnread - 1);
        core.render();
      });
    }
    core.render();
  }

  drawMailDetail(m: MailView): void {
    const core = this.core;
    const { w, h } = core;
    const top = core.bodyTop + Math.round(h * 0.02);
    const px = core.cX;
    const panelW = core.cW;

    const subj = txt(mailText(m.subject), FS.headline, C.dark, true);
    subj.anchor.set(0, 0); subj.x = px; subj.y = top;
    core.container.addChild(subj);
    const from = txt(m.fromName || (m.from === 'system' ? t('mail.system') : `#${m.from}`), FS.heading, C.mid);
    from.anchor.set(0, 0); from.x = px; from.y = top + Math.round(h * 0.05);
    core.container.addChild(from);

    const bodyTxt = makeText(mailText(m.body), {
      fontSize: FS.heading, fill: C.dark, fontFamily: 'monospace',
      wordWrap: true, wordWrapWidth: panelW, breakWords: true,
    });
    bodyTxt.x = px; bodyTxt.y = top + Math.round(h * 0.10);
    core.container.addChild(bodyTxt);

    let cy = bodyTxt.y + bodyTxt.height + Math.round(h * 0.03);
    const hasAtt = !!m.attachments && m.attachments.length > 0;
    if (hasAtt) {
      const label = txt(t('mail.attachments'), FS.heading, C.mid, true);
      label.anchor.set(0, 0); label.x = px; label.y = cy;
      core.container.addChild(label);
      cy += Math.round(h * 0.04);
      for (const a of m.attachments!) {
        const desc = attachmentLabel(a);
        const row = txt('· ' + desc, FS.heading, C.dark);
        row.anchor.set(0, 0); row.x = px + Math.round(w * 0.02); row.y = cy;
        core.container.addChild(row);
        cy += Math.round(h * 0.04);
      }
      // One picture per attachment, laid out left-to-right below the name list.
      const iconSize = Math.round(h * 0.07);
      const iconGap = Math.round(w * 0.015);
      let ix = px + Math.round(w * 0.02);
      for (const a of m.attachments!) {
        this.drawAttachmentIcon(a, ix, cy, iconSize, seedFor(ix, cy, iconSize));
        ix += iconSize + iconGap;
      }
      cy += iconSize + Math.round(h * 0.02);
      const bH = Math.round(h * 0.08);
      if (m.claimed) {
        const done = txt(t('mail.claimed'), FS.title, C.green, true);
        done.anchor.set(0.5, 0.5); done.x = core.cCX; done.y = cy + bH / 2;
        core.container.addChild(done);
      } else {
        addButton(core, t('mail.claim'), px, cy, panelW, bH, C.green, C.green, () => void this.network.doClaim(m), 0xffffff);
      }
      cy += bH + Math.round(h * 0.02);
    }

    const dH = Math.round(h * 0.07);
    const deleteBlocked = hasAtt && !m.claimed;
    addButton(core, t('mail.delete'), px, core.bodyBottom - dH - Math.round(h * 0.01), panelW, dH, C.paper, deleteBlocked ? C.mid : C.red,
      () => deleteBlocked ? core.toast('mail.deleteBlockedAttachment') : void this.network.doMailDelete(m), deleteBlocked ? C.mid : C.red);
  }

  /**
   * A single attachment's picture (framed square). Reuses the same "single source of truth"
   * resolvers as Equipment/Auction/Gacha (buildEquipIcon / card art / buildMaterialIcon) so a
   * claimed item's mail thumbnail matches how it looks everywhere else, instead of inventing a
   * mail-only art path.
   */
  private drawAttachmentIcon(a: MailAttachmentView, x: number, y: number, size: number, seed: number): void {
    const core = this.core;
    const frame = sketchPanel(size, size, { fill: C.paper, border: C.mid, seed });
    frame.x = x; frame.y = y;
    core.container.addChild(frame);
    const cx = x + size / 2;
    const cy = y + size / 2;
    const picSize = Math.round(size * 0.7);

    if (a.kind === 'equipment' && a.instance) {
      const def = getEquipDef(a.instance.defId);
      if (def) {
        const icon = buildEquipIcon(a.instance.defId, def.slot, def.rarity, picSize, seed);
        icon.x = cx; icon.y = cy;
        core.container.addChild(icon);
        return;
      }
    } else if (a.kind === 'card' && a.instance) {
      const artUrl = cardInstanceArtUrl(a.instance) ?? undefined;
      if (artUrl) {
        const tex = getArtTexture(artUrl);
        if (tex.baseTexture.valid) {
          const scale = Math.min(picSize / tex.width, picSize / tex.height);
          const sp = new PIXI.Sprite(tex);
          sp.anchor.set(0.5); sp.scale.set(scale); sp.position.set(cx, cy);
          core.container.addChild(sp);
          return;
        }
        if (!this.mailArtHooked.has(artUrl)) {
          this.mailArtHooked.add(artUrl);
          tex.baseTexture.once('loaded', () => core.render());
        }
      }
    }
    // Everything else (coins / material / skin, plus an equipment or card attachment whose
    // instance or def has vanished) goes through the shared reward resolver, so it matches the
    // same reward on the daily / battle-pass / event / recharge screens. `materialFallback: null`
    // keeps an unrecognised material id on the generic capsule rather than mislabelling it as
    // scrap — which is also the safety net for the id-namespace trap noted above the class.
    const icon = buildRewardIcon(a, picSize, a.kind === 'coins' ? C.gold : C.dark, { materialFallback: null })
      ?? buildIcon('capsule', picSize, C.dark);
    icon.x = cx - picSize / 2; icon.y = cy - picSize / 2;
    core.container.addChild(icon);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function attachmentLabel(a: MailAttachmentView): string {
  const n = a.count ?? 1;
  if (a.kind === 'coins') return t('mail.attCoins', { n });
  if (a.kind === 'skin') return t('mail.attSkin', { id: a.id ?? '' });
  if (a.kind === 'material') return t('mail.attMaterial', { id: a.id ?? '', n });
  // equipment/card attachments carry a full instance snapshot (auction escrow-out); show localized name + level.
  if (a.kind === 'equipment') {
    return t('mail.attEquip', { name: defDisplayName('equip', a.instance?.defId ?? ''), lvl: a.instance?.level ?? 0 });
  }
  if (a.kind === 'card') {
    return t('mail.attCard', { name: defDisplayName('card', a.instance?.defId ?? ''), lvl: a.instance?.level ?? 0 });
  }
  return t('mail.attItem', { id: a.id ?? '', n });
}

/** System mail subject/body arrive as i18n keys (e.g. `auction.mail.returned.subject`); player-authored mail
 *  (friend/family messages) arrives as plain text. Translate if it resolves to a known key, else show as-is. */
function mailText(raw: string): string {
  // System-mail subject/body are i18n keys. Some carry pipe-delimited params for interpolation:
  // `key|name=value|name2=value2` (e.g. SLG season settlement `slg.settle.body|rank=1|nations=2`).
  const [key, ...paramParts] = raw.split('|');
  const k = key as TranslationKey;
  if (paramParts.length === 0) {
    const s = t(k);
    return s === key ? raw : s;
  }
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const s = t(k, params);
  return s === key ? raw : s; // key missing → t() returns the bare key; fall back to the raw string
}

/** Localized def display name (`equip.<defId>.name` / `card.<defId>.name`); falls back to the raw defId. */
function defDisplayName(prefix: 'equip' | 'card', defId: string): string {
  if (!defId) return '';
  const key = `${prefix}.${defId}.name` as TranslationKey;
  const s = t(key);
  return s === key ? defId : s;
}
