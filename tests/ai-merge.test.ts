import { describe, expect, it } from 'vitest';
import { mergeAiResult, createFilterEngine } from '../lib/filter/engine';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { FilterResult } from '../lib/types';

const base: FilterResult = {
  score: 0.7,
  action: 'dim',
  categories: ['backseat'],
  reasons: ['指示の可能性'],
  needsAi: true,
  ruleDisposition: 'matched',
};
function settings() {
  const value = structuredClone(DEFAULT_SETTINGS);
  value.lmStudio.enabled = true;
  return value;
}
describe('AI結果と設定の合成', () => {
  it('一時学習もカテゴリ無効・許可語句・AI無効を尊重する', () => {
    const value = settings();
    const message = {
      id: '1',
      author: 'a',
      text: '独自の皮肉表現',
      timestamp: 0,
      isOwner: false,
      isModerator: false,
      isMember: false,
      isPaidMessage: false,
    };
    const learned = {
      id: '',
      category: 'personal_attack' as const,
      score: 0.95,
    };
    expect(createFilterEngine()(message, value, learned).action).toBe('hide');
    value.allowedWords = [message.text];
    expect(createFilterEngine()(message, value, learned).action).toBe('allow');
    value.allowedWords = [];
    value.profiles.event.categories.personal_attack.enabled = false;
    expect(createFilterEngine()(message, value, learned).action).toBe('allow');
    value.profiles.event.categories.personal_attack.enabled = true;
    value.lmStudio.enabled = false;
    expect(createFilterEngine()(message, value, learned).action).toBe('allow');
    value.lmStudio.enabled = true;
    value.lmStudio.sessionLearning = false;
    expect(createFilterEngine()(message, value, learned).action).toBe('allow');
  });
  it('無効カテゴリによる非表示を適用しない', () => {
    expect(
      mergeAiResult(
        base,
        { id: '1', category: 'spoiler', score: 1 },
        settings(),
      ),
    ).toEqual({ ...base, needsAi: false });
  });
  it('カテゴリの重みを適用する', () => {
    const value = settings();
    value.profiles.event.categories.backseat.weight = 0.5;
    expect(
      mergeAiResult(base, { id: '1', category: 'backseat', score: 0.9 }, value),
    ).toMatchObject({ score: 0.45, action: 'allow' });
  });
  it('safe分類で曖昧なルールを緩和する', () => {
    expect(
      mergeAiResult(
        base,
        { id: '1', category: 'safe', score: 0.1 },
        settings(),
      ),
    ).toMatchObject({ action: 'allow', score: 0.1 });
  });
  it('単文AIで投稿頻度の証拠を上書きしない', () => {
    const spam = {
      ...base,
      categories: ['spam'] as FilterResult['categories'],
    };
    expect(
      mergeAiResult(
        spam,
        { id: '1', category: 'safe', score: 0.1 },
        settings(),
      ),
    ).toMatchObject({ score: 0.7, categories: ['spam'] });
  });
  it('確定済みルールと除外を上書きしない', () => {
    expect(
      mergeAiResult(
        { ...base, needsAi: false },
        { id: '1', category: 'personal_attack', score: 1 },
        settings(),
      ),
    ).toMatchObject({ score: 0.7 });
  });
  it('Zero-score Audit経由だけは未一致の0点へAI結果を適用する', () => {
    expect(
      mergeAiResult(
        {
          ...base,
          score: 0,
          action: 'allow',
          categories: ['safe'],
          needsAi: false,
          ruleDisposition: 'unmatched',
        },
        { id: '1', category: 'backseat', score: 0.9 },
        settings(),
        undefined,
        'zero-score-audit',
      ),
    ).toMatchObject({
      score: 0.9,
      action: 'hide',
      categories: ['backseat'],
      ruleDisposition: 'unmatched',
    });
  });
  it('空白のみの許可語句で全コメントを許可しない', () => {
    const value = settings();
    value.allowedWords = [' '];
    value.blockedWords = ['独自NG'];
    expect(
      createFilterEngine()(
        {
          id: '1',
          author: 'a',
          text: '独自NG',
          timestamp: 0,
          isOwner: false,
          isModerator: false,
          isMember: false,
          isPaidMessage: false,
        },
        value,
      ).action,
    ).toBe('hide');
  });
});
