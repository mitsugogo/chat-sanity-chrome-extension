import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiQueueFallbackError,
  ClassificationBatchQueue,
} from '../lib/batch-queue';
import type {
  LmClassificationItem,
  LmClassificationResult,
} from '../lib/types';

afterEach(() => {
  vi.useRealTimers();
});

function results(items: LmClassificationItem[]): LmClassificationResult[] {
  return items.map((item) => ({
    id: item.id,
    category: 'safe',
    score: 0,
  }));
}

describe('ClassificationBatchQueue', () => {
  it('指定時間内の8件以下を1回のバッチへまとめる', async () => {
    vi.useFakeTimers();
    const classify = vi.fn(async (items: LmClassificationItem[]) =>
      results(items),
    );
    const queue = new ClassificationBatchQueue(classify, {
      windowMs: 200,
      maxBatchSize: 8,
    });
    const pending = Array.from({ length: 7 }, (_, index) =>
      queue.enqueue({ id: String(index), text: 'a' }),
    );
    await vi.advanceTimersByTimeAsync(200);

    await expect(Promise.all(pending)).resolves.toHaveLength(7);
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0]).toHaveLength(7);
  });

  it('実行中に待機バッチが満杯なら最古をfallbackして最新を残す', async () => {
    let finishFirst: (value: LmClassificationResult[]) => void = () =>
      undefined;
    const classify = vi.fn((items: LmClassificationItem[]) =>
      classify.mock.calls.length === 1
        ? new Promise<LmClassificationResult[]>((resolve) => {
            finishFirst = resolve;
          })
        : Promise.resolve(results(items)),
    );
    const queue = new ClassificationBatchQueue(classify, {
      windowMs: 200,
      maxBatchSize: 2,
      maxPendingBatches: 1,
    });

    const running = [
      queue.enqueue({ id: '1', text: 'a' }),
      queue.enqueue({ id: '2', text: 'b' }),
    ];
    const oldest = queue.enqueue({ id: '3', text: 'c' });
    const pending = queue.enqueue({ id: '4', text: 'd' });
    const latest = queue.enqueue({ id: '5', text: 'e' });

    await expect(oldest).rejects.toMatchObject({
      name: 'AiQueueFallbackError',
      reason: 'overloaded',
    });
    finishFirst(results(classify.mock.calls[0]?.[0] ?? []));

    await expect(
      Promise.all([...running, pending, latest]),
    ).resolves.toHaveLength(4);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0].map((item) => item.id)).toEqual([
      '4',
      '5',
    ]);
  });

  it('期限切れだけを除外して有効な項目を分類する', async () => {
    let now = 0;
    const classify = vi.fn(async (items: LmClassificationItem[]) =>
      results(items),
    );
    const queue = new ClassificationBatchQueue(classify, {
      windowMs: 10_000,
      maxBatchSize: 4,
      maxQueueAgeMs: 1_250,
      now: () => now,
    });
    const expired = queue
      .enqueue({ id: 'old', text: 'a' })
      .catch((error: unknown) => error);
    now = 1_000;
    const valid = queue.enqueue({ id: 'new', text: 'b' });
    now = 1_300;

    await queue.flush();

    await expect(expired).resolves.toMatchObject({
      name: 'AiQueueFallbackError',
      reason: 'expired',
    });
    await expect(valid).resolves.toMatchObject({ id: 'new' });
    expect(classify).toHaveBeenCalledOnce();
    expect(classify.mock.calls[0]?.[0].map((item) => item.id)).toEqual(['new']);
  });

  it('分類結果にIDがなければ対象だけをrejectする', async () => {
    const classify = vi.fn(async () => []);
    const queue = new ClassificationBatchQueue(classify, {
      windowMs: 10_000,
      maxBatchSize: 1,
    });
    await expect(queue.enqueue({ id: 'missing', text: 'a' })).rejects.toThrow(
      '分類結果が見つかりません',
    );
  });

  it('破棄後は待機項目と新規項目をdisposedとしてfallbackする', async () => {
    vi.useFakeTimers();
    const classify = vi.fn(async (items: LmClassificationItem[]) =>
      results(items),
    );
    const queue = new ClassificationBatchQueue(classify);
    const waiting = queue
      .enqueue({ id: '1', text: 'a' })
      .catch((error: unknown) => error);
    queue.dispose();

    await expect(waiting).resolves.toBeInstanceOf(AiQueueFallbackError);
    await expect(queue.enqueue({ id: '2', text: 'b' })).rejects.toMatchObject({
      reason: 'disposed',
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(classify).not.toHaveBeenCalled();
  });
});
