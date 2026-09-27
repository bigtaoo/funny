// Shared plumbing for the SettingsScene UI suites (test/ui/settings*.ui.ts).
//
// Since the flow-layout rewrite (UI_DESIGN_LOG_2026-09 §65) the page scrolls once it is taller than
// the viewport, and a row below the fold has NO hit rect until it is scrolled into view — the scene
// only registers what is on screen. So "find the hit for this label" has to scroll first, the way a
// player would; `reveal()` does that and every suite goes through it.
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { SettingsScene, type SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { Hit } from '../../src/ui/hits';
import type { Rect } from '../../src/layout/ILayout';
import type { AudioSlider } from '../../src/scenes/SettingsScene/audioPanel';
import { createFakeTextInput } from './fakeTextInput';

export interface TextNode { text: string; top: number; bottom: number; left: number; right: number; size: number; fill: number | null }

/** A text's fill as a 0xRRGGBB number (PIXI normalises it to "#rrggbb"), comparable with the `ui` tokens. */
function fillColor(f: unknown): number | null {
  if (typeof f === 'number') return f;
  return typeof f === 'string' && /^#[0-9a-f]{6}$/i.test(f) ? parseInt(f.slice(1), 16) : null;
}

/** Every PIXI.Text under `root`, with its on-screen bounds and post-scale font size. */
export function collectTexts(root: PIXI.Container): TextNode[] {
  const out: TextNode[] = [];
  // No `children ?? []` fallback on purpose: handed the wrong object this must throw, not quietly
  // return an empty tree that every assertion then reads as "the row is missing".
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) {
        const b = ch.getBounds();
        out.push({
          text: ch.text, top: b.y, bottom: b.y + b.height, left: b.x, right: b.x + b.width,
          size: Number(ch.style.fontSize) * ch.scale.y, fill: fillColor(ch.style.fill),
        });
        continue;
      }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

export function findText(nodes: TextNode[], text: string): TextNode {
  const hit = nodes.find((n) => n.text === text);
  if (!hit) throw new Error(`no text node "${text}" (have: ${nodes.map((n) => n.text).join(' | ')})`);
  return hit;
}

/** A logged-in player with every optional section present. */
export const ONLINE: Partial<SettingsSceneCallbacks> = {
  publicId: '123456789',
  pvp: { rank: 'bronze', elo: 1000 },
  renameCost: 500,
  getCoins: () => 0,
  onRename: async (name: string) => ({ ok: true, name }),
  onReplayTutorial() {},
  onLogout() {},
  onDeleteAccount: async () => ({ ok: true }),
};

export function buildSettings(w: number, h: number, cb: Partial<SettingsSceneCallbacks> = ONLINE): SettingsScene {
  return mountSettings(w, h, cb).s;
}

/**
 * The scene plus the InputManager it listens to, for suites that drive it through real pointer
 * events. `design` overrides the design rect the scene reads (only designWidth/designHeight are
 * read): the headless text stub measures lines short, so a squashed rect is how a suite gets a page
 * that overflows — see settingsPageScroll.ui.ts.
 */
export function mountSettings(
  w: number, h: number, cb: Partial<SettingsSceneCallbacks> = ONLINE, design?: readonly [number, number],
): { s: SettingsScene; input: InputManager } {
  const input = new InputManager();
  const real = createLayout(w, h);
  const layout = design
    ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { designWidth: design[0], designHeight: design[1] })
    : real;
  const s = new SettingsScene(layout, input, {
    onBack() {},
    playerName: 'Tester',
    openTextInput: createFakeTextInput().openTextInput,
    ...cb,
  } as SettingsSceneCallbacks);
  return { s, input };
}

/** A portrait design rect too short for the page (1080 wide, 1200 tall). */
export const SHORT = [1080, 1200] as const;

/** Press and release at a text node's centre, through the InputManager. */
export function tap(input: InputManager, n: TextNode): void {
  const x = (n.left + n.right) / 2, y = (n.top + n.bottom) / 2;
  input._emitDown(x, y);
  input._emitUp(x, y);
}

/** The fields the suites read; reached through TS privacy, as every scene suite here does. */
export function internals(s: SettingsScene): { hits: Hit[]; audioSliders: AudioSlider[] } {
  return s as unknown as { hits: Hit[]; audioSliders: AudioSlider[] };
}

/** On-screen viewport of the page (below the header). */
export function pageView(s: SettingsScene): Rect {
  return (s as unknown as { pageView: Rect }).pageView;
}

export function scrollTo(s: SettingsScene, y: number): void {
  s.pageScrollY = Math.max(0, Math.min(y, s.pageMaxScroll));
  s.render();
}

/**
 * Scroll until the text `label` is fully inside the viewport (if it is not already) and return its
 * node. Throws when no scroll position shows it — i.e. the row is unreachable.
 */
export function reveal(s: SettingsScene, label: string): TextNode {
  const view = pageView(s);
  let node = findText(collectTexts(s.container), label);
  if (node.top >= view.y && node.bottom <= view.y + view.h) return node;
  scrollTo(s, s.pageScrollY + (node.top - view.y) - view.h / 3);
  node = findText(collectTexts(s.container), label);
  if (node.top < view.y || node.bottom > view.y + view.h) {
    throw new Error(`"${label}" is not reachable by scrolling (top ${node.top}, view ${JSON.stringify(view)})`);
  }
  return node;
}

/** The hit containing a point, the way a tap resolves one (first pushed wins). */
export function hitAt(s: SettingsScene, x: number, y: number): Hit | undefined {
  return internals(s).hits.find((h) => h.rect.x <= x && x <= h.rect.x + h.rect.w && h.rect.y <= y && y <= h.rect.y + h.rect.h);
}

/**
 * The hit on the same row as `label`, to its right (a row's control), after scrolling it into view.
 * "Same row" = the nearest control by vertical centre within a row's reach: a row with a wrapped
 * hint puts its label at the top and centres the control on the whole row, so the label's own
 * mid-line need not cross the control's rect.
 */
export function controlHit(s: SettingsScene, label: string): Hit {
  const node = reveal(s, label);
  const midY = (node.top + node.bottom) / 2;
  const cy = (h: Hit): number => h.rect.y + h.rect.h / 2;
  const hit = internals(s).hits
    .filter((h) => h.rect.x > node.right && Math.abs(cy(h) - midY) < 120)
    .sort((a, b) => Math.abs(cy(a) - midY) - Math.abs(cy(b) - midY))[0];
  if (!hit) throw new Error(`no control to the right of "${label}" (rects: ${JSON.stringify(internals(s).hits.map((x) => x.rect))})`);
  return hit;
}

/** The hit whose rect covers the middle of `label`'s text — a whole-row link, after revealing it. */
export function rowHit(s: SettingsScene, label: string): Hit {
  const node = reveal(s, label);
  const hit = hitAt(s, (node.left + node.right) / 2, (node.top + node.bottom) / 2);
  if (!hit) throw new Error(`no hit under "${label}"`);
  return hit;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
