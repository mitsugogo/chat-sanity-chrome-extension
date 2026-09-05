import { describe, expect, it } from 'vitest';
import { normalizeText } from '../lib/filter/normalize';

describe('normalizeText', () => {
  it('全角英数、空白、不可視文字を正規化する', () => {
    expect(normalizeText(' ＨＥＬＬＯ\u200B   ＷＯＲＬＤ ')).toBe(
      'hello world',
    );
  });

  it('過剰な連続文字と記号を圧縮する', () => {
    expect(normalizeText('ｗｗｗｗｗｗ！！！！')).toBe('ww!');
  });

  it('日本語の語中に挿入された空白を除去する', () => {
    expect(normalizeText('し ろ よ　今 日 は')).toBe('しろよ今日は');
  });
});
