import { describe, expect, it } from 'vitest';
import { InMemoryFeedbackStore } from '../lib/feedback/store';
import { createFeedbackEntry, type FeedbackEntry } from '../lib/feedback/types';

function entry(
  id: string,
  correctCategory: FeedbackEntry['correctCategory'] = 'safe',
): FeedbackEntry {
  return {
    id,
    text: 'いけー！',
    normalizedText: 'いけー!',
    predictedCategory: 'backseat',
    predictedScore: 0.72,
    predictedAction: 'dim',
    correctCategory,
    judgement: 'incorrect',
    source: 'rules',
    ruleIds: ['BACKSEAT_IMPERATIVE_001'],
    features: ['imperative'],
    createdAt: Number(id.replace('feedback-', '')),
  };
}

describe('feedback store contract', () => {
  it('評価した本文以外の周辺コメント履歴を永続レコードへ含めない', async () => {
    const record = createFeedbackEntry({
      diagnostic: {
        id: 'diagnostic-1',
        text: 'いけー！',
        category: 'backseat',
        score: 0.72,
        action: 'dim',
        reasons: ['命令形'],
        source: 'rules',
        sameAuthorRecent: ['前のコメント'],
        recentRiskyMessages: ['別の投稿者のコメント'],
        timestamp: 1,
      },
      normalizedText: 'いけー!',
      judgement: 'incorrect',
      correctCategory: 'safe',
      id: 'feedback-private',
      createdAt: 1,
    });

    expect(record).not.toHaveProperty('sameAuthorRecent');
    expect(record).not.toHaveProperty('recentRiskyMessages');
    expect(record).toMatchObject({
      text: 'いけー！',
    });

    const store = new InMemoryFeedbackStore();
    await store.add(
      Object.assign(record, {
        sameAuthorRecent: ['保存してはいけない周辺投稿'],
        recentRiskyMessages: ['保存してはいけない別投稿'],
      }),
    );
    const [stored] = await store.list();
    expect(stored).not.toHaveProperty('sameAuthorRecent');
    expect(stored).not.toHaveProperty('recentRiskyMessages');
  });

  it('保存・exact memory・rule statsを一緒に更新する', async () => {
    const store = new InMemoryFeedbackStore();
    const result = await store.add(entry('feedback-1'));

    expect(result.exactMemory).toMatchObject({
      normalizedText: 'いけー!',
      sampleCount: 1,
      categoryCounts: { safe: 1 },
    });
    expect(await store.lookupExact('いけー!')).toEqual({
      category: 'safe',
      confidence: 1,
      sampleCount: 1,
    });
    expect(await store.listRuleStats()).toEqual([
      expect.objectContaining({
        ruleId: 'BACKSEAT_IMPERATIVE_001',
        incorrect: 1,
        falsePositive: 1,
      }),
    ]);
  });

  it('消去後は永続データを残さない', async () => {
    const store = new InMemoryFeedbackStore();
    await store.add(entry('feedback-1'));
    await store.clear();

    expect(await store.list()).toEqual([]);
    expect(await store.listExactMemories()).toEqual([]);
    expect(await store.listRuleStats()).toEqual([]);
    expect(await store.exportJsonl()).toBe('');
  });
});
