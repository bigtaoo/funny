// Mail tab: the mail list + rows, opening a mail, and the mail detail view (attachments + claim/delete).
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import type { MailView, MailAttachmentView } from '../../net/ApiClient';
import { type Constructor, type FriendsSceneBaseCtor } from './base';

export interface MailHandlers {
  drawMailList(): void;
  drawMailDetail(m: MailView): void;
}

export function MailMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<MailHandlers> {
  return class extends Base {
    // ── Mail tab ──────────────────────────────────────────────────────────────────

    drawMailList(): void {
      const { w, h } = this;
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.regionBottom = h - Math.round(h * 0.02);
      const regionH = this.regionBottom - this.regionTop;
      const { layer } = this.scrollRegion(regionH);

      if (this.loading) { this.centerLabel(layer, 'friends.loading', regionH); this.maxScroll = 0; return; }
      if (this.mail.length === 0) { this.centerLabel(layer, 'mail.empty', regionH); this.maxScroll = 0; return; }

      let cy = Math.round(h * 0.01);
      const screenY = (c: number) => this.regionTop + c - this.scrollY;
      const rowGap = Math.round(h * 0.014);
      const rh = Math.round(h * 0.10);
      for (const m of this.mail) {
        const sy = screenY(cy);
        if (this.rowVisible(sy, rh)) this.drawMailRow(layer, m, sy);
        cy += rh + rowGap;
      }
      this.maxScroll = Math.max(0, cy - regionH);
      if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
    }

    private drawMailRow(layer: PIXI.Container, m: MailView, y: number): void {
      const { h } = this;
      const rh = Math.round(h * 0.10);
      const rx = this.cX;
      const rw = this.cW;
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
      const tx = rx + Math.round(rw * 0.1);
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

      this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openMail(m) });
    }

    private openMail(m: MailView): void {
      this.openMailItem = m;
      this.scrollY = 0;
      if (!m.read) void this.cb.markMailRead(m.mailId).then(() => { m.read = true; });
      this.render();
    }

    drawMailDetail(m: MailView): void {
      const { w, h } = this;
      const top = this.bodyTop + Math.round(h * 0.02);
      const px = this.cX;
      const panelW = this.cW;

      const subj = txt(mailText(m.subject), FS.headline, C.dark, true);
      subj.anchor.set(0, 0); subj.x = px; subj.y = top;
      this.container.addChild(subj);
      const from = txt(m.fromName || (m.from === 'system' ? t('mail.system') : `#${m.from}`), FS.heading, C.mid);
      from.anchor.set(0, 0); from.x = px; from.y = top + Math.round(h * 0.05);
      this.container.addChild(from);

      const bodyTxt = new PIXI.Text(mailText(m.body), {
        fontSize: FS.heading, fill: C.dark, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: panelW, breakWords: true,
      });
      bodyTxt.x = px; bodyTxt.y = top + Math.round(h * 0.10);
      this.container.addChild(bodyTxt);

      let cy = bodyTxt.y + bodyTxt.height + Math.round(h * 0.03);
      const hasAtt = !!m.attachments && m.attachments.length > 0;
      if (hasAtt) {
        const label = txt(t('mail.attachments'), FS.heading, C.mid, true);
        label.anchor.set(0, 0); label.x = px; label.y = cy;
        this.container.addChild(label);
        cy += Math.round(h * 0.04);
        for (const a of m.attachments!) {
          const desc = attachmentLabel(a);
          const row = txt('· ' + desc, FS.heading, C.dark);
          row.anchor.set(0, 0); row.x = px + Math.round(w * 0.02); row.y = cy;
          this.container.addChild(row);
          cy += Math.round(h * 0.04);
        }
        cy += Math.round(h * 0.02);
        const bH = Math.round(h * 0.08);
        if (m.claimed) {
          const done = txt(t('mail.claimed'), FS.title, C.green, true);
          done.anchor.set(0.5, 0.5); done.x = this.cCX; done.y = cy + bH / 2;
          this.container.addChild(done);
        } else {
          this.addButton(t('mail.claim'), px, cy, panelW, bH, C.green, C.green, () => void this.doClaim(m), 0xffffff);
        }
        cy += bH + Math.round(h * 0.02);
      }

      const dH = Math.round(h * 0.07);
      const deleteBlocked = hasAtt && !m.claimed;
      this.addButton(t('mail.delete'), px, h - dH - Math.round(h * 0.03), panelW, dH, C.paper, deleteBlocked ? C.mid : C.red,
        () => deleteBlocked ? this.toast('mail.deleteBlockedAttachment') : void this.doMailDelete(m), deleteBlocked ? C.mid : C.red);
    }
  };
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
