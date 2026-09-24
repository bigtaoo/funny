/**
 * SubscriptionDisclosureDialog — the terms shown before an auto-renewable subscription purchase on
 * iOS (App Review guideline 3.1.2): what the card is, its length, its price, what it includes, how
 * auto-renewal works, and working links to the Terms of Use (EULA) and the Privacy Policy. Only
 * "Subscribe" continues to the StoreKit sheet.
 *
 * Stage-level overlay like FeedbackDialog: app.ts mounts it on `app.stage` above the live ShopScene
 * and raises `input.holdForModal` for its lifetime (see InputManager.modals for why the dim alone
 * cannot stop taps reaching the scene underneath).
 */
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../../render/pixiText';
import type { Scene } from '../../scenes/SceneManager';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../../render/sketchUi';
import { drawButtonLabel } from '../widgets/buttonLabel';
import { snapFont } from '../../render/fontScale';
import { t } from '../../i18n/index';
import { tapHandler } from '../hits';
import { legalUrl } from './ConsentDialog';
import type { SubscriptionDisclosureInfo } from './subscriptionDisclosure';
import { MONTHLY_CARD_DAILY_COINS, MONTHLY_CARD_IMMEDIATE_COINS, YEAR_CARD_IMMEDIATE_COINS } from '@nw/shared/economy/subscriptions';

/** App Store Connect uses Apple's standard license agreement for this app, so that is the EULA. */
export const APPLE_STANDARD_EULA_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

const CJK = '⺀-鿿豈-﫿＀-￯　-〿';
// One CJK character (plus any closing punctuation, so "。" never starts a line), one run of
// non-CJK non-space characters (a Latin word; U+00A0 does not split it), or a run of ASCII spaces.
const WRAP_TOKEN = new RegExp(`[${CJK}][。，、；：！？）」』]*|[^ \\t${CJK}]+|[ \\t]+`, 'g');

/**
 * Wrap mixed CJK/Latin text to `maxW`, measured with `style`. PIXI's own wordWrap breaks only at
 * spaces: with spaces around "Apple ID" it strands half a clause on its own line, and without them
 * `breakWords` cuts wherever the line fills — "Apple I" / "D". Here CJK breaks between characters,
 * Latin words stay whole, and only a single word wider than the line is split by characters.
 */
