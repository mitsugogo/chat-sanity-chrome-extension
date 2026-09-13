import { describe, expect, it } from 'vitest';
import {
  CHROME_BUILT_IN_MAX_BATCH_SIZE,
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
        maxBatchSize: CHROME_BUILT_IN_MAX_BATCH_SIZE,
        maxPendingBatches: LOCAL_AI_MAX_PENDING_BATCHES,
        maxQueueAgeMs: LOCAL_AI_MAX_QUEUE_AGE_MS,
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
    const policy = resolveLocalAiLoadPolicy(settings);

    expect(policy.maxBatchSize).toBe(17);
    expect(policy.zeroScoreAudit).toEqual({
      baseProbability: settings.lmStudio.zeroScoreAudit.baseProbability,
      maxPerMinute: settings.lmStudio.zeroScoreAudit.maxPerMinute,
      maxPending: settings.lmStudio.zeroScoreAudit.maxPending,
    });
  });

  it('Chrome向け制限はユーザーのより厳しい値を緩めない', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.localAiMode = 'chrome-built-in';
    settings.lmStudio.zeroScoreAudit = {
      enabled: true,
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
