import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../lib/settings';
describe('AI settings migration', () => {
  it('既存のschemaVersion 1に推論待ち時間と互換形式を補完する', () => {
    const settings = normalizeSettings({
      schemaVersion: 1,
      lmStudio: { enabled: true, model: 'local', timeoutMs: 500 },
    });
    expect(settings.lmStudio).toMatchObject({
      enabled: true,
      model: 'local',
      timeoutMs: 500,
      requestTimeoutMs: 10000,
      responseFormat: 'json_schema',
      sessionLearning: true,
    });
    expect(settings.debugMode).toBe(false);
  });
  it('バッチと曖昧域と時間を契約内へ制限する', () => {
    expect(
      normalizeSettings({
        schemaVersion: 1,
        lmStudio: {
          batchSize: 99,
          uncertainMin: 0,
          uncertainMax: 1,
          timeoutMs: 10000,
          batchWindowMs: 900,
          requestTimeoutMs: Infinity,
          responseFormat: 'invalid',
        },
      }).lmStudio,
    ).toMatchObject({
      batchSize: 20,
      uncertainMin: 0.35,
      uncertainMax: 0.8,
      timeoutMs: 500,
      batchWindowMs: 200,
      requestTimeoutMs: 10000,
      responseFormat: 'json_schema',
    });
    expect(
      normalizeSettings({
        schemaVersion: 1,
        lmStudio: {
          uncertainMin: 0.7,
          uncertainMax: 0.4,
          requestTimeoutMs: 999999,
          batchSize: 0,
        },
      }).lmStudio,
    ).toMatchObject({
      uncertainMin: 0.7,
      uncertainMax: 0.7,
      requestTimeoutMs: 60000,
      batchSize: 1,
    });
  });

  it('壊れたプリセット値を既定値へ戻し閾値の順序を保つ', () => {
    const settings = normalizeSettings({
      schemaVersion: 1,
      enabled: 'yes',
      activePreset: 'unknown',
      profiles: {
        event: {
          categories: {
            backseat: { enabled: 'yes', weight: 4, mode: 'invalid' },
          },
          thresholds: { dim: 0.9, blur: 0.1, hide: 0 },
          hideSpam: 'no',
        },
      },
    });
    expect(settings.enabled).toBe(true);
    expect(settings.activePreset).toBe('event');
    expect(settings.profiles.event.categories.backseat).toEqual({
      enabled: true,
      weight: 1,
      mode: 'threshold',
    });
    expect(settings.profiles.event.thresholds).toEqual({
      dim: 0.9,
      blur: 0.9,
      hide: 0.9,
    });
    expect(settings.profiles.event.hideSpam).toBe(true);
  });
});
