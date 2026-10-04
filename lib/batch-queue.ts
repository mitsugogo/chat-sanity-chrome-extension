import type {
  AiQueueSkipReason,
  LmClassificationItem,
  LmClassificationResult,
} from './types';

interface PendingItem {
  item: LmClassificationItem;
  enqueuedAt: number;
  resolve: (value: LmClassificationResult) => void;
  reject: (reason: unknown) => void;
}

export interface ClassificationBatchQueueOptions {
  windowMs?: number;
  maxBatchSize?: number;
  maxPendingBatches?: number;
  maxQueueAgeMs?: number;
  flushOnFull?: boolean;
  minRestMs?: number;
  now?: () => number;
}

const SKIP_MESSAGES: Record<AiQueueSkipReason, string> = {
  overloaded: 'AI待機列が混雑しているためルール判定を使用します。',
  expired: 'AI待機期限を超えたためルール判定を使用します。',
  disposed: 'AI設定が変更されたためルール判定を使用します。',
};

export class AiQueueFallbackError extends Error {
  override readonly name = 'AiQueueFallbackError';

  constructor(readonly reason: AiQueueSkipReason) {
    super(SKIP_MESSAGES[reason]);
  }
}

export class ClassificationBatchQueue {
  private queue: PendingItem[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private disposed = false;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly maxPendingItems: number;
  private readonly maxQueueAgeMs: number;
  private readonly flushOnFull: boolean;
  private readonly minRestMs: number;
  private nextAllowedAt = 0;
  private readonly now: () => number;

  constructor(
    private readonly classify: (
      items: LmClassificationItem[],
    ) => Promise<LmClassificationResult[]>,
    options: ClassificationBatchQueueOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 200;
    this.maxBatchSize = options.maxBatchSize ?? 20;
    this.maxPendingItems = this.maxBatchSize * (options.maxPendingBatches ?? 1);
    this.maxQueueAgeMs = options.maxQueueAgeMs ?? 1_250;
    this.flushOnFull = options.flushOnFull ?? true;
    this.minRestMs = options.minRestMs ?? 0;
    this.now = options.now ?? Date.now;
  }

  enqueue(item: LmClassificationItem): Promise<LmClassificationResult> {
    if (this.disposed) {
      return Promise.reject(new AiQueueFallbackError('disposed'));
    }
    if (this.queue.length >= this.maxPendingItems) {
      this.queue.shift()?.reject(new AiQueueFallbackError('overloaded'));
    }
    const promise = new Promise<LmClassificationResult>((resolve, reject) => {
      this.queue.push({ item, enqueuedAt: this.now(), resolve, reject });
    });
    if (this.running) return promise;
    if (this.flushOnFull && this.queue.length >= this.maxBatchSize) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.scheduleNext();
    } else if (!this.timer) this.scheduleNext();
    return promise;
  }

  async flush(): Promise<void> {
    if (this.running || this.disposed) return;
    const restMs = this.nextAllowedAt - this.now();
    if (restMs > 0) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.flush(), restMs);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const candidates = this.queue.splice(0, this.maxBatchSize);
    const now = this.now();
    const batch = candidates.filter((pending) => {
      if (now - pending.enqueuedAt <= this.maxQueueAgeMs) return true;
      pending.reject(new AiQueueFallbackError('expired'));
      return false;
    });
    if (batch.length === 0) {
      this.scheduleNext();
      return;
    }
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
    } finally {
      this.nextAllowedAt = this.now() + this.minRestMs;
      this.running = false;
      this.scheduleNext();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const pending of this.queue.splice(0)) {
      pending.reject(new AiQueueFallbackError('disposed'));
    }
  }

  private scheduleNext(): void {
    if (this.disposed || this.running || this.queue.length === 0) return;
    const full = this.flushOnFull && this.queue.length >= this.maxBatchSize;
    const restMs = Math.max(0, this.nextAllowedAt - this.now());
    if (full && restMs === 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(full ? 0 : this.windowMs, restMs),
    );
  }
}
