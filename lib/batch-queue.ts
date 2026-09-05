import type { LmClassificationItem, LmClassificationResult } from './types';

interface PendingItem {
  item: LmClassificationItem;
  resolve: (value: LmClassificationResult) => void;
  reject: (reason: unknown) => void;
}

export class ClassificationBatchQueue {
  private queue: PendingItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;

  constructor(
    private readonly classify: (
      items: LmClassificationItem[],
    ) => Promise<LmClassificationResult[]>,
    private readonly windowMs = 200,
    private readonly maxSize = 20,
  ) {}

  enqueue(item: LmClassificationItem): Promise<LmClassificationResult> {
    if (this.disposed || this.queue.length >= 100) {
      return Promise.reject(
        new Error('AI待機上限または設定変更のためルール判定を使用します。'),
      );
    }
    const promise = new Promise<LmClassificationResult>((resolve, reject) => {
      this.queue.push({ item, resolve, reject });
    });
    if (this.running) return promise;
    if (this.queue.length >= this.maxSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.windowMs);
    }
    return promise;
  }

  async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue.splice(0, this.maxSize);
    if (batch.length === 0) return;
    this.running = true;

    try {
      const results = await this.classify(batch.map(({ item }) => item));
      const byId = new Map(results.map((result) => [result.id, result]));
      for (const pending of batch) {
        const result = byId.get(pending.item.id);
        if (result) pending.resolve(result);
        else pending.reject(new Error('分類結果が見つかりません。'));
      }
    } catch (error) {
      for (const pending of batch) pending.reject(error);
    }

    this.running = false;
    if (!this.disposed && this.queue.length > 0) {
      this.timer = setTimeout(() => void this.flush(), this.windowMs);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const pending of this.queue.splice(0)) {
      pending.reject(new Error('AI設定が変更されました。'));
    }
  }
}
