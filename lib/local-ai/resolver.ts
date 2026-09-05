import type { LmClassificationItem } from '../types';
import { ChromeBuiltInAiProvider } from './providers/chrome-built-in';
import { LmStudioProvider } from './providers/lm-studio';
import type {
  LocalAiAvailability,
  LocalAiClassification,
  LocalAiProvider,
  LocalAiProviderId,
  LocalAiResolverSettings,
} from './types';

const ERROR_LIMIT = 3;
const ERROR_COOLDOWN_MS = 30_000;

export class LocalAiResolver {
  private readonly failures = new Map<
    LocalAiProviderId,
    { count: number; cooldownUntil: number }
  >();

  constructor(
    private readonly settings: LocalAiResolverSettings,
    private readonly providers: Partial<
      Record<LocalAiProviderId, LocalAiProvider>
    > = {},
  ) {}

  async classify(
    items: LmClassificationItem[],
    options?: { signal?: AbortSignal },
  ): Promise<LocalAiClassification> {
    const errors: unknown[] = [];
    for (const provider of this.candidates()) {
      if (this.isCoolingDown(provider.id)) continue;
      try {
        if (
          provider.id === 'chrome-built-in' &&
          (await provider.getAvailability()) !== 'available'
        ) {
          continue;
        }
        const startedAt = performance.now();
        const results = [];
        for (
          let index = 0;
          index < items.length;
          index += provider.maxBatchSize
        ) {
          results.push(
            ...(await provider.classify(
              items.slice(index, index + provider.maxBatchSize),
              options,
            )),
          );
        }
        this.failures.delete(provider.id);
        return {
          providerId: provider.id,
          results,
          latencyMs: Math.max(0, performance.now() - startedAt),
        };
      } catch (error) {
        errors.push(error);
        this.recordFailure(provider.id);
      }
    }
    const details = errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .filter(Boolean)
      .slice(0, 2)
      .join(' / ');
    throw new Error(
      details
        ? `ローカルAI分類に失敗しました: ${details}`
        : '利用可能なローカルAIがありません。',
    );
  }

  async getStatus(): Promise<{
    availability: LocalAiAvailability;
    providerId?: LocalAiProviderId;
  }> {
    let pending: LocalAiAvailability | undefined;
    for (const provider of this.candidates()) {
      if (this.isCoolingDown(provider.id)) continue;
      const availability = await provider.getAvailability();
      if (availability === 'available') {
        return { availability, providerId: provider.id };
      }
      if (availability === 'downloadable' || availability === 'downloading') {
        pending ??= availability;
      }
    }
    return { availability: pending ?? 'unavailable' };
  }

  dispose(): void {
    for (const provider of this.candidates()) void provider.dispose?.();
  }

  private candidates(): LocalAiProvider[] {
    if (this.settings.mode === 'disabled') return [];
    const chrome = this.settings.chromeBuiltIn.enabled
      ? (this.providers['chrome-built-in'] ??= new ChromeBuiltInAiProvider(
          this.settings.lmStudio.timeoutMs,
        ))
      : undefined;
    const lm =
      this.settings.lmStudio.enabled && this.settings.lmStudio.model
        ? (this.providers['lm-studio'] ??= new LmStudioProvider(
            this.settings.lmStudio,
          ))
        : undefined;
    if (this.settings.mode === 'chrome-built-in') return chrome ? [chrome] : [];
    if (this.settings.mode === 'lm-studio') return lm ? [lm] : [];
    return [chrome, lm].filter((provider): provider is LocalAiProvider =>
      Boolean(provider),
    );
  }

  private isCoolingDown(id: LocalAiProviderId): boolean {
    return (this.failures.get(id)?.cooldownUntil ?? 0) > Date.now();
  }

  private recordFailure(id: LocalAiProviderId): void {
    const previous = this.failures.get(id);
    const count = (previous?.count ?? 0) + 1;
    this.failures.set(id, {
      count: count >= ERROR_LIMIT ? 0 : count,
      cooldownUntil: count >= ERROR_LIMIT ? Date.now() + ERROR_COOLDOWN_MS : 0,
    });
  }
}
