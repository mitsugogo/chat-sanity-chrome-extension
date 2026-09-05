import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConflictScoreTracker } from '../lib/context';
import { createFilterEngine } from '../lib/filter/engine';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { ChatMessage, FilterAction, FilterCategory } from '../lib/types';

interface LabeledFixture {
  text: string;
  expectedCategory?: FilterCategory;
  expectedAction: FilterAction;
  requiresAi?: boolean;
  source: string;
}

interface ContextFixture {
  messages: string[];
  expectedConflictIncrease: boolean;
  source: string;
}

const readFixtures = (name: string) =>
  JSON.parse(
    readFileSync(`tests/evaluation/${name}.json`, 'utf8'),
  ) as LabeledFixture[];

const message = (text: string, index: number): ChatMessage => ({
  id: `evaluation-${index}`,
  author: `evaluation-author-${index}`,
  text,
  isOwner: false,
  isModerator: false,
  isMember: false,
  isPaidMessage: false,
  timestamp: 1_000 + index * 1_000,
});

describe('LLMなし分類器の評価フィクスチャ', () => {
  it('positiveの代表例をカテゴリとアクションへ分類する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    const fixtures = readFixtures('positive');
    const byCategory = new Map<FilterCategory, { tp: number; fn: number }>();
    let truePositive = 0;
    let falseNegative = 0;
    for (const [index, fixture] of fixtures.entries()) {
      const result = evaluate(message(fixture.text, index), settings);
      const matched =
        result.categories.includes(fixture.expectedCategory!) &&
        result.action === fixture.expectedAction;
      if (matched) truePositive += 1;
      else falseNegative += 1;
      const current = byCategory.get(fixture.expectedCategory!) ?? {
        tp: 0,
        fn: 0,
      };
      current[matched ? 'tp' : 'fn'] += 1;
      byCategory.set(fixture.expectedCategory!, current);
      expect(matched, `${fixture.source}: ${fixture.text}`).toBe(true);
    }
    for (const [category, counts] of byCategory) {
      const recall =
        counts.tp + counts.fn > 0 ? counts.tp / (counts.tp + counts.fn) : 1;
      expect(recall, `${category} recall`).toBe(1);
    }
    expect({ truePositive, falseNegative }).toEqual({
      truePositive: fixtures.length,
      falseNegative: 0,
    });
  });

  it('hard negativeはsafe/allowのまま保つ', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    const fixtures = readFixtures('hard-negative');
    let trueNegative = 0;
    let falsePositive = 0;
    for (const [index, fixture] of fixtures.entries()) {
      const result = evaluate(message(fixture.text, index), settings);
      if (result.action === 'allow') trueNegative += 1;
      else falsePositive += 1;
      expect(result.action, `${fixture.source}: ${fixture.text}`).toBe(
        fixture.expectedAction,
      );
      expect(result.categories[0], fixture.text).toBe('safe');
    }
    const precision =
      trueNegative + falsePositive > 0
        ? trueNegative / (trueNegative + falsePositive)
        : 1;
    const falsePositiveRate =
      trueNegative + falsePositive > 0
        ? falsePositive / (trueNegative + falsePositive)
        : 0;
    expect({
      trueNegative,
      falsePositive,
      precision,
      falsePositiveRate,
    }).toEqual({
      trueNegative: fixtures.length,
      falsePositive: 0,
      precision: 1,
      falsePositiveRate: 0,
    });
  });

  it('positiveとhard-negativeからTP/FP/TN/FNと3指標を算出する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    const evaluate = createFilterEngine();
    const positives = readFixtures('positive');
    const negatives = readFixtures('hard-negative');
    let truePositive = 0;
    let falseNegative = 0;
    let trueNegative = 0;
    let falsePositive = 0;
    for (const [index, fixture] of positives.entries()) {
      const result = evaluate(message(fixture.text, index), settings);
      if (
        result.action !== 'allow' &&
        result.categories.includes(fixture.expectedCategory!)
      )
        truePositive += 1;
      else falseNegative += 1;
    }
    for (const [index, fixture] of negatives.entries()) {
      const result = evaluate(message(fixture.text, index + 100), settings);
      if (result.action === 'allow') trueNegative += 1;
      else falsePositive += 1;
    }
    const precision = truePositive / (truePositive + falsePositive);
    const recall = truePositive / (truePositive + falseNegative);
    const falsePositiveRate = falsePositive / (falsePositive + trueNegative);
    expect({
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      precision,
      recall,
      falsePositiveRate,
    }).toEqual({
      truePositive: positives.length,
      falsePositive: 0,
      trueNegative: negatives.length,
      falseNegative: 0,
      precision: 1,
      recall: 1,
      falsePositiveRate: 0,
    });
  });

  it('ambiguousはLLMなしでも強制blurせず、LLM有効時は候補にする', () => {
    const withoutAi = structuredClone(DEFAULT_SETTINGS);
    withoutAi.lmStudio.enabled = false;
    const withAi = structuredClone(DEFAULT_SETTINGS);
    withAi.lmStudio.enabled = true;
    const evaluateWithoutAi = createFilterEngine();
    const evaluateWithAi = createFilterEngine();
    for (const [index, fixture] of readFixtures('ambiguous').entries()) {
      const noAi = evaluateWithoutAi(message(fixture.text, index), withoutAi);
      expect(noAi.action, fixture.text).toBe(fixture.expectedAction);
      expect(noAi.action).not.toBe('blur');
      const ai = evaluateWithAi(message(fixture.text, index + 100), withAi);
      expect(ai.needsAi, fixture.text).toBe(fixture.requiresAi);
    }
  });

  it('文脈フィクスチャは対立の増加と安全な連投を区別する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.lmStudio.enabled = false;
    for (const [fixtureIndex, fixture] of (
      JSON.parse(
        readFileSync('tests/evaluation/context-cases.json', 'utf8'),
      ) as ContextFixture[]
    ).entries()) {
      const tracker = new ConflictScoreTracker();
      const evaluate = createFilterEngine();
      const before = tracker.get(1_000);
      for (const [index, text] of fixture.messages.entries()) {
        const timestamp = 2_000 + index * 1_000;
        const result = evaluate(
          message(text, fixtureIndex * 20 + index),
          settings,
          null,
          {
            conflictLevel: tracker.get(timestamp),
            categoryConflict: tracker.getCategoryLevels(timestamp),
          },
        );
        tracker.observe(
          result.categories[0] ?? 'safe',
          result.score,
          timestamp,
        );
      }
      const after = tracker.get(10_000);
      expect(
        after > before,
        `${fixture.source}: ${fixture.messages.join(' / ')}`,
      ).toBe(fixture.expectedConflictIncrease);
    }
  });
});
