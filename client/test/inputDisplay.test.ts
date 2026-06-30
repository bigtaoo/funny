import { describe, it, expect } from 'vitest';
import { caretDisplay } from '../src/render/inputDisplay';

const PH = 'tap to type';

describe('caretDisplay — empty field', () => {
  it('shows cursor when caretOn=true and no text', () => {
    expect(caretDisplay('', true, PH)).toBe('|');
  });

  it('shows placeholder when caretOn=false and no text (blink-off phase)', () => {
    expect(caretDisplay('', false, PH)).toBe(PH);
  });
});

describe('caretDisplay — field has text', () => {
  it('appends cursor when caretOn=true', () => {
    expect(caretDisplay('hello', true, PH)).toBe('hello|');
  });

  it('shows text without cursor when caretOn=false', () => {
    expect(caretDisplay('hello', false, PH)).toBe('hello');
  });
});

describe('caretDisplay — blinking sequence', () => {
  it('alternates between cursor-visible and cursor-hidden over a blink cycle', () => {
    const frames: string[] = [];
    let caretOn = true;
    for (let i = 0; i < 4; i++) {
      frames.push(caretDisplay('ab', caretOn, PH));
      caretOn = !caretOn;
    }
    expect(frames).toEqual(['ab|', 'ab', 'ab|', 'ab']);
  });

  it('blink-off on empty field shows placeholder, not empty string', () => {
    const frames: string[] = [];
    let caretOn = true;
    for (let i = 0; i < 4; i++) {
      frames.push(caretDisplay('', caretOn, PH));
      caretOn = !caretOn;
    }
    expect(frames).toEqual(['|', PH, '|', PH]);
  });
});

describe('caretDisplay — never returns empty string', () => {
  it('returns something even with empty text and caretOn=false', () => {
    expect(caretDisplay('', false, PH).length).toBeGreaterThan(0);
  });

  it('placeholder is used only when display would otherwise be empty', () => {
    // cursor on: '|' → non-empty, placeholder NOT used
    expect(caretDisplay('', true, PH)).not.toBe(PH);
    // cursor off + text: 'x' → non-empty, placeholder NOT used
    expect(caretDisplay('x', false, PH)).not.toBe(PH);
  });
});
