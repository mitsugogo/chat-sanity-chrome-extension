import { describe, expect, it } from 'vitest';
import {
  AuthorHistory,
  ConflictScoreTracker,
  RecentRiskHistory,
} from '../lib/context';
import { createFilterEngine } from '../lib/filter/engine';
import { DEFAULT_SETTINGS } from '../lib/settings';
import type { ChatMessage } from '../lib/types';

const message = (
  text: string,
  timestamp: number,
  author = 'viewer',
): ChatMessage => ({
  id: String(timestamp),
  author,
  text,
  isOwner: false,
  isModerator: false,
  isMember: false,
  isPaidMessage: false,
  timestamp,
});

describe('チャット文脈', () => {
  it('対立スコアを加算し時間で減衰する', () => {
    const tracker = new ConflictScoreTracker();
    tracker.observe('personal_attack', 1, 1_000);
    expect(tracker.get(1_000)).toBe(0.5);
    expect(tracker.get(66_000)).toBeLessThan(0.25);
    expect(tracker.get(66_000)).toBeGreaterThan(0);
  });

  it('時刻0から始まるリプレイでも減衰する', () => {
    const tracker = new ConflictScoreTracker();
    tracker.observe('personal_attack', 1, 0);
    expect(tracker.get(65_000)).toBeLessThan(0.25);
  });

  it('カテゴリ別の対立度も独立して減衰する', () => {
    const tracker = new ConflictScoreTracker();
    tracker.observe('backseat', 1, 1_000);
    tracker.observe('backseat', 1, 1_100);
    tracker.observe('blame', 1, 1_100);
    expect(tracker.getCategoryLevels(1_100).backseat).toBeGreaterThan(0.5);
    expect(tracker.getCategoryLevels(1_100).blame).toBeGreaterThan(0.5);
    expect(tracker.getCategoryLevels(120_000).backseat).toBeLessThan(0.2);
  });

  it('同一投稿者と直近リスク本文だけを返す', () => {
    const authors = new AuthorHistory();
    authors.observe('a', '攻撃1', 1_000, 0.8);
    authors.observe('a', '安全', 1_100, 0.1);
    authors.observe('b', '別人', 1_200, 0.9);
    expect(authors.recent('a', 1_300)).toEqual(['攻撃1']);
    expect(authors.recent('a', 62_000)).toEqual([]);

    const recent = new RecentRiskHistory();
    recent.observe('攻撃1', 1_000, 0.8);
    recent.observe('安全', 1_100, 0.1);
    expect(recent.recent(1_200)).toEqual(['攻撃1']);
  });

  it('文脈補正は安全なリアクションを変更しない', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    const evaluate = createFilterEngine();
    const result = evaluate(message('テンポ悪い', 1_000), settings, null, {
      conflictLevel: 1,
      sameAuthorRecent: ['前の不満', 'その前の不満'],
      recentRiskyMessages: ['a', 'b', 'c'],
    });
    expect(result.categories).toContain('complaint');
    expect(result.score).toBeGreaterThan(0.39);
    expect(result.reasons).toContain('チャット全体の対立度による文脈補正');
    expect(
      evaluate(message('何してんのｗｗｗ', 2_000), settings, null, {
        conflictLevel: 1,
        sameAuthorRecent: ['攻撃', '攻撃2'],
        recentRiskyMessages: ['a', 'b', 'c'],
      }).action,
    ).toBe('allow');
    const ambiguous = evaluate(
      message('ちゃんとしてｗ', 3_000),
      settings,
      null,
      {
        categoryConflict: { backseat: 0.8 },
      },
    );
    expect(ambiguous.reasons).toContain('カテゴリ別の直近対立度による文脈補正');
    expect(ambiguous.action).toBe('allow');
  });
});