export function wrapMixed(text: string, style: PIXI.TextStyle, maxW: number): string {
  const width = (s: string): number => PIXI.TextMetrics.measureText(s, style).width;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const tok of para.match(WRAP_TOKEN) ?? []) {
      const space = tok.trim() === '';
      if (space) { if (line) line += tok; continue; }
      if (!line || width(line + tok) <= maxW) {
        line += tok;
      } else {
        lines.push(line.trimEnd());
        line = tok;
      }
      while (width(line) > maxW && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && width(line.slice(0, cut)) > maxW) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

export interface SubscriptionDisclosureCallbacks {
  onSubscribe(): void;
  onCancel(): void;
}

/** Text nodes built at one scale, plus the two stacked blocks they form. */
interface Blocks {
  nodes: { title: PIXI.Text; kind: PIXI.Text; details: PIXI.Text; terms: PIXI.Text; eula: PIXI.Text; privacy: PIXI.Text };
  /** Offsets inside the head block (title, kind, details) and its height. */
  head: { title: number; kind: number; details: number; h: number };
  /** Offsets inside the body block (terms, links, buttons) and its height. */
  body: { terms: number; eula: number; privacy: number; btn: number; h: number; hRow: number };
  bH: number;
  gapBtnBtn: number;
  padTop: number;
  padBottom: number;
  gapHeadBody: number;
}

/**
 * stack: one column, buttons stacked. stackRow: one column, buttons side by side (small portrait
 * phones). columns: head left, body right (a phone on its side).
 */
type Arrangement = 'stack' | 'stackRow' | 'columns';

export class SubscriptionDisclosureDialog implements Scene {
  readonly container: PIXI.Container;

  constructor(
    private readonly w: number,
    private readonly h: number,
    private readonly info: SubscriptionDisclosureInfo,
    private readonly cb: SubscriptionDisclosureCallbacks,
  ) {
    this.container = new PIXI.Container();
    // Overlay marker for the browser layout sweep (same convention as FeedbackDialog).
    this.container.name = 'overlay:subscription-disclosure';
    this.build();
  }

  update(): void { /* static */ }

  destroy(): void {
    this.container.removeAllListeners();
    this.container.destroy({ children: true });
  }

  private build(): void {
    const { w, h } = this;
    this.container.addChild(buildPaperBackground('subdisclosurebg', w, h));

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.45).drawRect(0, 0, w, h).endFill();
    dim.eventMode = 'static';
    dim.hitArea = new PIXI.Rectangle(0, 0, w, h);
    this.container.addChild(dim);

    const landscape = w > h;
    const cardHmin = landscape ? Math.round(h * 0.8) : Math.round(Math.min(h * 0.72, w * 0.9 * 1.15));
    const maxH = h * 0.96;

    // Try the single column first; in landscape fall back to two columns when it does not fit.
    // Each arrangement gets one rescale pass (ConsentDialog's approach). The font size has a
    // legibility floor, so a rescale alone cannot rescue a phone on its side: the columns can.
    const candidates: Array<{ arr: Arrangement; cardW: number; colW: number }> = [];
    if (landscape) {
      const stackW = Math.round(Math.min(w * 0.7, Math.max(cardHmin * 1.05, 460)));
      candidates.push({ arr: 'stack', cardW: stackW, colW: stackW * 0.84 });
      const colsW = Math.round(Math.min(w * 0.92, 900));
      candidates.push({ arr: 'columns', cardW: colsW, colW: colsW * 0.42 });
    } else {
      const stackW = Math.round(w * 0.9);
      candidates.push({ arr: 'stack', cardW: stackW, colW: stackW * 0.84 });
      candidates.push({ arr: 'stackRow', cardW: stackW, colW: stackW * 0.84 });
    }

    let chosen: { arr: Arrangement; cardW: number; B: Blocks; contentH: number } | null = null;
    for (const c of candidates) {
      let B = this.measure(cardHmin, c.colW);
      let contentH = this.contentH(B, c.arr);
      if (contentH > maxH) {
        this.destroyNodes(B);
        B = this.measure(Math.floor(cardHmin * (maxH / contentH)), c.colW);
        contentH = this.contentH(B, c.arr);
      }
      if (chosen) this.destroyNodes(chosen.B);
      chosen = { arr: c.arr, cardW: c.cardW, B, contentH };
      if (contentH <= maxH) break;
    }
    const { arr, cardW, B, contentH } = chosen!;

    const cardH = Math.min(Math.round(maxH), Math.max(cardHmin, Math.round(contentH)));
    const cardX = (w - cardW) / 2;
    const cardY = (h - cardH) / 2;
    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.dark, width: 2.6, seed: seedFor(cardW, cardH, 7) });
    card.x = cardX; card.y = cardY;
    this.container.addChild(card);

    // Column centres and block origins for the chosen arrangement.
    const headX = arr === 'columns' ? cardX + cardW * 0.26 : w / 2;
    const bodyX = arr === 'columns' ? cardX + cardW * 0.72 : w / 2;
    const headY = arr === 'columns'
      ? cardY + (cardH - B.head.h) / 2
      : cardY + B.padTop;
    const bodyY = arr === 'columns'
      ? cardY + (cardH - B.body.h) / 2
      : headY + B.head.h + B.gapHeadBody;

    const place = (node: PIXI.Text, x: number, y: number): void => {
      node.x = x; node.y = y;
      this.container.addChild(node);
    };
    place(B.nodes.title, headX, headY + B.head.title);
    place(B.nodes.kind, headX, headY + B.head.kind);
    place(B.nodes.details, headX, headY + B.head.details);
    place(B.nodes.terms, bodyX, bodyY + B.body.terms);
    place(B.nodes.eula, bodyX, bodyY + B.body.eula);
    place(B.nodes.privacy, bodyX, bodyY + B.body.privacy);
    this.makeLink(B.nodes.eula, APPLE_STANDARD_EULA_URL);
    this.makeLink(B.nodes.privacy, legalUrl('/privacy'));

    const bY = bodyY + B.body.btn;
    const fs = snapFont(Math.round(B.bH * 0.4));
    const subscribe = (x: number, y: number, bw: number): void => this.addButton(x, y, bw, B.bH,
      t('subDisclosure.subscribe'), 'check', C.green, 0xffffff, fs, 2, () => this.cb.onSubscribe());
    const cancel = (x: number, y: number, bw: number): void => this.addButton(x, y, bw, B.bH,
      t('common.cancel'), null, C.paper, C.dark, fs, 3, () => this.cb.onCancel());
    if (arr === 'stackRow') {
      const gap = Math.round(cardW * 0.04);
      const bW = Math.round(cardW * 0.4);
      const left = Math.round(bodyX - bW - gap / 2);
      subscribe(left, bY, bW);
      cancel(left + bW + gap, bY, bW);
    } else {
      const bW = Math.round(arr === 'columns' ? cardW * 0.36 : cardW * 0.6);
      const bX = Math.round(bodyX - bW / 2);
      subscribe(bX, bY, bW);
      cancel(bX, bY + B.bH + B.gapBtnBtn, bW);
    }
  }

  private contentH(B: Blocks, arr: Arrangement): number {
    return arr === 'columns'
      ? B.padTop + Math.max(B.head.h, B.body.h) + B.padBottom
      : B.padTop + B.head.h + B.gapHeadBody + (arr === 'stackRow' ? B.body.hRow : B.body.h) + B.padBottom;
  }

  private destroyNodes(B: Blocks): void {
    Object.values(B.nodes).forEach((n) => n.destroy());
  }

  /** Build the text nodes at `unit`, wrapped to `colW`, and measure the two blocks they form. */
  private measure(unit: number, colW: number): Blocks {
    const monthly = this.info.product === 'monthly_card';

    const title = txt(t(monthly ? 'shop.monthlyCard' : 'shop.yearCard'), snapFont(Math.round(unit * 0.07)), C.dark, true);
    title.anchor.set(0.5, 0);

    const kind = txt(t('subDisclosure.kind'), snapFont(Math.round(unit * 0.036)), C.mid);
    kind.anchor.set(0.5, 0);

    const detailLines = [
      t('subDisclosure.length', { period: t(monthly ? 'subDisclosure.periodMonth' : 'subDisclosure.periodYear') }),
      t(monthly ? 'subDisclosure.priceMonthly' : 'subDisclosure.priceYearly', { price: this.info.price }),
      t('subDisclosure.includes', {
        now: monthly ? MONTHLY_CARD_IMMEDIATE_COINS : YEAR_CARD_IMMEDIATE_COINS,
        daily: MONTHLY_CARD_DAILY_COINS,
      }),
    ];
    // Line height follows the snapped size, not `unit`: on a phone the size sits on the legibility
    // floor while `unit` keeps shrinking, and a unit-proportional line height stacked the rows.
    const detailsSize = snapFont(Math.round(unit * 0.042));
    const details = makeText('', {
      fontSize: detailsSize, fill: C.dark, fontFamily: 'monospace', align: 'center',
      lineHeight: Math.round(detailsSize * 1.35),
    });
    details.text = wrapMixed(detailLines.join('\n'), details.style, colW);
    details.anchor.set(0.5, 0);

    const termsSize = snapFont(Math.round(unit * 0.032));
    const terms = makeText('', {
      fontSize: termsSize, fill: C.mid, fontFamily: 'monospace', align: 'center',
      lineHeight: Math.round(termsSize * 1.3),
    });
    terms.text = wrapMixed(t('subDisclosure.terms'), terms.style, colW);
    terms.anchor.set(0.5, 0);

    // Link rows are spaced off their measured height for the same floor reason.
    const linkSize = snapFont(Math.round(unit * 0.04));
    const eula = txt('· ' + t('subDisclosure.eula'), linkSize, C.accent, true);
    eula.anchor.set(0.5, 0);
    const privacy = txt('· ' + t('consent.privacyPolicy'), linkSize, C.accent, true);
    privacy.anchor.set(0.5, 0);

    const padTop = unit * 0.06;
    const gapTitleKind = unit * 0.02;
    const gapKindDetails = unit * 0.05;
    const gapHeadBody = unit * 0.045;
    const gapTermsLink = unit * 0.045;
    const gapLinkLink = unit * 0.02;
    const gapLinkBtn = unit * 0.055;
    const bH = Math.round(unit * 0.11);
    const gapBtnBtn = unit * 0.03;
    const padBottom = unit * 0.06;

    const hKind = title.height + gapTitleKind;
    const hDetails = hKind + kind.height + gapKindDetails;
    const head = { title: 0, kind: hKind, details: hDetails, h: hDetails + details.height };

    const bEula = terms.height + gapTermsLink;
    const bPrivacy = bEula + eula.height + gapLinkLink;
    const bBtn = bPrivacy + privacy.height + gapLinkBtn;
    const body = { terms: 0, eula: bEula, privacy: bPrivacy, btn: bBtn, h: bBtn + bH * 2 + gapBtnBtn, hRow: bBtn + bH };

    return { nodes: { title, kind, details, terms, eula, privacy }, head, body, bH, gapBtnBtn, padTop, padBottom, gapHeadBody };
  }

  private addButton(
    x: number, y: number, w: number, h: number,
    label: string, icon: 'check' | null, fill: number, ink: number, fontSize: number,
    seedIdx: number, onTap: () => void,
  ): void {
    const box = sketchPanel(w, h, { fill, border: C.dark, width: 2.4, seed: seedFor(w, h, seedIdx) });
    box.x = x; box.y = y;
    box.eventMode = 'static';
    box.cursor = 'pointer';
    box.on('pointertap', tapHandler(onTap));
    this.container.addChild(box);
    drawButtonLabel(this.container, x, y, w, h, label, icon, ink, fontSize);
  }

  /** Make a placed link text open `url` outside the game when tapped. */
  private makeLink(link: PIXI.Text, url: string): void {
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointertap', tapHandler(() => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
    }));
  }
}
