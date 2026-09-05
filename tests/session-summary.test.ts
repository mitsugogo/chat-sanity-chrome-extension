import { describe, expect, it } from 'vitest';
import { aggregateSessionSummaries } from '../lib/session-summary';

describe('session summary aggregation', () => {
  it('同じタブのチャットフレームを集約する', () => {
    expect(
      aggregateSessionSummaries(
        [
          {
            tabId: 10,
            frameId: 3,
            summary: {
              active: true,
              hidden: 4,
              blurred: 2,
              lmStudio: 'unavailable',
              localAi: { activeProvider: 'rules', status: 'unavailable' },
            },
            updatedAt: 1,
          },
          {
            tabId: 10,
            frameId: 4,
            summary: {
              active: true,
              hidden: 1,
              blurred: 3,
              lmStudio: 'connected',
              localAi: { activeProvider: 'lm-studio', status: 'ready' },
            },
            updatedAt: 2,
          },
        ],
        'connected',
      ),
    ).toEqual({
      active: true,
      hidden: 5,
      blurred: 5,
      lmStudio: 'connected',
      localAi: { activeProvider: 'lm-studio', status: 'ready' },
    });
  });

  it('チャットがない場合もLM Studioの実接続状態を返す', () => {
    expect(aggregateSessionSummaries([], 'connected')).toEqual({
      active: false,
      hidden: 0,
      blurred: 0,
      lmStudio: 'connected',
      localAi: { activeProvider: 'rules', status: 'unavailable' },
    });
  });
});
