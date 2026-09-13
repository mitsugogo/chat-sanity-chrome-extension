import { describe, expect, it } from 'vitest';
import {
  feedbackEntriesToJsonl,
  parseFeedbackJsonl,
} from '../lib/feedback/export';
import type { FeedbackEntry } from '../lib/feedback/types';

const entries: FeedbackEntry[] = [
  {
    id: 'feedback-1',
    text: 'いけー！\nがんばれ！',
    normalizedText: 'いけー! がんばれ!',
    predictedCategory: 'backseat',
    predictedScore: 0.72,
    predictedAction: 'dim',
    correctCategory: 'safe',
    judgement: 'incorrect',
    source: 'rules',
    ruleIds: ['BACKSEAT_IMPERATIVE_001'],
    features: ['imperative'],
    createdAt: 1,
  },
  {
    id: 'feedback-2',
    text: 'ぺこらのせいだろ',
    normalizedText: 'ぺこらのせいだろ',
    predictedCategory: 'safe',
    predictedScore: 0.21,
    predictedAction: 'allow',
    correctCategory: 'blame',
    judgement: 'missed',
    source: 'fallback',
    ruleIds: [],
    features: [],
    createdAt: 2,
  },
];

describe('feedback JSONL export', () => {
  it('Unicodeと本文内改行を壊さず1行1JSONへ出力する', () => {
    const jsonl = feedbackEntriesToJsonl(entries);

    expect(jsonl.split('\n')).toHaveLength(2);
    expect(jsonl).toContain('ぺこらのせいだろ');
    expect(jsonl).toContain('\\n');
  });

  it('export/importでFeedbackEntryを往復できる', () => {
    expect(parseFeedbackJsonl(feedbackEntriesToJsonl(entries))).toEqual(
      entries,
    );
  });
});
