import { describe, expect, it } from 'vitest';
import { normalizeText } from '../lib/filter/normalize';
import {
  addToExactMemory,
  exactFeedbackScore,
  FeedbackLearner,
  resolveExactFeedback,
} from '../lib/feedback/learner';
import {
  FEEDBACK_CATEGORY_CHOICES,
  isFeedbackMemoryPortMessage,
  type FeedbackEntry,
} from '../lib/feedback/types';

function entry(
  correctCategory: FeedbackEntry['correctCategory'],
  text = 'いけー！',
  id = 'feedback-1',
): FeedbackEntry {
  return {
    id,
    text,
    normalizedText: normalizeText(text),
    predictedCategory: 'backseat',
    predictedScore: 0.72,
    predictedAction: 'dim',
    correctCategory,
    judgement: 'incorrect',
    source: 'rules',
    ruleIds: ['BACKSEAT_IMPERATIVE_001'],
    features: ['imperative'],
    createdAt: 1,
  };
}

describe('FeedbackLearner', () => {
  it('既存の判定カテゴリを訂正候補として選択できる', () => {
    expect(FEEDBACK_CATEGORY_CHOICES).toEqual(
      expect.arrayContaining(['abuse', 'instruction', 'concern']),
    );
    expect(FEEDBACK_CATEGORY_CHOICES).not.toContain('hidden_user');
  });

  it('不正なport同期データを採用しない', () => {
    expect(
      isFeedbackMemoryPortMessage({
        kind: 'update',
        memory: {
          normalizedText: '死ね',
          categoryCounts: { safe: 1 },
          sampleCount: -1,
          updatedAt: 1,
        },
      }),
    ).toBe(false);
  });

  it('正規化済みの同一本文を過去のsafe訂正として利用する', () => {
    const first = entry('safe');
    const memory = addToExactMemory(undefined, first);
    const learner = new FeedbackLearner();
    learner.hydrate([memory]);

    expect(normalizeText('  いけー！  ')).toBe(first.normalizedText);
    expect(learner.lookupExact(normalizeText('  いけー！  '))).toEqual({
      category: 'safe',
      confidence: 1,
      sampleCount: 1,
    });
  });

  it('同じ本文のラベルが同数で競合するとexact memoryを使わない', () => {
    const first = entry('safe', 'もうそろそろ行けば？', 'feedback-safe');
    const second = entry(
      'backseat',
      'もうそろそろ行けば？',
      'feedback-backseat',
    );
    const once = addToExactMemory(undefined, first);
    const conflicted = addToExactMemory(once, second);

    expect(resolveExactFeedback(conflicted)).toBeNull();
  });

  it('1件の訂正は保守的なスコアで使い、繰り返しの根拠で強くする', () => {
    const once = {
      category: 'backseat' as const,
      confidence: 1,
      sampleCount: 1,
    };
    const repeated = { ...once, sampleCount: 3 };

    expect(exactFeedbackScore(once)).toBe(0.65);
    expect(exactFeedbackScore(repeated)).toBeGreaterThan(
      exactFeedbackScore(once),
    );
  });
});
