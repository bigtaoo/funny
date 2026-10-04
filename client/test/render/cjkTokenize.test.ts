// cjkTokenize (client/src/render/pixiText.ts): the break units Pixi's wordWrap sees once
// installCjkWordWrap() has replaced TextMetrics.tokenize. Wrapping itself is Pixi's; the end-to-end
// behaviour (lines filled, words kept whole) is covered in test/ui/subscriptionDisclosureDialog.ui.ts.
import { describe, it, expect } from 'vitest';
import { cjkTokenize } from '../../src/render/pixiText';

describe('cjkTokenize', () => {
  it('makes every CJK character its own token', () => {
    expect(cjkTokenize('一二三')).toEqual(['一', '二', '三']);
  });

  it('keeps a Latin run whole and splits it from the CJK around it', () => {
    expect(cjkTokenize('向Apple申请')).toEqual(['向', 'Apple', '申', '请']);
    expect(cjkTokenize('向 Apple 申请')).toEqual(['向', ' ', 'Apple', ' ', '申', '请']);
  });

  it('glues closing punctuation to the token before it and opening punctuation to the one after', () => {
    expect(cjkTokenize('退款。好')).toEqual(['退', '款。', '好']);
    expect(cjkTokenize('Apple，会')).toEqual(['Apple，', '会']);
    expect(cjkTokenize('使用条款（EULA）')).toEqual(['使', '用', '条', '款', '（EULA）']);
    expect(cjkTokenize('说「好」')).toEqual(['说', '「好」']);
  });

  it('keeps a no-break space inside its word and splits at breaking spaces and newlines', () => {
    expect(cjkTokenize('Apple\u00A0ID 账户')).toEqual(['Apple\u00A0ID', ' ', '账', '户']);
    expect(cjkTokenize('甲\n乙')).toEqual(['甲', '\n', '乙']);
    expect(cjkTokenize('a\u3000b')).toEqual(['a', '\u3000', 'b']);
  });

  it('leaves Latin-only text tokenized the way Pixi does', () => {
    expect(cjkTokenize('May we tell Apple?')).toEqual(['May', ' ', 'we', ' ', 'tell', ' ', 'Apple?']);
    expect(cjkTokenize('')).toEqual([]);
  });

  it('treats an astral CJK character as one token', () => {
    expect(cjkTokenize('𠀀𠀁')).toEqual(['𠀀', '𠀁']);
  });
});
