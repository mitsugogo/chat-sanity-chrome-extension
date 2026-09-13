import type {
  FeedbackEntry,
  FeedbackSummary,
  RuleFeedbackStats,
} from './types';

export function updateRuleFeedbackStats(
  current: RuleFeedbackStats | undefined,
  entry: FeedbackEntry,
  ruleId: string,
): RuleFeedbackStats {
  const next: RuleFeedbackStats = current
    ? { ...current }
    : {
        ruleId,
        evaluated: 0,
        correct: 0,
        incorrect: 0,
        falsePositive: 0,
        falseNegative: 0,
        precision: 0,
        lastUpdatedAt: entry.createdAt,
      };

  next.evaluated += 1;
  if (entry.judgement === 'correct') next.correct += 1;
  if (entry.judgement === 'incorrect') {
    next.incorrect += 1;
    next.falsePositive += 1;
  }
  if (entry.judgement === 'missed') next.falseNegative += 1;
  const classified = next.correct + next.incorrect;
  next.precision = classified === 0 ? 0 : round(next.correct / classified);
  next.lastUpdatedAt = entry.createdAt;
  return next;
}

export function summarizeFeedback(entries: FeedbackEntry[]): FeedbackSummary {
  const summary: FeedbackSummary = {
    total: entries.length,
    correct: 0,
    incorrect: 0,
    missed: 0,
  };
  for (const entry of entries) summary[entry.judgement] += 1;
  return summary;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
