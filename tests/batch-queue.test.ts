import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClassificationBatchQueue } from '../lib/batch-queue';

afterEach(() => {
  vi.useRealTimers();
});

describe('ClassificationBatchQueue', () => {
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
