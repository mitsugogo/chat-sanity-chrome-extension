import { describe, expect, it, vi } from 'vitest';
import { LocalAiResolver } from '../lib/local-ai/resolver';
import type {
  LocalAiAvailability,
  LocalAiProvider,
  LocalAiProviderId,
  LocalAiResolverSettings,
} from '../lib/local-ai/types';

const items = Array.from({ length: 10 }, (_, index) => ({
  id: String(index),
  text: `message-${index}`,
}));

function settings(mode: LocalAiResolverSettings['mode'] = 'auto') {
  return {
    mode,
    chromeBuiltIn: { enabled: true },
    lmStudio: {
      enabled: true,
      endpoint: 'http://127.0.0.1:1234',
      model: 'local',
      timeoutMs: 1000,
      responseFormat: 'json_schema' as const,
    },
  };
}

function provider(
  id: LocalAiProviderId,
  availability: LocalAiAvailability,
  maxBatchSize = 20,
): LocalAiProvider & { classify: ReturnType<typeof vi.fn> } {
  return {
    id,
    maxBatchSize,
    getAvailability: vi.fn(async () => availability),
    classify: vi.fn(async (batch: typeof items) =>
      batch.map((item) => ({
        id: item.id,
        category: 'safe' as const,
        score: 0,
      })),
    ),
    dispose: vi.fn(),
  };
}

describe('LocalAiResolver', () => {
  it('autoはChromeを優先しprovider上限ごとに逐次分割する', async () => {
    const chrome = provider('chrome-built-in', 'available', 4);
    const lm = provider('lm-studio', 'available');
    const result = await new LocalAiResolver(settings(), {
      'chrome-built-in': chrome,
      'lm-studio': lm,
    }).classify(items);
    expect(result.providerId).toBe('chrome-built-in');
    expect(chrome.classify).toHaveBeenCalledTimes(3);
    expect(lm.classify).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(10);
  });

  it.each(['downloadable', 'downloading', 'unavailable'] as const)(
    'Chromeが%sならLM Studioへfallbackする',
    async (availability) => {
      const chrome = provider('chrome-built-in', availability);
      const lm = provider('lm-studio', 'available');
      const result = await new LocalAiResolver(settings(), {
        'chrome-built-in': chrome,
        'lm-studio': lm,
      }).classify(items.slice(0, 1));
      expect(result.providerId).toBe('lm-studio');
      expect(chrome.classify).not.toHaveBeenCalled();
    },
  );

  it('Chrome分類失敗時もLM Studioへfallbackする', async () => {
    const chrome = provider('chrome-built-in', 'available');
    chrome.classify.mockRejectedValue(
      new DOMException('quota', 'QuotaExceededError'),
    );
    const lm = provider('lm-studio', 'available');
    const result = await new LocalAiResolver(settings(), {
      'chrome-built-in': chrome,
      'lm-studio': lm,
    }).classify(items.slice(0, 1));
    expect(result.providerId).toBe('lm-studio');
  });

  it('3回連続失敗したProviderを30秒cooldownする', async () => {
    const chrome = provider('chrome-built-in', 'available');
    chrome.classify.mockRejectedValue(new Error('failed'));
    const lm = provider('lm-studio', 'available');
    const resolver = new LocalAiResolver(settings(), {
      'chrome-built-in': chrome,
      'lm-studio': lm,
    });
    for (let index = 0; index < 4; index += 1) {
      await resolver.classify(items.slice(0, 1));
    }
    expect(chrome.classify).toHaveBeenCalledTimes(3);
    expect(lm.classify).toHaveBeenCalledTimes(4);
  });

  it('disabledはProviderを呼ばずfail-open用の失敗を返す', async () => {
    const chrome = provider('chrome-built-in', 'available');
    await expect(
      new LocalAiResolver(settings('disabled'), {
        'chrome-built-in': chrome,
      }).classify(items.slice(0, 1)),
    ).rejects.toThrow('利用可能なローカルAIがありません');
    expect(chrome.classify).not.toHaveBeenCalled();
  });
});
