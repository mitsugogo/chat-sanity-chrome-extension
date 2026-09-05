import { describe, expect, it } from 'vitest';
import { createFilterEngine } from '../lib/filter/engine';
import { SpamDetector } from '../lib/filter/spam';
import { DEFAULT_SETTINGS } from '../lib/settings';

describe('短時間スパム', () => {
  it('時間を空けた挨拶や応援を同文スパムにしない', () => {
    const spam = new SpamDetector();
    expect(spam.evaluate('a', 'ないす', 0)).toBe(0);
    expect(spam.evaluate('a', 'ないす', 11000)).toBe(0);
    expect(spam.evaluate('a', 'ないす', 22000)).toBe(0);
  });
  it('ユーザー間の同文応援は合算しない', () => {
    const spam = new SpamDetector();
    for (const author of ['a', 'b', 'c'])
      expect(spam.evaluate(author, 'ないす', 0)).toBe(0);
  });

  it('同文のリスク投稿を短時間に繰り返した場合だけ検出する', () => {
    const spam = new SpamDetector();
    expect(spam.evaluate('a', 'しっかりしろ', 0, 0.88)).toBe(0);
    expect(spam.evaluate('a', 'しっかりしろ', 10_000, 0.88)).toBe(0);
    expect(spam.evaluate('a', 'しっかりしろ', 20_000, 0.88)).toBeGreaterThan(
      0.8,
    );
  });

  it('内容カテゴリを表示設定にしても連投スパムは閾値で非表示にする', () => {
    const evaluate = createFilterEngine();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.profiles.event.categories.backseat.mode = 'allow';
    const message = (id: string, timestamp: number) => ({
      id,
      author: 'a',
      text: 'しっかりしろ',
      isOwner: false,
      isModerator: false,
      isMember: false,
      isPaidMessage: false,
      timestamp,
    });
    evaluate(message('1', 0), settings);
    evaluate(message('2', 10_000), settings);
    const result = evaluate(message('3', 20_000), settings);
    expect(result.categories).toContain('spam');
    expect(result.action).toBe('hide');
  });
  it('リプレイの巻き戻し後に未来の投稿を合算しない', () => {
    const spam = new SpamDetector();
    spam.evaluate('a', 'ないす', 9000);
    spam.evaluate('a', 'ないす', 9500);
    expect(spam.evaluate('a', 'ないす', 1000)).toBe(0);
  });
});
