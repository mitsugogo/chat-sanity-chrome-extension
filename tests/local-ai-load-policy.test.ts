import { describe, expect, it } from 'vitest';
import {
  CHROME_BUILT_IN_ALL_UNMATCHED_BATCH_WINDOW_MS,
  CHROME_BUILT_IN_BATCH_WINDOW_MS,
  CHROME_BUILT_IN_MAX_BATCH_SIZE,
  CHROME_BUILT_IN_MIN_REST_MS,
  LOCAL_AI_MAX_PENDING_BATCHES,
  LOCAL_AI_MAX_QUEUE_AGE_MS,
  resolveLocalAiLoadPolicy,
} from '../lib/local-ai/load-policy';
import { DEFAULT_SETTINGS } from '../lib/settings';

describe('resolveLocalAiLoadPolicy', () => {
  it.each(['auto', 'chrome-built-in'] as const)(
    '%sでChromeが有効なら安全側の上限を使う',
    (mode) => {
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.localAiMode = mode;
      settings.lmStudio.batchSize = 20;
      const policy = resolveLocalAiLoadPolicy(settings);

      expect(policy).toEqual({
        batchWindowMs: CHROME_BUILT_IN_BATCH_WINDOW_MS,
        maxBatchSize: CHROME_BUILT_IN_MAX_BATCH_SIZE,
        maxPendingBatches: LOCAL_AI_MAX_PENDING_BATCHES,
        maxQueueAgeMs: LOCAL_AI_MAX_QUEUE_AGE_MS,
        flushOnFull: false,
        minRestMs: CHROME_BUILT_IN_MIN_REST_MS,
        zeroScoreAudit: {
          baseProbability: 0.01,
          maxPerMinute: 3,
          maxPending: 2,
        },
      });
    },
  );

  it('LM Studio単独では既存設定値を維持する', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.localAiMode = 'lm-studio';
    settings.lmStudio.batchSize = 17;
    settings.lmStudio.batchWindowMs = 480;
    const policy = resolveLocalAiLoadPolicy(settings);

    expect(policy.batchWindowMs).toBe(480);
    expect(policy.maxBatchSize).toBe(17);
    expect(policy.flushOnFull).toBe(true);
    expect(policy.minRestMs).toBe(0);
    expect(policy.zeroScoreAudit).toEqual({
      baseProbability: settings.lmStudio.zeroScoreAudit.baseProbability,
      maxPerMinute: settings.lmStudio.zeroScoreAudit.maxPerMinute,
      maxPending: settings.lmStudio.zeroScoreAudit.maxPending,
    });
  });

  it('Chrome優先の全件AIチェックは500ms単位でまとめる', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.localAiMode = 'auto';
    settings.lmStudio.zeroScoreAudit.checkAllUnmatched = true;

    expect(resolveLocalAiLoadPolicy(settings).batchWindowMs).toBe(
      CHROME_BUILT_IN_ALL_UNMATCHED_BATCH_WINDOW_MS,
    );
  });

  it('Chrome向け制限はユーザーのより厳しい値を緩めない', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.localAiMode = 'chrome-built-in';
    settings.lmStudio.zeroScoreAudit = {
      enabled: true,
      checkAllUnmatched: false,
      baseProbability: 0.005,
      maxPerMinute: 1,
      maxPending: 1,
    };

    expect(resolveLocalAiLoadPolicy(settings).zeroScoreAudit).toEqual({
      baseProbability: 0.005,
      maxPerMinute: 1,
      maxPending: 1,
    });
  });
});
