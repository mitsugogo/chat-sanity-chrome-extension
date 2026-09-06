import { describe, expect, it } from 'vitest';
import {
  detectAbilityAttack,
  detectBlame,
  detectImperative,
  detectMetaConflict,
  detectTarget,
} from '../lib/filter/features';
import { createFilterEngine } from '../lib/filter/engine';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { ChatMessage } from '../lib/types';

const message = (text: string, timestamp = 1_000): ChatMessage => ({
  id: text,
  author: `fixture-${text}`,
  text,
  isOwner: false,
  isModerator: false,
  isMember: false,
  isPaidMessage: false,
  timestamp,
});

describe('ルール分類feature', () => {
  it('対象を人物・役割とゲーム内対象に分ける', () => {
    expect(detectTarget('○○が悪い').targetType).toBe('person');
    expect(detectTarget('リーダー仕事しろ').targetType).toBe('role');
    expect(detectTarget('武器が使えない').targetType).toBe('game-object');
    expect(detectTarget('範囲キモい笑').targetType).toBe('game-object');
  });

  it('責任追及と能力攻撃は対象つきで検出する', () => {
    expect(detectBlame('○○が悪い').matched).toBe(true);
    expect(detectAbilityAttack('○○向いてない').matched).toBe(true);
    expect(detectAbilityAttack('武器が使えない').matched).toBe(false);
    expect(detectAbilityAttack('下手').matched).toBe(false);
    expect(detectBlame('ヴィヴィのせいでもない').matched).toBe(false);
  });

  it.each([
    ['リーダー声かけしなさいw', 0.72],
    ['ちゃんと確認しなー', 0.58],
    ['テリジノ使ってくれ', 0.42],
    ['みこちご飯食べないと', 0.42],
    ['早く戻るべきですね', 0.42],
  ])('「%s」を文脈付きの行動誘導として候補化する', (text, score) => {
    expect(detectImperative(text)).toMatchObject({ matched: true, score });
  });

  it('曖昧な指示は低確信のままルールのみでは許可する', () => {
    const imperative = detectImperative('何してんの');
    expect(imperative).toMatchObject({ matched: true, score: 0.42 });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    for (const [index, text] of [
      '何してんの',
      'それでいいの？',
      '大丈夫か？',
      'リーダー頼むぞ',
      'ちゃんとしてｗ',
      '指示してあげてもいいかも',
    ].entries()) {
      expect(
        evaluate(message(text, 1_000 + index * 1_000), settings).action,
        text,
      ).toBe('allow');
    }
  });

  it('攻撃的なmetaと平和化のmetaを区別する', () => {
    expect(detectMetaConflict('自治厨うざい')).toMatchObject({
      detected: true,
      aggressive: true,
      peacekeeping: false,
    });
    expect(detectMetaConflict('荒らしは無視しよう')).toMatchObject({
      detected: true,
      aggressive: false,
      peacekeeping: true,
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const result = createFilterEngine()(message('荒らしは無視しろ'), settings);
    expect(result.categories).toContain('meta_conflict');
    expect(result.action).toBe('allow');
  });

  it.each([
    'お前ら指示するなよ！',
    'アドバイス指示中自重しな？',
    'コメ欄はいったん落ち着け',
  ])('コメント欄への平和化発言「%s」はbackseatにしない', (text) => {
    expect(detectMetaConflict(text)).toMatchObject({
      detected: true,
      aggressive: false,
      peacekeeping: true,
      score: 0.25,
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const result = createFilterEngine()(message(text), settings);
    expect(result.categories).not.toContain('backseat');
    expect(result.features).toContain('peacekeeping-meta-conflict');
    expect(result.action).toBe('allow');
  });
});
