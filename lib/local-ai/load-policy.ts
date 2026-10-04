import type { SettingsV1 } from '../types';

export const CHROME_BUILT_IN_MAX_BATCH_SIZE = 8;
export const CHROME_BUILT_IN_BATCH_WINDOW_MS = 50;
export const CHROME_BUILT_IN_ALL_UNMATCHED_BATCH_WINDOW_MS = 500;
export const CHROME_BUILT_IN_MIN_REST_MS = 500;
export const LOCAL_AI_MAX_PENDING_BATCHES = 1;
export const LOCAL_AI_MAX_QUEUE_AGE_MS = 1_250;

const CHROME_BUILT_IN_AUDIT_BASE_PROBABILITY = 0.01;
const CHROME_BUILT_IN_AUDIT_MAX_PER_MINUTE = 3;
const CHROME_BUILT_IN_AUDIT_MAX_PENDING = 2;

export interface LocalAiLoadPolicy {
  batchWindowMs: number;
  maxBatchSize: number;
  maxPendingBatches: number;
  maxQueueAgeMs: number;
  flushOnFull: boolean;
  minRestMs: number;
  zeroScoreAudit: {
    baseProbability: number;
    maxPerMinute: number;
    maxPending: number;
  };
}

export function resolveLocalAiLoadPolicy(
  settings: SettingsV1,
): LocalAiLoadPolicy {
  const chromeBuiltInPrimary =
    settings.chromeBuiltIn.enabled &&
    (settings.localAiMode === 'auto' ||
      settings.localAiMode === 'chrome-built-in');
  const configuredAudit = settings.lmStudio.zeroScoreAudit;

  return {
    batchWindowMs: chromeBuiltInPrimary
      ? configuredAudit.checkAllUnmatched
        ? CHROME_BUILT_IN_ALL_UNMATCHED_BATCH_WINDOW_MS
        : CHROME_BUILT_IN_BATCH_WINDOW_MS
      : settings.lmStudio.batchWindowMs,
    maxBatchSize: chromeBuiltInPrimary
      ? CHROME_BUILT_IN_MAX_BATCH_SIZE
      : settings.lmStudio.batchSize,
    maxPendingBatches: LOCAL_AI_MAX_PENDING_BATCHES,
    maxQueueAgeMs: LOCAL_AI_MAX_QUEUE_AGE_MS,
    flushOnFull: !chromeBuiltInPrimary,
    minRestMs: chromeBuiltInPrimary ? CHROME_BUILT_IN_MIN_REST_MS : 0,
    zeroScoreAudit: chromeBuiltInPrimary
      ? {
          baseProbability: Math.min(
            configuredAudit.baseProbability,
            CHROME_BUILT_IN_AUDIT_BASE_PROBABILITY,
          ),
          maxPerMinute: Math.min(
            configuredAudit.maxPerMinute,
            CHROME_BUILT_IN_AUDIT_MAX_PER_MINUTE,
          ),
          maxPending: Math.min(
            configuredAudit.maxPending,
            CHROME_BUILT_IN_AUDIT_MAX_PENDING,
          ),
        }
      : {
          baseProbability: configuredAudit.baseProbability,
          maxPerMinute: configuredAudit.maxPerMinute,
          maxPending: configuredAudit.maxPending,
        },
  };
}
