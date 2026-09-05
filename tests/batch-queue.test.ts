import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassificationBatchQueue } from '../lib/batch-queue';

afterEach(() => {
  vi.useRealTimers();
});

describe('ClassificationBatchQueue', () => {
  it('推論中は同時送信せず、上限超過はルールへ戻す', async () => {
    vi.useFakeTimers();
    let finish: (value: []) => void = () => undefined;
    const classify = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new ClassificationBatchQueue(classify, 200, 1);
    const pending = [queue.enqueue({ id: '0', text: 'a' }).catch(() => null)];
    for (let i = 1; i <= 100; i++)
      pending.push(
        queue.enqueue({ id: String(i), text: 'b' }).catch(() => null),
      );
    await expect(queue.enqueue({ id: 'overflow', text: 'c' })).rejects.toThrow(
      '上限',
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(classify).toHaveBeenCalledOnce();
    queue.dispose();
    finish([]);
    await Promise.all(pending);
    await vi.advanceTimersByTimeAsync(1000);
    expect(classify).toHaveBeenCalledOnce();
    await expect(queue.enqueue({ id: 'new', text: 'd' })).rejects.toThrow();
  });

  it('待機タイマーを破棄したら送信しない', async () => {
    vi.useFakeTimers();
    const classify = vi.fn(async () => []);
    const queue = new ClassificationBatchQueue(classify);
    const result = queue.enqueue({ id: '1', text: 'a' }).catch(() => null);
    queue.dispose();
    await result;
    await vi.advanceTimersByTimeAsync(200);
    expect(classify).not.toHaveBeenCalled();
  });
  it('指定時間内の項目を1回のバッチへまとめる', async () => {
    vi.useFakeTimers();
    const classify = vi.fn(async (items: Array<{ id: string; text: string }>) =>
      items.map((item) => ({
        id: item.id,
        category: 'safe' as const,
        score: 0.1,
      })),
    );
    const queue = new ClassificationBatchQueue(classify, 200, 20);
    const first = queue.enqueue({ id: '1', text: 'a' });
    const second = queue.enqueue({ id: '2', text: 'b' });
    await vi.advanceTimersByTimeAsync(200);

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('上限に達した時点で即時送信する', async () => {
    const classify = vi.fn(async (items: Array<{ id: string; text: string }>) =>
      items.map((item) => ({
        id: item.id,
        category: 'safe' as const,
        score: 0,
      })),
    );
    const queue = new ClassificationBatchQueue(classify, 10_000, 2);
    await Promise.all([
      queue.enqueue({ id: '1', text: 'a' }),
      queue.enqueue({ id: '2', text: 'b' }),
    ]);
    expect(classify).toHaveBeenCalledOnce();
  });
});
