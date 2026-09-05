import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChromeBuiltInAiProvider,
  MODEL_OPTIONS,
  getChromeBuiltInAvailability,
  prepareChromeBuiltInAi,
} from '../lib/local-ai/providers/chrome-built-in';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function createSessions(
  result = {
    results: [
      { id: 'one', category: 'backseat', action: 'blur', confidence: 0.9 },
    ],
  },
) {
  const batch = {
    prompt: vi.fn<(input: string, options?: object) => Promise<string>>(
      async () => JSON.stringify(result),
    ),
    clone: vi.fn(),
    destroy: vi.fn(),
  };
  const base = {
    prompt: vi.fn(),
    clone: vi.fn(async () => batch),
    destroy: vi.fn(),
  };
  return { base, batch };
}

describe('ChromeBuiltInAiProvider', () => {
  it('API不存在と各availabilityを安全に扱う', async () => {
    await expect(getChromeBuiltInAvailability()).resolves.toBe('unavailable');
    const availability = vi.fn(async () => 'downloadable');
    vi.stubGlobal('LanguageModel', { availability, create: vi.fn() });
    await expect(getChromeBuiltInAvailability()).resolves.toBe('downloadable');
    expect(availability).toHaveBeenCalledWith(MODEL_OPTIONS);
  });

  it('base sessionを再利用しbatchごとにcloneして必ず破棄する', async () => {
    const { base, batch } = createSessions();
    const create = vi.fn(async () => base);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create,
    });
    const provider = new ChromeBuiltInAiProvider();
    await expect(
      provider.classify([{ id: 'one', text: '進んだら？' }]),
    ).resolves.toEqual([
      { id: 'one', category: 'backseat', action: 'blur', confidence: 0.9 },
    ]);
    await provider.classify([{ id: 'one', text: '進んだら？' }]);
    expect(create).toHaveBeenCalledOnce();
    expect(base.clone).toHaveBeenCalledTimes(2);
    expect(batch.destroy).toHaveBeenCalledTimes(2);
    expect(batch.prompt.mock.calls[0]?.[1]).toMatchObject({
      omitResponseConstraintInput: true,
      responseConstraint: { type: 'object' },
    });
    provider.dispose();
    expect(base.destroy).toHaveBeenCalledOnce();
  });

  it('不正JSONと不足IDをruntime validationで拒否してsessionを破棄する', async () => {
    const { base, batch } = createSessions({ results: [] });
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => base),
    });
    await expect(
      new ChromeBuiltInAiProvider().classify([{ id: 'one', text: 'test' }]),
    ).rejects.toThrow('不足');
    expect(batch.destroy).toHaveBeenCalledOnce();
  });

  it('ユーザー操作用prepareだけがdownloadを開始し進捗後に破棄する', async () => {
    const setup = { clone: vi.fn(), prompt: vi.fn(), destroy: vi.fn() };
    const create = vi.fn(
      async (options: {
        monitor?: (monitor: {
          addEventListener: (
            type: 'downloadprogress',
            listener: (event: { loaded: number }) => void,
          ) => void;
        }) => void;
      }) => {
        options.monitor?.({
          addEventListener: (_type, listener) => listener({ loaded: 0.42 }),
        });
        return setup;
      },
    );
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'downloadable'),
      create,
    });
    const progress = vi.fn();
    await prepareChromeBuiltInAi(progress);
    expect(progress).toHaveBeenCalledWith(42);
    expect(progress).toHaveBeenLastCalledWith(100);
    expect(setup.destroy).toHaveBeenCalledOnce();
  });
});
