import { describe, expect, it } from 'vitest';
import { updateRuleFeedbackStats } from '../lib/feedback/rule-stats';
import type { FeedbackEntry } from '../lib/feedback/types';

function entry(
  judgement: FeedbackEntry['judgement'],
  id: string,
): FeedbackEntry {
  return {
    id,
    text: `comment-${id}`,
    normalizedText: `comment-${id}`,
    predictedCategory: 'backseat',
    predictedScore: 0.72,
    predictedAction: 'dim',
    correctCategory: judgement === 'correct' ? 'backseat' : 'safe',
    judgement,
    source: 'rules',
    ruleIds: ['RULE_A'],
    features: ['imperative'],
    createdAt: Number(id.replaceAll('entry-', '')) || 1,
  };
}

describe('rule feedback stats', () => {
  it('正解8件・誤判定2件のprecisionを0.8として集計する', () => {
    let stats;
    for (let index = 1; index <= 8; index += 1)
      stats = updateRuleFeedbackStats(
        stats,
        entry('correct', `entry-${index}`),
        'RULE_A',
      );
    for (let index = 9; index <= 10; index += 1)
      stats = updateRuleFeedbackStats(
        stats,
        entry('incorrect', `entry-${index}`),
        'RULE_A',
      );

    expect(stats).toMatchObject({
      evaluated: 10,
      correct: 8,
      incorrect: 2,
      falsePositive: 2,
      falseNegative: 0,
      precision: 0.8,
    });
  });

  it('見逃しはfalse negativeとして別に残す', () => {
    const stats = updateRuleFeedbackStats(
      undefined,
      entry('missed', 'entry-1'),
      'RULE_A',
    );

    expect(stats).toMatchObject({
      evaluated: 1,
      correct: 0,
      incorrect: 0,
      falseNegative: 1,
      precision: 0,
    });
  });
});
