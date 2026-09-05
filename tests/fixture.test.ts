import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFilterEngine } from '../lib/filter/engine';
import { normalizeText } from '../lib/filter/normalize';
import { isObviouslySafe } from '../lib/filter/obvious-safe';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { ChatMessage, FilterCategory } from '../lib/types';

interface Fixture {
  text: string;
  expected: FilterCategory;
  reason?: string;
}

const fixtures = JSON.parse(
  readFileSync('tests/fixtures/chat-classification.json', 'utf8'),
) as Fixture[];

const message = (text: string, index: number): ChatMessage => ({
  id: 'fixture-' + index,
  author: 'fixture-author-' + index,
  text,
  isOwner: false,
  isModerator: false,
  isMember: false,
  isPaidMessage: false,
  timestamp: 1_000 + index * 1_000,
});

describe('提供データから匿名化した分類フィクスチャ', () => {
  it('hard negativeをsafeとして扱う', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.expected !== 'safe') continue;
      const result = evaluate(message(fixture.text, index), settings);
      expect(
        {
          text: fixture.text,
          action: result.action,
          category: result.categories[0],
        },
        fixture.reason,
      ).toMatchObject({ action: 'allow', category: 'safe' });
      expect(
        isObviouslySafe(normalizeText(fixture.text)) ||
          result.action === 'allow',
      ).toBe(true);
    }
  });

  it('positiveを指定カテゴリへ分類する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    for (const [index, fixture] of fixtures.entries()) {
      if (fixture.expected === 'safe') continue;
      const result = evaluate(message(fixture.text, index), settings);
      expect(result.categories, fixture.text).toContain(fixture.expected);
    }
  });

  it('曖昧な助言だけをローカルAI候補にする', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = true;
    const result = createFilterEngine()(
      message('回復した方がいいかも', 100),
      settings,
    );
    expect(result.categories).toContain('backseat');
    expect(result.score).toBeGreaterThanOrEqual(settings.lmStudio.uncertainMin);
    expect(result.score).toBeLessThanOrEqual(settings.lmStudio.uncertainMax);
    expect(result.needsAi).toBe(true);
  });
});
