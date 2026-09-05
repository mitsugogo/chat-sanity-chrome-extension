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
    expect(base.clone.mock.calls.every((call) => call.length === 0)).toBe(true);
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

  it('timeoutのAbortErrorをタイムアウトとして扱う', async () => {
    const { base, batch } = createSessions();
    batch.prompt.mockImplementation(
      (_input: string, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          const abort = () =>
            reject(
              new DOMException(
                'signal is aborted without reason',
                'AbortError',
              ),
            );
          if (options?.signal?.aborted) abort();
          else
            options?.signal?.addEventListener('abort', abort, { once: true });
        }),
    );
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => base),
    });
    await expect(
      new ChromeBuiltInAiProvider(30).classify([{ id: 'one', text: 'test' }]),
    ).rejects.toThrow('タイムアウト');
    expect(base.clone.mock.calls[0]?.length ?? 0).toBe(0);
    expect(batch.destroy).toHaveBeenCalledOnce();
  });

  it('AbortErrorならsessionを作り直して1回再試行する', async () => {
    const first = createSessions();
    const second = createSessions();
    first.base.clone.mockRejectedValueOnce(
      new DOMException('signal is aborted without reason', 'AbortError'),
    );
    const create = vi
      .fn()
      .mockResolvedValueOnce(first.base)
      .mockResolvedValueOnce(second.base);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create,
    });
    await expect(
      new ChromeBuiltInAiProvider().classify([
        { id: 'one', text: '進んだら？' },
      ]),
    ).resolves.toEqual([
      { id: 'one', category: 'backseat', action: 'blur', confidence: 0.9 },
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(first.base.destroy).toHaveBeenCalledOnce();
    expect(second.batch.prompt).toHaveBeenCalledOnce();
    expect(second.batch.destroy).toHaveBeenCalledOnce();
  });

  it('再試行後も中断されたら日本語エラーにする', async () => {
    const { base } = createSessions();
    base.clone.mockRejectedValue(
      new DOMException('signal is aborted without reason', 'AbortError'),
    );
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => base),
    });
    await expect(
      new ChromeBuiltInAiProvider().classify([{ id: 'one', text: 'test' }]),
    ).rejects.toThrow('中断');
  });

  it('同時分類を直列化しpromptを重ねない', async () => {
    const { base, batch } = createSessions();
    let inFlight = 0;
    let maxInFlight = 0;
    batch.prompt.mockImplementation(async (input: string) => {
      const parsed = JSON.parse(input) as {
        messages: Array<{ id: string }>;
      };
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return JSON.stringify({
        results: parsed.messages.map((item) => ({
          id: item.id,
          category: 'safe',
          action: 'allow',
          confidence: 1,
        })),
      });
    });
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => base),
    });
    const provider = new ChromeBuiltInAiProvider();
    await Promise.all([
      provider.classify([{ id: 'one', text: '進んだら？' }]),
      provider.classify([{ id: 'two', text: 'まだ？' }]),
    ]);
    expect(maxInFlight).toBe(1);
    expect(batch.destroy).toHaveBeenCalledTimes(2);
  });
});
